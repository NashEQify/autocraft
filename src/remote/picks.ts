// Picks ("Run on my Task Runner" in the model call queue): a maintainer or operator reserves a queued call for their own Task
// Runners. Their runners take their picks before the queue's order; other users' runners pass a call over while its pick
// counts (calls.ts claimOrder, leaseCall). A pick counts until its time is up (setting remote_pick_minutes, 0: no time
// limit), while one of the picker's runners is fresh and the picker is neither cooling off nor at their Max calls at once
// (calls.ts pickerSql); it ends with a lease, a requeue, an unpick, or at a claim that finds
// the call released by or no longer open to the picker. Registered as a wait in src/stages/registry.ts.
import type { ItemRef } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { authorsOf, clearPick, dropQueueCache, pickerLogins, judges, pickCounts, pickLapsedArgs, pickLapsedSql, roleFits } from "./calls.ts";
import { cooloffOf } from "./cooloff.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, inferenceMode, isTier } from "./mode.ts";
import type { Tier } from "./protocol.ts";
import { CALLER_STALE_MS } from "./room.ts";
import { scaled } from "./time-scale.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

/** Setting: minutes a pick counts; 0 means until it ends otherwise. */
export const PICK_MINUTES_KEY = "remote_pick_minutes";
export const PICK_MINUTES_DEFAULT = 15;
const PICK_MINUTES_MAX = 24 * 60;
/** The most live picks a user holds, whatever their runners' slots. */
export const PICKS_MAX = 8;

export async function pickMinutes(db: Db): Promise<number> {
  const v = await setting(db, PICK_MINUTES_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= PICK_MINUTES_MAX ? n : PICK_MINUTES_DEFAULT;
}

export async function setPickMinutes(db: Db, input: unknown, by: string): Promise<number> {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > PICK_MINUTES_MAX) throw new Error(`the minutes a pick counts must be a whole number from 0 (no limit) to ${PICK_MINUTES_MAX}`);
  const was = await pickMinutes(db);
  await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(PICK_MINUTES_KEY, String(n));
  if (n !== was) await audit(db, by, "remote-pick-minutes", "pipeline", { minutes: n, was });
  return n;
}

/** How long a new pick counts, in ms (scaled like the mode's other windows); null for no limit. */
export async function pickCapMs(db: Db): Promise<number | null> {
  const m = await pickMinutes(db);
  return m === 0 ? null : scaled(m * 60_000);
}

export type Picker = { login: string; role: Role; canWrite: (repo: string) => Promise<boolean> };

/** What the user may pick: `canPick` with the tiers their fresh runners cover, their live picks and the most they may hold. */
export type PickerState = { canPick: boolean; why: string | null; tiers: ReadonlySet<Tier>; picks: number; pickMax: number };

/** The user's fresh Task Runners together: the tiers their models cover (accepted families) and their slots without the fast lane. */
async function freshRunnersOf(db: Db, login: string, nowMs: number): Promise<{ tiers: Set<Tier>; slots: number; count: number }> {
  const rows = await db.prepare(`SELECT h.models, COALESCE(h.slots, 1) AS slots FROM main.remote_helpers h JOIN main.mcp_tokens t ON t.id = h.token_id
    WHERE h.login = ? AND t.kind = 'runner' AND t.expires_at > ? AND h.reported_at >= ?`).all(login, new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as { models: string; slots: number }[];
  const accepted = await acceptedModels(db);
  const tiers = new Set<Tier>();
  let slots = 0;
  for (const r of rows) {
    // A runner reporting 2 or more slots runs one of them as its fast lane (room.ts).
    slots += Number(r.slots) - (Number(r.slots) >= 2 ? 1 : 0);
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(r.models) as Record<string, unknown>; } catch { /* no models */ }
    for (const [t, m] of Object.entries(models)) if (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null) tiers.add(t);
  }
  return { tiers, slots, count: rows.length };
}

/** The user's live picks: a picker's own picks count while their time is not up (canPick needs a fresh runner). */
const livePicks = async (db: Db, login: string, nowMs: number, except = -1): Promise<number> =>
  Number((await db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'queued' AND picked_by = ? AND (pick_until IS NULL OR pick_until >= ?) AND id <> ?").get(login, nowMs, except) as { n: number }).n);

export async function pickerState(db: Db, user: Pick<Picker, "login" | "role">, nowMs: number): Promise<PickerState> {
  const none = (why: string): PickerState => ({ canPick: false, why, tiers: new Set(), picks: 0, pickMax: 0 });
  if (user.role !== "maintainer" && user.role !== "operator") return none("only maintainers and operators pick calls");
  if (await inferenceMode(db) !== "user-local") return none("model calls run on the server's accounts");
  const runners = await freshRunnersOf(db, user.login, nowMs);
  const picks = await livePicks(db, user.login, nowMs);
  const pickMax = Math.min(PICKS_MAX, runners.slots);
  if (!runners.count || !runners.tiers.size) return { ...none("none of your Task Runners is running"), picks };
  const cooled = await cooloffOf(db, user.login, nowMs);
  if (cooled) return { ...none(`your Task Runners are cooled off: ${cooled.reason}`), picks, pickMax };
  return { canPick: pickMax > 0, why: pickMax > 0 ? null : "your Task Runners have no free slots", tiers: runners.tiers, picks, pickMax };
}

/** A queued call as picks read it. */
export type PickCall = { id: number; tier: Tier; promptId: string; parentId: number | null; repos: string[]; authors: ReadonlySet<string>; seenAt: number; pickedBy: string | null; pickUntil: number | null };

/**
 * Why the user may not pick the call now, or null: only a queued call with a live caller, not a follow-up, not a judging
 * call on the user's own item, not under another user's live pick, of a tier the user's runners cover, that the role rules
 * give the user and on whose every repo the user may write; and only below the user's most picks. `fresh`: whether a login's
 * picks count (pickerLogins).
 */
export async function pickRefusal(state: PickerState, user: Picker, c: PickCall, nowMs: number, fresh: (login: string) => Promise<boolean>): Promise<string | null> {
  if (!state.canPick) return state.why;
  const login = user.login.toLowerCase();
  if (c.pickedBy === login && await pickCounts(c, nowMs, fresh)) return "you picked it already";
  if (c.pickedBy !== null && await pickCounts(c, nowMs, fresh)) return "another user picked it";
  if (c.parentId !== null) return "a follow-up goes to the Task Runner that holds its session";
  if (c.seenAt < nowMs - CALLER_STALE_MS) return "its caller stopped waiting";
  if (!state.tiers.has(c.tier)) return `none of your Task Runners runs the ${c.tier} tier`;
  if (!roleFits(user.role, { prompt_id: c.promptId, repos: c.repos })) return "only operators take this call";
  if (judges(c.promptId) && c.authors.has(login)) return "it judges an item you authored";
  for (const repo of c.repos) if (!(await user.canWrite(repo).catch(() => false))) return `you have no write permission on ${repo}`;
  if (state.picks >= state.pickMax) return `you hold ${state.picks} picks, your most`;
  return null;
}

type CallRow = { id: number; state: string; tier: Tier; prompt_id: string; parent_id: number | null; items: string; repo: string | null; authors: string | null; seen_at: number; picked_by: string | null; pick_until: number | null };

async function readCall(db: Db, id: number): Promise<(PickCall & { state: string; refs: ItemRef[] }) | null> {
  const r = await db.prepare("SELECT id, state, tier, prompt_id, parent_id, items, repo, authors, seen_at, picked_by, pick_until FROM main.remote_calls WHERE id = ?").get(id) as CallRow | undefined;
  if (!r) return null;
  const refs = JSON.parse(r.items) as ItemRef[];
  const authors = r.authors !== null ? JSON.parse(r.authors) as string[] : judges(r.prompt_id) ? await authorsOf(db, refs) : [];
  return {
    id: Number(r.id), state: r.state, tier: r.tier, promptId: r.prompt_id, parentId: r.parent_id, refs, repos: [...new Set([...refs.map((i) => i.repo), ...(r.repo ? [r.repo] : [])])],
    authors: new Set(authors.map((a) => a.toLowerCase())), seenAt: Number(r.seen_at), pickedBy: r.picked_by?.toLowerCase() ?? null, pickUntil: r.pick_until,
  };
}

const targetOf = (refs: ItemRef[]): string | null => (refs.length ? `${refs[0]!.repo}#${refs[0]!.number}` : null);

/** Picks a queued call for the user's runners (compare and set: only a call no other user's pick counts for); audited. */
export async function pickCall(db: Db, user: Picker, id: number, nowMs: number = Date.now(), via?: string): Promise<void> {
  const c = await readCall(db, id);
  if (!c) throw new HttpError(404, "no such model call");
  if (c.state !== "queued") throw new HttpError(409, "the call is no longer queued");
  const state = await pickerState(db, user, nowMs);
  if (user.role !== "maintainer" && user.role !== "operator") throw new HttpError(403, state.why ?? "only maintainers and operators pick calls");
  const fresh = await pickerLogins(db, nowMs);
  const why = await pickRefusal(state, user, c, nowMs, async (l) => fresh.has(l));
  if (why) throw new HttpError(409, why);
  const cap = await pickCapMs(db);
  db.exec("BEGIN IMMEDIATE");
  let changed: number;
  try {
    // Parallel picks of one user cannot pass the most picks together.
    if (await livePicks(db, user.login, nowMs, id) >= state.pickMax) {
      db.exec("ROLLBACK");
      throw new HttpError(409, `you hold ${state.pickMax} picks, your most`);
    }
    changed = Number((await db.prepare(`UPDATE main.remote_calls SET picked_by = ?, picked_at = ?, pick_until = ?
      WHERE id = ? AND state = 'queued' AND parent_id IS NULL AND (picked_by IS NULL OR picked_by = ? OR ${pickLapsedSql})`)
      .run(user.login, nowMs, cap === null ? null : nowMs + cap, id, user.login, ...pickLapsedArgs(nowMs))).changes);
    db.exec("COMMIT");
  } catch (e) {
    if (db.inTransaction()) db.exec("ROLLBACK");
    throw e;
  }
  if (changed !== 1) throw new HttpError(409, "another user picked it, or it is no longer queued");
  dropQueueCache(db);
  await audit(db, user.login, "remote-pick", targetOf(c.refs), { id, promptId: c.promptId, ...(cap !== null && { until: new Date(nowMs + cap).toISOString() }), ...(via && { via }) });
}

/** Ends a pick: the user's own, or any for an operator; audited. */
export async function unpickCall(db: Db, user: Pick<Picker, "login" | "role">, id: number, via?: string): Promise<void> {
  if (user.role !== "maintainer" && user.role !== "operator") throw new HttpError(403, "only maintainers and operators pick calls");
  const c = await readCall(db, id);
  if (!c) throw new HttpError(404, "no such model call");
  if (c.pickedBy === null) throw new HttpError(409, "the call has no pick");
  const own = c.pickedBy === user.login.toLowerCase();
  if (!own && user.role !== "operator") throw new HttpError(403, "only operators end another user's pick");
  if (!await clearPick(db, id, c.pickedBy)) throw new HttpError(409, "the call has no pick");
  await audit(db, user.login, "remote-unpick", targetOf(c.refs), { id, promptId: c.promptId, ...(!own && { picker: c.pickedBy }), ...(via && { via }) });
}

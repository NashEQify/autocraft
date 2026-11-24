// Calls for work a person started or approved in the maintainer workflow (src/workflow): every item a queued call names has a
// live workflow in a repo on that workflow whose starter or approver is the person, or is the PR of an issue whose live
// implement workflow they started or approved (a current attempt). Their own Task Runners take such a call first, ahead of
// automatic work, in a slot that counts toward their Max calls at once, and not held back by their cool-off. While one of
// their runners is fresh, ready and not cooling off, offers the call's tier and may take it (role rules, write permission, a
// token whose model did not decline it), other users' runners pass the call over, for at most STARTED_HOLD_MS from its
// queueing (calls.ts claimOrder, takers.ts sweepTakers). Then, or when no owner can take it, any runner takes it under all
// its own limits. Registered as a wait in src/stages/registry.ts.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { inList } from "../db/kx.ts";
import { LIVE_STATES } from "../workflow/store.ts";
import type { Entry } from "../workflow/types.ts";
import { judges, roleFits } from "./calls.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, isTier } from "./mode.ts";
import { taskOfStep } from "./my-tasks.ts";
import type { Tier } from "./protocol.ts";
import { scaled } from "./time-scale.ts";

/** How long other users' runners pass a started call over for its owner, from its queueing. */
export const STARTED_HOLD_MS = scaled(10 * 60_000);
/** How long claims reuse one reading (calls.ts QUEUE_CACHE_MS). */
const CACHE_MS = 2_000;

/** The attempts that are not current, as the implementations_current index leaves them out. */
export const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];

/** The My tasks ids (my-tasks.ts) of the steps a live workflow of each entry runs. */
const ENTRY_TASKS: Record<Entry, ReadonlySet<string>> = {
  review: new Set(["review", "fixup", "verify", "merge"]),
  fixup: new Set(["fixup", "review", "verify", "merge"]),
  implement: new Set(["fix", "review", "fixup", "verify", "merge"]),
  merge: new Set(["merge"]),
};
/** Workflow states in which AutoCraft runs steps; in the others the workflow waits for a person. */
const WORKING = new Set(["running", "waiting"]);

export type StartedCalls = {
  /** The lowercase logins whose call one with these items is: those that started or approved work on every one of them. */
  owners: (refs: readonly ItemRef[]) => ReadonlySet<string>;
  /** The tiers the lowercase login's fresh, ready Task Runners offer while the login is not cooling off (empty: none). */
  tiersOf: (login: string) => ReadonlySet<Tier>;
  /** Whether one of the login's such runners, of a credential other than `refusedToken`, may take a call on `repos` of `prompt_id`. */
  canTake: (login: string, c: { prompt_id: string; repos: readonly string[]; tier?: Tier; refusedToken?: number | null }) => boolean;
  /** The lowercase logins with such a runner. */
  runnerLogins: readonly string[];
  /**
   * The lowercase logins whose started work a call or job is: with `refs`, owners(refs); without (a job asked about before its
   * items are known), the logins with such a runner that have, in every one of `repos`, a live workflow AutoCraft is working
   * on (running or waiting) whose steps include `step`'s task. No step: none.
   */
  ownersFor: (c: { repos: readonly string[]; refs?: readonly ItemRef[]; step?: string }) => ReadonlySet<string>;
};

const NONE: ReadonlySet<never> = new Set();

/** Reads the live workflows' starters and approvers and the runners that may take their calls. */
export async function readStartedCalls(db: Db, nowMs: number): Promise<StartedCalls> {
  const [live, prs, runners, accepted] = await Promise.all([
    db.all(db.k.selectFrom("main.item_workflows as w").innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["w.repo", "w.number", "w.entry", "w.state", "w.started_by", "w.approved_by"]).where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    db.all(db.k.selectFrom("main.implementations as i").innerJoin("main.item_workflows as w", (j) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number"))
      .innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["i.repo", "i.pr_number", "w.started_by", "w.approved_by"]).where("i.pr_number", "is not", null).where("i.state", "not in", ENDED_ATTEMPTS).where("w.entry", "=", "implement")
      .where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    db.all(db.k.selectFrom("main.remote_helpers as h").innerJoin("main.mcp_tokens as t", "t.id", "h.token_id").leftJoin("main.access as a", "a.login", "t.login").select(["t.id", "h.login", "h.models", "a.role"])
      .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS).where("h.readiness", "=", "ready")
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).whereRef("co.login", "=", "t.login").where("co.until", ">", nowMs))))),
    acceptedModels(db),
  ]);
  const byItem = new Map<string, Set<string>>();
  const add = (repo: string, number: number, logins: (string | null)[]) => {
    const key = `${repo}#${number}`;
    let s = byItem.get(key);
    if (!s) byItem.set(key, (s = new Set()));
    for (const l of logins) if (l) s.add(l.toLowerCase());
  };
  for (const w of live) add(w.repo, w.number, [w.started_by, w.approved_by]);
  for (const p of prs) add(p.repo, p.pr_number!, [p.started_by, p.approved_by]);
  const runnersOf = new Map<string, { role: string; tokens: Map<number, Set<Tier>> }>();
  for (const r of runners) {
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(r.models) as Record<string, unknown>; } catch { /* no models */ }
    const login = r.login.toLowerCase();
    const u = runnersOf.get(login) ?? { role: r.role ?? "", tokens: new Map<number, Set<Tier>>() };
    u.tokens.set(Number(r.id), new Set(Object.entries(models).flatMap(([t, m]) => (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null ? [t] : []))));
    runnersOf.set(login, u);
  }
  const runnerLogins = [...runnersOf.keys()];
  // The room's write rule (room.ts roomCanWrite): only a non-write permission confirmed within PERM_READ_TTL leaves a login out.
  const denied = new Set<string>();
  if (runnerLogins.length) for (const p of await db.all(db.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"]).where(inList(db, "login", runnerLogins, "citext"))))
    if (!WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) denied.add(`${p.login.toLowerCase()}\n${p.repo}`);
  const owners = (refs: readonly ItemRef[]): ReadonlySet<string> => {
    if (!refs.length || !byItem.size) return NONE;
    const [first, ...rest] = refs.map((r) => byItem.get(`${r.repo}#${r.number}`));
    if (!first || rest.some((s) => !s)) return NONE;
    return new Set([...first].filter((l) => rest.every((s) => s!.has(l))));
  };
  return {
    owners, runnerLogins,
    tiersOf: (login) => new Set([...runnersOf.get(login.toLowerCase())?.tokens.values() ?? []].flatMap((t) => [...t])),
    canTake: (login, c) => {
      const u = runnersOf.get(login.toLowerCase());
      if (!u || !roleFits(u.role, c) || c.repos.some((x) => denied.has(`${login.toLowerCase()}\n${x}`))) return false;
      return [...u.tokens].some(([id, tiers]) => id !== c.refusedToken && (c.tier === undefined ? tiers.size > 0 : tiers.has(c.tier)));
    },
    ownersFor: (c) => {
      if (c.refs) return owners(c.refs);
      if (c.step === undefined || !c.repos.length) return NONE;
      const task = taskOfStep(c.step);
      const working = live.filter((w) => WORKING.has(w.state) && ENTRY_TASKS[w.entry as Entry]?.has(task));
      return new Set(runnerLogins.filter((l) => c.repos.every((x) => working.some((w) => w.repo === x && [w.started_by, w.approved_by].some((b) => b?.toLowerCase() === l)))));
    },
  };
}

const caches = new WeakMap<Db, { at: number; v: Promise<StartedCalls> }>();
/** readStartedCalls for claims, read at most once per CACHE_MS. */
export function startedCallsCached(db: Db, nowMs: number): Promise<StartedCalls> {
  const hit = caches.get(db);
  if (hit && nowMs >= hit.at && nowMs - hit.at < CACHE_MS) return hit.v;
  const v = readStartedCalls(db, nowMs);
  caches.set(db, { at: nowMs, v });
  v.catch(() => { if (caches.get(db)?.v === v) caches.delete(db); });
  return v;
}
/** Drops the cached reading (with the queue cache, calls.ts dropQueueCache). */
export const dropStartedCache = (db: Db): void => void caches.delete(db);

/**
 * Whether a queued call is held for an owner other than `login` (null: anyone): within STARTED_HOLD_MS of its queueing, an
 * owner who may take it (canTake: a fresh, ready runner not cooling off that offers its tier, the role rules, write permission,
 * a credential other than the one whose model declined it; not a judging call on an item they authored). A call bound to a
 * user is never one of these. A runner's harness, effort and time limit are known only at its claim: a call none of the
 * owner's runners will lease for those is free once the hold ends.
 */
export function heldForOwner(s: StartedCalls, c: { forLogin: string | null; refs: readonly ItemRef[]; repos: readonly string[]; prompt_id: string; tier: Tier; authors: ReadonlySet<string>; refusedToken: number | null; since: number }, login: string | null, nowMs: number): boolean {
  if (c.forLogin !== null || c.since < nowMs - STARTED_HOLD_MS) return false;
  const self = login?.toLowerCase() ?? null;
  const judging = judges(c.prompt_id);
  for (const o of s.owners(c.refs)) if (o !== self && !(judging && c.authors.has(o)) && s.canTake(o, c)) return true;
  return false;
}

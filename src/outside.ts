// Protection of model spend from authors outside the team (docs/pipeline.md, "Outside authors").
//
// An outside author is an item's author who is not an operator or maintainer of the dashboard, not a GitHub Bot account (an app can open items only where it is installed),
// not a member, owner or collaborator of the repo (the mirror's author association), and not whitelisted (the Contributors page:
// an `allow` override or a whitelisted tier). A post-merge follow-up issue counts as an item of the merged PR's author. Two protections, each off at 0:
//   - Daily budget: of one outside author's items created in the last 24 hours, only the first `outside_prs_per_day` PRs and the
//     first `outside_issues_per_day` issues get model work. Later open ones wait until the window frees.
//   - Surge breaker: more than `outside_surge_per_hour` new outside-author items in the last hour trips the stage_trips row
//     `outside-surge`. Outside-author items created from an hour before the trip hold until an operator resumes it.
// An operator's Release exempts one item (or every held item of one author) from both holds.
//
// The planner calls refreshOutsideHolds() once per pass; it rewrites outside_holds. pilotSqlFor (src/pilot.ts) leaves a held item
// out of scope, so every stage that reads candidates through the pilot condition skips it. Sync, Embed and Rank do not use it.
import { filtered, hiddenTestExpr, type HiddenRepos } from "./hidden-sql.ts";
import { listAccess } from "./access.ts";
import { audit } from "./dash/audit.ts";
import { allOwnLogins } from "./github/identity.ts";
import type { OutsideHoldInfo } from "./core/plan.ts";
import { trip, tripRow } from "./push-outcomes.ts";
import { isWhitelisted, tierKey, whitelistedOf } from "./whitelist.ts";
import { pipelineRepos } from "./pilot.ts";
import { hasSetting, settingRows } from "./settings-read.ts";
import { isBotLogin } from "./review/bots.ts";
import { filterSeq } from "./async-seq.ts";
import type { Db } from "./db/index.ts";
import { ciEq, excluded } from "./db/kx.ts";

export const OUTSIDE_SURGE = "outside-surge";
export const KEYS = { prsPerDay: "outside_prs_per_day", issuesPerDay: "outside_issues_per_day", surgePerHour: "outside_surge_per_hour" } as const;
export type OutsideLimits = { prsPerDay: number; issuesPerDay: number; surgePerHour: number };
export const DEFAULT_LIMITS: OutsideLimits = { prsPerDay: 5, issuesPerDay: 5, surgePerHour: 30 };
const MAX = 100_000;
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

export class OutsideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function outsideLimits(db: Db): Promise<OutsideLimits> {
  const m = new Map([...await settingRows(db, [KEYS.prsPerDay, KEYS.issuesPerDay, KEYS.surgePerHour])].map(([k, v]) => [k, Number(v)]));
  const get = (k: string, d: number): number => { const v = m.get(k); return v !== undefined && Number.isInteger(v) && v >= 0 ? v : d; };
  return { prsPerDay: get(KEYS.prsPerDay, DEFAULT_LIMITS.prsPerDay), issuesPerDay: get(KEYS.issuesPerDay, DEFAULT_LIMITS.issuesPerDay), surgePerHour: get(KEYS.surgePerHour, DEFAULT_LIMITS.surgePerHour) };
}

/** Stores the three numbers (0 turns a protection off) and audits the change. */
export async function setOutsideLimits(db: Db, by: string, input: unknown): Promise<OutsideLimits> {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const was = await outsideLimits(db);
  const next = { ...was };
  for (const k of Object.keys(KEYS) as (keyof OutsideLimits)[]) {
    if (b[k] === undefined) continue;
    const v = b[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX) throw new OutsideError(`${k} must be a whole number from 0 to ${MAX}`);
    next[k] = v;
  }
  for (const k of Object.keys(KEYS) as (keyof OutsideLimits)[]) {
    await db.run(db.k.insertInto("main.settings").values({ key: KEYS[k], value: String(next[k]) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  }
  if (JSON.stringify(was) !== JSON.stringify(next)) await audit(db, by, "abuse-limits", "pipeline", { ...next, was });
  return next;
}

type Row = { repo: string; number: number; kind: string; author: string; author_id: number | null; state: string; created_at: string; author_association: string | null; author_type: string | null };
export type Hold = { repo: string; number: number; author: string; kind: "pr" | "issue"; reason: "limit" | "surge" };

const INSIDE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** GitHub Bot authors: the mirror's author type, or (rows synced before it was stored) a `[bot]` suffix or a known app login (the mirror stores app logins without the suffix). */
const isBotAuthor = (r: { author: string; author_type: string | null }): boolean =>
  r.author_type === "Bot" || (r.author_type === null && (isBotLogin(r.author) || r.author.toLowerCase() === "github-actions")) || r.author.endsWith("[bot]");

/** Once, on the first run: items that already have pipeline work (a decision, review, classification, stage row, fix-up, ...) count as admitted, so nothing in flight is held on deploy. */
async function backfillAdmitted(db: Db, since: string, now: number): Promise<void> {
  if (await hasSetting(db, "outside_admitted_backfill")) return;
  await db.run(db.k.insertInto("main.outside_admitted").columns(["repo", "number", "at"]).expression((eb) => eb.selectFrom("items as i")
    .select(["i.repo", "i.number", eb.val(new Date(now).toISOString()).as("at")])
    .where("i.created_at", ">=", since)
    .where((w) => w.or([
      w.exists(w.selectFrom("main.decisions as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.opus_reviews as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.classifications as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.fixups as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.ci_fixes as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.fix_attempts as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.verifications as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.pr_builds as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
      w.exists(w.selectFrom("main.stages as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number")),
    ]))).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("main.settings").values({ key: "outside_admitted_backfill", value: "1" }).onConflict((oc) => oc.doNothing()));
}

/** Whether a PR or issue row is by an outside author: not a collaborator by association, not a bot, not an operator, maintainer or own pipeline login. `inside` may be passed when many rows are judged. */
export async function isOutsideAuthor(db: Db, r: { author: string | null; author_association: string | null; author_type: string | null }, inside?: Set<string>): Promise<boolean> {
  if (inside === undefined) inside = await insiders(db);
  if (!r.author) return false;
  return !INSIDE_ASSOCIATIONS.has(r.author_association ?? "") && !isBotAuthor({ author: r.author, author_type: r.author_type }) && !inside.has(r.author.toLowerCase());
}

/** Logins that are never outside authors: the dashboard's operators and maintainers and the pipeline's own accounts (lowercase). */
async function insiders(db: Db): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of await listAccess(db)) if (a.role === "operator" || a.role === "maintainer") out.add(a.login.toLowerCase());
  for (const l of await allOwnLogins(db)) out.add(l.toLowerCase());
  return out;
}

export type OutsideRefresh = { holds: Hold[]; tripped: boolean; wakeAt: number | null };

/**
 * Recomputes the holds from the items created in the last 24 hours, evaluates the surge breaker and rewrites outside_holds
 * (only when the set changed). Returns the holds and the time the first hold can lapse.
 */
export async function refreshOutsideHolds(db: Db, now: number = Date.now()): Promise<OutsideRefresh> {
  const lim = await outsideLimits(db);
  const enabled = lim.prsPerDay > 0 || lim.issuesPerDay > 0 || lim.surgePerHour > 0;
  const holds: Hold[] = [];
  let wakeAt: number | null = null;
  const released = new Set((await db.all(db.k.selectFrom("main.outside_released").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`));
  // The breaker's row, read once: only trip() below writes it, and a trip starts the refresh again.
  const surge = await tripRow(db, OUTSIDE_SURGE);
  if (enabled) {
    const dayAgo = now - DAY_MS;
    const tripped = lim.surgePerHour > 0 ? surge : undefined;
    const surgeFrom = tripped?.active ? Date.parse(tripped.tripped_at) - HOUR_MS : null;
    // While the breaker is tripped its holds last until it is resumed, however old the items are.
    const from = Math.min(dayAgo, surgeFrom ?? dayAgo);
    // Only items in scope for model work count: repos with the pipeline on, and not fast-tracked.
    const scope = await pipelineRepos(db);
    const fast = new Set((await db.all(db.k.selectFrom("main.fast_track").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`));
    // A post-merge follow-up issue is opened by the pipeline from a review of a merged PR: it counts as an item of that PR's author.
    const rows = (await db.all(db.k.selectFrom("items as i")
      .leftJoin("items as p", (j) => j.on("i.kind", "=", "issue").onRef("p.repo", "=", "i.repo").on((eb) => eb("p.number", "=", eb.selectFrom("main.postmerge_followups as f").select("f.number").whereRef("f.repo", "=", "i.repo").whereRef("f.issue_number", "=", "i.number").limit(1))))
      .select((eb) => [
        "i.repo", "i.number", "i.kind", "i.state", "i.created_at",
        eb.fn.coalesce("p.author", "i.author").as("author"),
        eb.case().when("p.author", "is", null).then(eb.ref("i.author_id")).else(eb.ref("p.author_id")).end().as("author_id"),
        eb.case().when("p.author", "is", null).then(eb.ref("i.author_association")).else(eb.ref("p.author_association")).end().as("author_association"),
        eb.case().when("p.author", "is", null).then(eb.ref("i.author_type")).else(eb.ref("p.author_type")).end().as("author_type"),
      ])
      .$narrowType<{ created_at: string; author: string }>()
      .where("i.created_at", ">=", new Date(from).toISOString()).where("i.author", "is not", null)))
      // Sorted here: an ORDER BY makes SQLite walk every item in key order instead of the recent ones by created_at.
      .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number))
      .filter((r) => scope.has(r.repo) && !fast.has(`${r.repo}#${r.number}`));
    await backfillAdmitted(db, new Date(from).toISOString(), now);
    const admitted = new Set((await db.all(db.k.selectFrom("main.outside_admitted").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`));
    const inside = await insiders(db);
    const memo = new Map<string, boolean>();
    // Whitelisting belongs to the author's account, not to the login string.
    const whitelisted = async (r: Row): Promise<boolean> => {
      const k = `${r.author.toLowerCase()}|${r.author_id ?? ""}`;
      let v = memo.get(k);
      if (v === undefined) { v = (await isWhitelisted(db, r.author, r.author_id)).ok; memo.set(k, v); }
      return v;
    };
    const cheap = await filterSeq(rows, async (r) => await isOutsideAuthor(db, r, inside));

    // Surge: outside-author items of the last hour since the last resume.
    if (lim.surgePerHour > 0 && !tripped?.active) {
      const since = Math.max(now - HOUR_MS, Date.parse(surge?.cleared_at ?? "") || 0);
      const recent = cheap.filter((r) => Date.parse(r.created_at) > since);
      // The whitelist is read only when the cheap count already passes the threshold.
      const real = recent.length > lim.surgePerHour ? await filterSeq(recent, async (r) => !await whitelisted(r)) : [];
      if (real.length > lim.surgePerHour) {
        const byAuthor = new Map<string, number>();
        for (const r of real) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
        const top = [...byAuthor].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}: ${n}`);
        await trip(db, OUTSIDE_SURGE, `${real.length} new items from outside authors in the last hour (more than ${lim.surgePerHour})`, top, new Date(now).toISOString());
        return await refreshOutsideHolds(db, now);
      }
    }
    const groups = new Map<string, Row[]>();
    for (const r of cheap) {
      const k = `${r.author.toLowerCase()}|${r.author_id ?? ""}|${r.kind}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const checked = [...groups.values()].map((rs) => {
      rs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
      const kind = rs[0]!.kind === "pr" ? "pr" as const : "issue" as const;
      const limit = kind === "pr" ? lim.prsPerDay : lim.issuesPerDay;
      const win = rs.filter((r) => Date.parse(r.created_at) >= dayAgo);
      return { rs, kind, limit, win, overLimit: limit > 0 && win.length > limit, inSurge: surgeFrom !== null && rs.some((r) => Date.parse(r.created_at) >= surgeFrom) };
    }).filter((g) => g.overLimit || g.inSurge);
    // The whitelist of the authors to check, in one read.
    const unread = new Map<string, Row>();
    for (const { rs } of checked) { const k = `${rs[0]!.author.toLowerCase()}|${rs[0]!.author_id ?? ""}`; if (!memo.has(k) && !unread.has(k)) unread.set(k, rs[0]!); }
    if (unread.size) {
      const ok = await whitelistedOf(db, [...unread.values()].map((r) => ({ login: r.author, id: r.author_id })));
      for (const [k, r] of unread) memo.set(k, ok.get(tierKey({ login: r.author, id: r.author_id }))!);
    }
    for (const { rs, kind, limit, win, overLimit } of checked) {
      if (await whitelisted(rs[0]!)) continue;
      // An admitted item (planned without a hold once, or with pipeline work already) is never held again.
      const free = (r: Row) => r.state !== "OPEN" || released.has(`${r.repo}#${r.number}`) || admitted.has(`${r.repo}#${r.number}`);
      for (const r of rs) if (!free(r) && surgeFrom !== null && Date.parse(r.created_at) >= surgeFrom) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "surge" });
      const surged = new Set(holds.map((h) => `${h.repo}#${h.number}`));
      win.forEach((r, i) => {
        if (overLimit && i >= limit && !free(r) && !surged.has(`${r.repo}#${r.number}`)) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "limit" });
      });
      if (overLimit) { const t = Date.parse(win[0]!.created_at) + DAY_MS; wakeAt = wakeAt === null ? t : Math.min(wakeAt, t); }
    }
    // Admit what is in scope and not held.
    const held = new Set(holds.map((h) => `${h.repo}#${h.number}`));
    const at = new Date(now).toISOString();
    for (const r of cheap) if (!held.has(`${r.repo}#${r.number}`) && !admitted.has(`${r.repo}#${r.number}`)) await db.run(db.k.insertInto("main.outside_admitted").values({ repo: r.repo, number: r.number, at }).onConflict((oc) => oc.doNothing()));
  }
  const have = await db.all(db.k.selectFrom("main.outside_holds").select(["repo", "number", "author", "kind", "reason"]).$narrowType<{ kind: Hold["kind"]; reason: Hold["reason"] }>());
  const key = (h: Hold) => `${h.repo}#${h.number}|${h.author}|${h.kind}|${h.reason}`;
  const want = new Set(holds.map(key));
  if (have.length !== holds.length || have.some((h) => !want.has(key(h)))) {
    await db.write(async () => {
      await db.run(db.k.deleteFrom("main.outside_holds"));
      for (const h of holds) await db.run(db.k.insertInto("main.outside_holds").values({ repo: h.repo, number: h.number, author: h.author, kind: h.kind, reason: h.reason }));
    });
  }
  return { holds, tripped: !!surge?.active, wakeAt };
}

/** The wait text of a held item (the registered wait "author over daily limit", and the surge variant). */
export function holdWait(h: Pick<OutsideHoldInfo, "reason" | "kind" | "limit">): string {
  return h.reason === "surge" ? "the outside-surge breaker, until an operator resumes it" : `author's daily limit (${h.limit} new ${h.kind === "pr" ? "PRs" : "issues"} a day)`;
}

/** The holds as `repo#number` to their reason. */
export async function holdMap(db: Db): Promise<Map<string, OutsideHoldInfo>> {
  const rows = await db.all(db.k.selectFrom("main.outside_holds").select(["repo", "number", "author", "kind", "reason"]).$narrowType<{ kind: Hold["kind"]; reason: Hold["reason"] }>());
  if (!rows.length) return new Map();
  const lim = await outsideLimits(db);
  return new Map(rows.map((h) => [`${h.repo}#${h.number}`, { reason: h.reason, author: h.author, kind: h.kind, limit: h.kind === "pr" ? lim.prsPerDay : lim.issuesPerDay }]));
}

/** An operator exempts one held item from both holds. */
export async function releaseOutside(db: Db, by: string, repo: string, number: number): Promise<void> {
  const h = await db.get(db.k.selectFrom("main.outside_holds").select("author").where("repo", "=", repo).where("number", "=", number));
  if (!h) throw new OutsideError(`${repo}#${number} is not held for its author`, 409);
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("main.outside_released").values({ repo, number, by, at }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.deleteFrom("main.outside_holds").where("repo", "=", repo).where("number", "=", number));
  await audit(db, by, "outside-release", `${repo}#${number}`, { author: h.author });
}

/** An operator exempts every item now held for one author. Returns how many. */
export async function releaseAuthor(db: Db, by: string, author: string): Promise<number> {
  const rows = await db.all(db.k.selectFrom("main.outside_holds").select(["repo", "number"]).where((eb) => ciEq(db, "author", eb.val(author))));
  if (!rows.length) throw new OutsideError(`nothing is held for ${author}`, 409);
  const at = new Date().toISOString();
  for (const r of rows) await db.run(db.k.insertInto("main.outside_released").values({ repo: r.repo, number: r.number, by, at }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.deleteFrom("main.outside_holds").where((eb) => ciEq(db, "author", eb.val(author))));
  await audit(db, by, "outside-release-author", author, { items: rows.length });
  return rows.length;
}

export type OutsideState = OutsideLimits & { heldByLimit: number; heldBySurge: number; authors: number; tripped: { reason: string; since: string } | null };

export async function outsideState(db: Db, hidden: HiddenRepos = []): Promise<OutsideState> {
  const c = (await db.get(db.k.selectFrom("main.outside_holds").select((eb) => [
    eb.fn.sum<number | null>(eb.case().when("reason", "=", "limit").then(1).else(0).end()).as("l"),
    eb.fn.sum<number | null>(eb.case().when("reason", "=", "surge").then(1).else(0).end()).as("s"),
    eb.fn.count<number>("author").distinct().as("a"),
  ]).$if(filtered(hidden), (q) => q.where((eb) => eb.not(hiddenTestExpr(db, "repo", hidden))))))!;
  const t = await tripRow(db, OUTSIDE_SURGE);
  return { ...await outsideLimits(db), heldByLimit: c.l ?? 0, heldBySurge: c.s ?? 0, authors: c.a, tripped: t?.active ? { reason: t.reason, since: t.tripped_at } : null };
}

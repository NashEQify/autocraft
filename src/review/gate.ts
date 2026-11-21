// Reasons a due review waits: another item blocks the PR, CI at its head has not passed, the PR used its reviews for the day,
// the last review is too recent, or the last attempts at this head failed.
import * as kx from "../db/kx.ts";
import { audit } from "../dash/audit.ts";
import { effectiveCi, effectiveCiWith, optionalChecksOf } from "../optional-checks.ts";
import { BLOCKED_EXPIRES_MS, BLOCKS_REVIEW, blockersLoader, storedBlockedBy } from "./blockers.ts";
import { MAX_RERUNS_PER_DAY, discussionState, maintainerSince, nextUtcMidnight, staleMarksSince, type DiscussionState } from "./discussion.ts";
import { ourCommitsLoader } from "./ours.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

/** Opus review calls of one PR per UTC day, new heads, re-runs and failed calls together (a reply-fix turn is part of its review). */
export const MAX_REVIEWS_PER_DAY = MAX_RERUNS_PER_DAY;

/** Setting: least minutes between two Opus reviews of one PR; 0 turns the wait off. */
export const MIN_INTERVAL_KEY = "review_min_interval_minutes";
export const MIN_INTERVAL_DEFAULT = 120;
const MIN_INTERVAL_MAX = 7 * 24 * 60;

/** Waits after the 1st, 2nd and 3rd failed review at one head; a 4th failure holds the head until a new commit or Review again. */
export const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000];
const FAIL_KEY = "review_fail:";

export async function reviewMinInterval(db: Db): Promise<number> {
  const v = await setting(db, MIN_INTERVAL_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= MIN_INTERVAL_MAX ? n : MIN_INTERVAL_DEFAULT;
}

export async function setReviewMinInterval(db: Db, input: unknown, by: string): Promise<number> {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MIN_INTERVAL_MAX) throw new Error(`the minimum minutes between reviews must be a whole number from 0 to ${MIN_INTERVAL_MAX}`);
  const was = await reviewMinInterval(db);
  await db.run(db.k.insertInto("main.settings").values({ key: MIN_INTERVAL_KEY, value: String(n) }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  if (n !== was) await audit(db, by, "review-min-interval", "pipeline", { minutes: n, was });
  return n;
}

const failKey = (repo: string, number: number, head: string) => `${FAIL_KEY}${repo}#${number}@${head}`;

/** Counts a review call at this head that gave no valid review; the earlier heads' counts are forgotten. */
export async function recordReviewFailure(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<void> {
  const key = failKey(repo, number, head);
  const cur = await setting(db, key);
  const n = (Number(cur?.split("|")[0]) || 0) + 1;
  await db.run(db.k.deleteFrom("main.settings").where((eb) => kx.like(db, "key", eb.val(`${kx.likeEscape(`${FAIL_KEY}${repo}#${number}@`)}%`), "\\")).where("key", "<>", key));
  await db.run(db.k.insertInto("main.settings").values({ key, value: `${n}|${new Date(nowMs).toISOString()}` }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
}

/** `until`: when a timed wait ends (ms), so the planner wakes then. `red`: a ci hold whose head's CI has failed (not still running). */
export type ReviewHold = { kind: "blocked" | "ci" | "cap" | "interval" | "failed"; wait: string; until?: number; red?: boolean; /** A blocker has an open question: the wait is on a person. */ person?: boolean };

/** CI at the PR's head as the review gate reads it: "ok" (passed, or no checks and none pending), "pending", "failure", or "unknown" when the stored checks describe another head. */
export async function headCi(db: Db, repo: string, number: number, head: string): Promise<"ok" | "pending" | "failure" | "unknown"> {
  const c = await db.get(db.k.selectFrom("main.pr_checks").select(["head_oid", "overall", "checks"]).where("repo", "=", repo).where("number", "=", number));
  if (!c || c.head_oid !== head) return "unknown";
  const o = await effectiveCi(db, repo, c.overall, c.checks);
  return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
}

export { nextUtcMidnight };

/**
 * The hold check of every PR of one planning pass: the statements run once. A hold is what keeps the next review of a PR at `head`
 * from starting, or null. A maintainer's or operator's request after the latest review lifts every hold.
 * An unknown CI state does not hold (the review step reads the checks live before asking the model and applies this again).
 * Not held by CI: the first review of a PR when CI is red (running CI still waits), and the one review after the blockers settled.
 * Not held by the cap or the interval: a head that only our own pushes made since the last review.
 * `refresh` is told when a hold without an `until` of its own ends with the clock (a blocker list expiring).
 */
export async function reviewHolds(db: Db, nowMs: number = Date.now(), refs?: Iterable<string>): Promise<(repo: string, number: number, head: string, refresh?: (at: number) => void) => Promise<ReviewHold | null>> {
  // Each table is read once, on first use, for every PR (or only `refs`, "repo#number"), keyed by `repo#number`.
  const only = refs ? [...refs] : null;
  const once = <T>(load: () => Promise<T>): (() => Promise<T>) => { let v: T | undefined; return async () => (v ??= await load()); };
  const keyOf = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;
  type Last = { k: string; head_oid: string; at: string; verdict: string; seen_at: string | null; disc_hash: string | null; blocked_by: string | null };
  const lastReviews = once(async () => {
    const out = new Map<string, Last>();
    const rows = await db.all(db.k.selectFrom("main.opus_reviews as o")
      .select(["o.repo", "o.number", "o.head_oid", "o.at", "o.verdict", "o.seen_at", "o.disc_hash", "o.blocked_by"])
      .where("o.verdict", "is not", null)
      .$if(!!only, (q) => q.where(kx.refIn(db, "o", only!)))
      .orderBy("o.at", (o) => o.desc().nullsLast()).orderBy(kx.rowid("main.opus_reviews", "o"), "desc"));
    for (const r of rows) if (!out.has(keyOf(r))) out.set(keyOf(r), { ...r, k: keyOf(r), verdict: r.verdict! });
    return out;
  });
  type Count = { k: string; n: number; last: string | null };
  const countMap = (load: () => Promise<{ repo: string; number: number; n: number; last: string | null }[]>) =>
    once(async () => new Map((await load()).map((r): [string, Count] => [keyOf(r), { k: keyOf(r), n: r.n, last: r.last }])));
  const history = countMap(() => db.all(db.k.selectFrom("main.opus_review_history as h")
    .select((eb) => ["h.repo", "h.number", eb.fn.count<number>(eb.case().when("h.at", ">=", today).then(1).end()).as("n"), eb.fn.max<string | null>("h.at").as("last")])
    .where("h.model", "is not", null).where("h.model", "<>", "carried")
    .where((eb) => eb(eb.fn.coalesce("h.mode", eb.val("")), "<>", "carried"))
    .$if(!!only, (q) => q.where(kx.refIn(db, "h", only!)))
    .groupBy(["h.repo", "h.number"])));
  // One review call per job and PR: the reply-lint fix turn is a follow-up run of the same job, not another review.
  const runs = countMap(() => db.all(db.k.selectFrom((eb) => eb.selectFrom("main.agent_run_items as i")
      .innerJoin("main.agent_runs as r", "r.id", "i.run_id")
      .select((eb2) => ["i.repo", "i.number", eb2.fn.min<string>("r.started_at").as("s")])
      .where("r.step", "=", "opus-review")
      .$if(!!only, (q) => q.where(kx.refIn(db, "i", only!)))
      .groupBy(["i.repo", "i.number"]).groupBy((eb2) => eb2.fn.coalesce("r.job_id", eb2("r.id", "*", -1)))
      .as("x"))
    .select((eb) => ["x.repo", "x.number", eb.fn.count<number>(eb.case().when("x.s", ">=", today).then(1).end()).as("n"), eb.fn.max<string | null>("x.s").as("last")])
    .groupBy(["x.repo", "x.number"])));
  // A "Queue items" row at the head it started on (no fix-up, no push since) asks for no review of its own: CI, the cap and the interval hold it as any PR.
  const preapproved = once(async () => new Set((await db.all(db.k.selectFrom("main.preapprovals as p").select(["p.repo", "p.number", "p.head"])
    .where("p.state", "=", "review")
    .where((eb) => eb.or([eb("p.fix_id", "is not", null), eb("p.head", "<>", eb.ref("p.from_head"))]))
    .$if(!!only, (q) => q.where(kx.refIn(db, "p", only!))))).flatMap((r) => (r.head === null ? [] : [`${keyOf(r)}@${r.head}`]))));
  const failures = once(async () => new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"])
    .where((eb) => kx.like(db, "key", eb.val(`${kx.likeEscape(FAIL_KEY)}%`), "\\")))).map((r) => [r.key, r.value])));
  // The checks list only where effectiveCiWith() reads it: a failure.
  const checks = once(async () => new Map((await db.all(db.k.selectFrom("main.pr_checks as c")
    .select((eb) => ["c.repo", "c.number", "c.head_oid", "c.overall", eb.case().when("c.overall", "=", "failure").then(eb.ref("c.checks")).end().as("checks")])
    .$if(!!only, (q) => q.where(kx.refIn(db, "c", only!))))).map((r) => [keyOf(r), r])));
  const optional = once(async () => await optionalChecksOf(db));
  const staleSince = once(async () => await staleMarksSince(db));
  const blockers = once(async () => blockersLoader(db));
  const ourPath = once(async () => ourCommitsLoader(db));
  // CI at the head as headCi() reads it.
  const ciAt = async (repo: string, number: number, head: string): Promise<"ok" | "pending" | "failure" | "unknown"> => {
    const c = (await checks()).get(`${repo}#${number}`);
    if (!c || c.head_oid !== head) return "unknown";
    const o = effectiveCiWith((await optional())(repo), c.overall, c.checks);
    return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
  };
  const interval = await reviewMinInterval(db) * 60_000;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const states = new Map<string, DiscussionState>();
  return async (repo, number, head, refresh) => {
    const ref = `${repo}#${number}`;
    const last = (await lastReviews()).get(ref);
    // The failure backoff holds even after a request: a review that keeps failing is not retried on every pass.
    const failed = (await failures()).get(failKey(repo, number, head));
    if (failed) {
      const [n, at] = [Number(failed.split("|")[0]), Date.parse(failed.split("|")[1] ?? "")];
      const delay = FAILURE_BACKOFF_MS[n - 1];
      if (delay === undefined) {
        // Final. A request newer than the last failure grants one more try; a failure then stamps a newer time and makes it final again.
        const since = failed.split("|")[1] ?? "";
        const asked = (await staleSince())(repo, number, since) || await maintainerSince((await discussionState(db, repo)).get(`${repo}#${number}`), since, null);
        if (!asked) return { kind: "failed", wait: `its review failed ${n} times at this commit; a new commit, a Review again press or a maintainer's comment gives it one more try` };
      } else if (at + delay > nowMs) return { kind: "failed", wait: `the review after ${n} failed ${n === 1 ? "try" : "tries"} at this commit, from ${new Date(at + delay).toISOString().slice(11, 16)}`, until: at + delay };
    }
    // A person's pre-approved merge waits for the review of the head the pipeline pushed for it: that is their request for it, as a review-again press would be.
    if ((await preapproved()).has(`${ref}@${head}`)) return null;
    if (last) {
      let state = states.get(repo);
      if (!state) states.set(repo, (state = await discussionState(db, repo)));
      // reviewRequestedSince() with the stale marks read once.
      if ((await staleSince())(repo, number, last.at) || await maintainerSince(state.get(ref), last.seen_at ?? last.at, last.disc_hash)) return null;
    }
    let settled = false;
    if (last?.verdict === "hold" && storedBlockedBy(last.blocked_by).length) {
      const open = await (await blockers()).active(`${repo}#${number}`, last.blocked_by, last.at, nowMs);
      if (open.length) {
        refresh?.(Date.parse(last.at) + BLOCKED_EXPIRES_MS + 1);
        return { kind: "blocked", wait: `${open.join(", ")}${BLOCKS_REVIEW}`, ...(await (await blockers()).openQuestion(open) ? { person: true } : {}) };
      }
      settled = true;
    }
    const ci = await ciAt(repo, number, head);
    if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
    if (ci === "failure" && last && !settled) return { kind: "ci", wait: "CI on the latest commit to pass", red: true };
    const ours = last && last.head_oid !== head ? await (await ourPath())(repo, number, last.head_oid, head) : null;
    if (ours?.complete && ours.commits.length) return null;
    const h = (await history()).get(ref) ?? { n: 0, last: null };
    const r = (await runs()).get(ref) ?? { n: 0, last: null };
    if (Math.max(h.n, r.n) >= MAX_REVIEWS_PER_DAY) return { kind: "cap", wait: "review cap for today reached; next on a maintainer's request or tomorrow", until: nextUtcMidnight(nowMs) };
    if (interval) {
      // Successful reviews only: failed calls count toward the cap, and the failure backoff spaces their retries.
      const until = h.last ? Date.parse(h.last) + interval : 0;
      if (until > nowMs) return { kind: "interval", wait: `next review after ${new Date(until).toISOString().slice(11, 16)}`, until };
    }
    return null;
  };
}

export const reviewHold = async (db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<ReviewHold | null> => await (await reviewHolds(db, nowMs, [`${repo}#${number}`]))(repo, number, head);

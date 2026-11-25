// Reasons a due review waits: another item blocks the PR, CI at its head has not passed, the PR used its reviews for the day,
// the last review is too recent, or the last attempts at this head failed.
import { effectiveCiWith, optionalChecksOf } from "../optional-checks.ts";
import { BLOCKED_EXPIRES_MS, BLOCKS_REVIEW, activeFrom, hasOpenQuestion, loadBlockerReads } from "./blockers.ts";
import { MAX_RERUNS_PER_DAY, maintainerSince, discussionStateOf, nextUtcMidnight, staleMarksOf } from "./discussion.ts";
import { ourCommitsLoader } from "./ours.ts";
import type { Db } from "../db/index.ts";
import type { KeySource } from "../data/keys.ts";
import { saveSettings, setting } from "../data/control/index.ts";
import { loadReviewRunCounts } from "../data/inference/index.ts";
import { loadChecks } from "../data/mirror/index.ts";
import { loadReviewFacts, recordReviewFailures } from "../data/review/index.ts";
import { loadLegs } from "../data/workflow/index.ts";

/** Opus review calls of one PR per UTC day, new heads, re-runs and failed calls together (a reply-fix turn is part of its review). */
export const MAX_REVIEWS_PER_DAY = MAX_RERUNS_PER_DAY;

/** Setting: least minutes between two Opus reviews of one PR; 0 turns the wait off. */
export const MIN_INTERVAL_KEY = "review_min_interval_minutes";
export const MIN_INTERVAL_DEFAULT = 120;
const MIN_INTERVAL_MAX = 7 * 24 * 60;

/** Waits after the 1st, 2nd and 3rd failed review at one head; a 4th failure holds the head until a new commit or Review again. */
export const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000];

export async function reviewMinInterval(db: Db): Promise<number> {
  const v = await setting(db, MIN_INTERVAL_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= MIN_INTERVAL_MAX ? n : MIN_INTERVAL_DEFAULT;
}

export async function setReviewMinInterval(db: Db, input: unknown, by: string): Promise<number> {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MIN_INTERVAL_MAX) throw new Error(`the minimum minutes between reviews must be a whole number from 0 to ${MIN_INTERVAL_MAX}`);
  const was = await reviewMinInterval(db);
  await saveSettings(db, [{ key: MIN_INTERVAL_KEY as never, value: String(n) }], by, n !== was ? { action: "review-min-interval", target: "pipeline", details: { minutes: n, was } } : { action: "settings-save", target: "settings" });
  return n;
}

/** Counts a review call at this head that gave no valid review; the earlier heads' counts are forgotten. */
export async function recordReviewFailure(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<void> {
  await recordReviewFailures(db, [{ repo, number, head, at: new Date(nowMs).toISOString() }]);
}

/** `until`: when a timed wait ends (ms), so the planner wakes then. `red`: a ci hold whose head's CI has failed (not still running). */
export type ReviewHold = { kind: "blocked" | "ci" | "cap" | "interval" | "failed"; wait: string; until?: number; red?: boolean; /** A blocker has an open question: the wait is on a person. */ person?: boolean };

/** CI at the PR's head as the review gate reads it: "ok" (passed, or no checks and none pending), "pending", "failure", or "unknown" when the stored checks describe another head. */
export async function headCi(db: Db, repo: string, number: number, head: string): Promise<"ok" | "pending" | "failure" | "unknown"> {
  const [checks, optional] = await Promise.all([loadChecks(db, [{ repo, number }]), optionalChecksOf(db)]);
  const c = checks.get(`${repo}#${number}`);
  if (!c || c.head_oid !== head) return "unknown";
  const o = effectiveCiWith(optional(repo), c.overall, c.checks);
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
  // Everything is read once, for every PR (or only `refs`, "repo#number"), keyed by `repo#number`.
  const keys: KeySource = refs ? [...refs].map((r) => ({ repo: r.slice(0, r.lastIndexOf("#")), number: Number(r.slice(r.lastIndexOf("#") + 1)) })) : { mode: "full" };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const interval = await reviewMinInterval(db) * 60_000;
  const [facts, runs, legs, checks, optional] = await db.together(() => Promise.all([
    loadReviewFacts(db, keys, { now: nowMs }), loadReviewRunCounts(db, keys, today), loadLegs(db, keys, { activeOnly: true }),
    loadChecks(db, keys, { checksOnlyIfFailing: true }), optionalChecksOf(db),
  ]));
  const lastReviews = facts.latest;
  const history = facts.reviewsToday;
  const staleSince = staleMarksOf(facts);
  // A "Queue items" row at the head it started on (no fix-up, no push since) asks for no review of its own: CI, the cap and the interval hold it as any PR.
  const preapproved = new Set([...legs.values()].flat().filter((p) => p.state === "review" && (p.fix_id !== null || p.head !== p.from_head) && p.head !== null).map((p) => `${p.repo}#${p.number}@${p.head}`));
  const states = discussionStateOf(facts);
  const reads = await loadBlockerReads(db, [...lastReviews.values()].filter((r) => r.verdict === "hold").flatMap((r) => r.blocked_by));
  const ourPath = ourCommitsLoader(db, keys);
  // CI at the head as headCi() reads it.
  const ciAt = async (repo: string, number: number, head: string): Promise<"ok" | "pending" | "failure" | "unknown"> => {
    const c = checks.get(`${repo}#${number}`);
    if (!c || c.head_oid !== head) return "unknown";
    const o = effectiveCiWith(optional(repo), c.overall, c.checks);
    return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
  };
  return async (repo, number, head, refresh) => {
    const ref = `${repo}#${number}`;
    const last = lastReviews.get(ref);
    // The failure backoff holds even after a request: a review that keeps failing is not retried on every pass.
    const mark = facts.marks.get(ref);
    const failed = mark && mark.failHead === head && mark.failCount > 0 ? mark : undefined;
    if (failed) {
      const [n, at] = [failed.failCount, Date.parse(failed.failAt ?? "")];
      const delay = FAILURE_BACKOFF_MS[n - 1];
      if (delay === undefined) {
        // Final. A request newer than the last failure grants one more try; a failure then stamps a newer time and makes it final again.
        const since = failed.failAt ?? "";
        const asked = staleSince(repo, number, since) || await maintainerSince(states.get(ref), since, null);
        if (!asked) return { kind: "failed", wait: `its review failed ${n} times at this commit; a new commit, a Review again press or a maintainer's comment gives it one more try` };
      } else if (at + delay > nowMs) return { kind: "failed", wait: `the review after ${n} failed ${n === 1 ? "try" : "tries"} at this commit, from ${new Date(at + delay).toISOString().slice(11, 16)}`, until: at + delay };
    }
    // A person's pre-approved merge waits for the review of the head the pipeline pushed for it: that is their request for it, as a review-again press would be.
    if (preapproved.has(`${ref}@${head}`)) return null;
    if (last) {
      // reviewRequestedSince() with the stale marks read once.
      if (staleSince(repo, number, last.at) || await maintainerSince(states.get(ref), last.seen_at ?? last.at, last.disc_hash)) return null;
    }
    let settled = false;
    if (last?.verdict === "hold" && last.blocked_by.length) {
      const open = activeFrom(reads, ref, last.blocked_by, last.at, nowMs);
      if (open.length) {
        refresh?.(Date.parse(last.at) + BLOCKED_EXPIRES_MS + 1);
        return { kind: "blocked", wait: `${open.join(", ")}${BLOCKS_REVIEW}`, ...(hasOpenQuestion(reads, open) ? { person: true } : {}) };
      }
      settled = true;
    }
    const ci = await ciAt(repo, number, head);
    if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
    if (ci === "failure" && last && !settled) return { kind: "ci", wait: "CI on the latest commit to pass", red: true };
    const ours = last && last.head !== head ? await ourPath(repo, number, last.head, head) : null;
    if (ours?.complete && ours.commits.length) return null;
    const h = history.get(ref) ?? { n: 0, last: null };
    const r = runs.get(ref) ?? { n: 0, last: null };
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

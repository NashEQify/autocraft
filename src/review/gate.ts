// Reasons a due review waits: another item blocks the PR, CI at its head has not passed, the PR used its reviews for the day,
// the last review is too recent, or the last attempts at this head failed.
import { refIn, refPairs } from "../core/ref-filter.ts";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { effectiveCi, effectiveCiWith, optionalChecksOf } from "../optional-checks.ts";
import { BLOCKED_EXPIRES_MS, BLOCKS_REVIEW, blockersLoader, storedBlockedBy } from "./blockers.ts";
import { MAX_RERUNS_PER_DAY, discussionState, maintainerSince, nextUtcMidnight, staleMarksSince, type DiscussionState } from "./discussion.ts";
import { ourCommitsLoader } from "./ours.ts";
import { setting } from "../settings-read.ts";

/** Opus review calls of one PR per UTC day, new heads, re-runs and failed calls together (a reply-fix turn is part of its review). */
export const MAX_REVIEWS_PER_DAY = MAX_RERUNS_PER_DAY;

/** Setting: least minutes between two Opus reviews of one PR; 0 turns the wait off. */
export const MIN_INTERVAL_KEY = "review_min_interval_minutes";
export const MIN_INTERVAL_DEFAULT = 120;
const MIN_INTERVAL_MAX = 7 * 24 * 60;

/** Waits after the 1st, 2nd and 3rd failed review at one head; a 4th failure holds the head until a new commit or Review again. */
export const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000];
const FAIL_KEY = "review_fail:";

export function reviewMinInterval(db: DatabaseSync): number {
  const v = setting(db, MIN_INTERVAL_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= MIN_INTERVAL_MAX ? n : MIN_INTERVAL_DEFAULT;
}

export function setReviewMinInterval(db: DatabaseSync, input: unknown, by: string): number {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MIN_INTERVAL_MAX) throw new Error(`the minimum minutes between reviews must be a whole number from 0 to ${MIN_INTERVAL_MAX}`);
  const was = reviewMinInterval(db);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MIN_INTERVAL_KEY, String(n));
  if (n !== was) audit(db, by, "review-min-interval", "pipeline", { minutes: n, was });
  return n;
}

const failKey = (repo: string, number: number, head: string) => `${FAIL_KEY}${repo}#${number}@${head}`;

/** Counts a review call at this head that gave no valid review; the earlier heads' counts are forgotten. */
export function recordReviewFailure(db: DatabaseSync, repo: string, number: number, head: string, nowMs: number = Date.now()): void {
  const key = failKey(repo, number, head);
  const cur = setting(db, key);
  const n = (Number(cur?.split("|")[0]) || 0) + 1;
  db.prepare("DELETE FROM main.settings WHERE key LIKE ? AND key <> ?").run(`${FAIL_KEY}${repo}#${number}@%`, key);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, `${n}|${new Date(nowMs).toISOString()}`);
}

/** `until`: when a timed wait ends (ms), so the planner wakes then. `red`: a ci hold whose head's CI has failed (not still running). */
export type ReviewHold = { kind: "blocked" | "ci" | "cap" | "interval" | "failed"; wait: string; until?: number; red?: boolean; /** A blocker has an open question: the wait is on a person. */ person?: boolean };

/** CI at the PR's head as the review gate reads it: "ok" (passed, or no checks and none pending), "pending", "failure", or "unknown" when the stored checks describe another head. */
export function headCi(db: DatabaseSync, repo: string, number: number, head: string): "ok" | "pending" | "failure" | "unknown" {
  const c = db.prepare("SELECT head_oid, overall, checks FROM main.pr_checks WHERE repo = ? AND number = ?").get(repo, number) as { head_oid: string; overall: string; checks: string | null } | undefined;
  if (!c || c.head_oid !== head) return "unknown";
  const o = effectiveCi(db, repo, c.overall, c.checks);
  return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
}

export { nextUtcMidnight };

/**
 * The hold check of every PR of one planning pass: statements are prepared once. A hold is what keeps the next review of a PR at `head`
 * from starting, or null. A maintainer's or operator's request after the latest review lifts every hold.
 * An unknown CI state does not hold (the review step reads the checks live before asking the model and applies this again).
 * Not held by CI: the first review of a PR when CI is red (running CI still waits), and the one review after the blockers settled.
 * Not held by the cap or the interval: a head that only our own pushes made since the last review.
 * `refresh` is told when a hold without an `until` of its own ends with the clock (a blocker list expiring).
 */
export function reviewHolds(db: DatabaseSync, nowMs: number = Date.now(), refs?: Iterable<string>): (repo: string, number: number, head: string, refresh?: (at: number) => void) => ReviewHold | null {
  // Each table is read once, on first use, for every PR (or only `refs`, "repo#number"), keyed by `repo#number`.
  const only = refs ? refPairs(refs) : null;
  const narrow = (a: string): string => (only ? ` AND ${refIn(a)}` : "");
  const bind = (p: Record<string, string> = {}): Record<string, string> => (only ? { ...p, refs: only } : p);
  const once = <T>(load: () => T): (() => T) => { let v: T | undefined; return () => (v ??= load()); };
  type Last = { k: string; head_oid: string; at: string; verdict: string; seen_at: string | null; disc_hash: string | null; blocked_by: string | null };
  const lastReviews = once(() => {
    const out = new Map<string, Last>();
    for (const r of db.prepare(`SELECT o.repo || '#' || o.number AS k, o.head_oid, o.at, o.verdict, o.seen_at, o.disc_hash, o.blocked_by FROM main.opus_reviews o
      WHERE o.verdict IS NOT NULL${narrow("o")} ORDER BY o.at DESC, o.rowid DESC`).all(bind()) as Last[]) if (!out.has(r.k)) out.set(r.k, r);
    return out;
  });
  type Count = { k: string; n: number; last: string | null };
  const countMap = (sql: string) => once(() => new Map((db.prepare(sql).all(bind({ today })) as Count[]).map((r) => [r.k, r])));
  const history = countMap(`SELECT h.repo || '#' || h.number AS k, COUNT(CASE WHEN h.at >= :today THEN 1 END) AS n, MAX(h.at) AS last FROM main.opus_review_history h
    WHERE h.model IS NOT NULL AND h.model <> 'carried' AND COALESCE(h.mode, '') <> 'carried'${narrow("h")} GROUP BY h.repo, h.number`);
  // One review call per job and PR: the reply-lint fix turn is a follow-up run of the same job, not another review.
  const runs = countMap(`SELECT x.repo || '#' || x.number AS k, COUNT(CASE WHEN x.s >= :today THEN 1 END) AS n, MAX(x.s) AS last FROM (
      SELECT i.repo, i.number, MIN(r.started_at) AS s FROM main.agent_run_items i JOIN main.agent_runs r ON r.id = i.run_id
      WHERE r.step = 'opus-review'${narrow("i")} GROUP BY i.repo, i.number, COALESCE(r.job_id, -r.id)) x GROUP BY x.repo, x.number`);
  // A "Queue items" row at the head it started on (no fix-up, no push since) asks for no review of its own: CI, the cap and the interval hold it as any PR.
  const preapproved = once(() => new Set((db.prepare(`SELECT p.repo || '#' || p.number || '@' || p.head AS k FROM main.preapprovals p
    WHERE p.state = 'review' AND (p.fix_id IS NOT NULL OR p.head <> p.from_head)${narrow("p")}`).all(bind()) as { k: string }[]).map((r) => r.k)));
  const failures = once(() => new Map((db.prepare("SELECT key, value FROM main.settings WHERE key LIKE :prefix").all({ prefix: `${FAIL_KEY}%` }) as { key: string; value: string }[]).map((r) => [r.key, r.value])));
  // The checks list only where effectiveCiWith() reads it: a failure.
  const checks = once(() => new Map((db.prepare(`SELECT c.repo || '#' || c.number AS k, c.head_oid, c.overall, CASE WHEN c.overall = 'failure' THEN c.checks END AS checks FROM main.pr_checks c WHERE 1${narrow("c")}`).all(bind()) as
    { k: string; head_oid: string; overall: string; checks: string | null }[]).map((r) => [r.k, r])));
  const optional = once(() => optionalChecksOf(db));
  const staleSince = once(() => staleMarksSince(db));
  const blockers = once(() => blockersLoader(db));
  const ourPath = once(() => ourCommitsLoader(db));
  // CI at the head as headCi() reads it.
  const ciAt = (repo: string, number: number, head: string): "ok" | "pending" | "failure" | "unknown" => {
    const c = checks().get(`${repo}#${number}`);
    if (!c || c.head_oid !== head) return "unknown";
    const o = effectiveCiWith(optional()(repo), c.overall, c.checks);
    return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
  };
  const interval = reviewMinInterval(db) * 60_000;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const states = new Map<string, DiscussionState>();
  return (repo, number, head, refresh) => {
    const ref = `${repo}#${number}`;
    const last = lastReviews().get(ref);
    // The failure backoff holds even after a request: a review that keeps failing is not retried on every pass.
    const failed = failures().get(failKey(repo, number, head));
    if (failed) {
      const [n, at] = [Number(failed.split("|")[0]), Date.parse(failed.split("|")[1] ?? "")];
      const delay = FAILURE_BACKOFF_MS[n - 1];
      if (delay === undefined) {
        // Final. A request newer than the last failure grants one more try; a failure then stamps a newer time and makes it final again.
        const since = failed.split("|")[1] ?? "";
        const asked = staleSince()(repo, number, since) || maintainerSince(discussionState(db, repo).get(`${repo}#${number}`), since, null);
        if (!asked) return { kind: "failed", wait: `its review failed ${n} times at this commit; a new commit, a Review again press or a maintainer's comment gives it one more try` };
      } else if (at + delay > nowMs) return { kind: "failed", wait: `the review after ${n} failed ${n === 1 ? "try" : "tries"} at this commit, from ${new Date(at + delay).toISOString().slice(11, 16)}`, until: at + delay };
    }
    // A person's pre-approved merge waits for the review of the head the pipeline pushed for it: that is their request for it, as a review-again press would be.
    if (preapproved().has(`${ref}@${head}`)) return null;
    if (last) {
      let state = states.get(repo);
      if (!state) states.set(repo, (state = discussionState(db, repo)));
      // reviewRequestedSince() with the stale marks read once.
      if (staleSince()(repo, number, last.at) || maintainerSince(state.get(ref), last.seen_at ?? last.at, last.disc_hash)) return null;
    }
    let settled = false;
    if (last?.verdict === "hold" && storedBlockedBy(last.blocked_by).length) {
      const open = blockers().active(`${repo}#${number}`, last.blocked_by, last.at, nowMs);
      if (open.length) {
        refresh?.(Date.parse(last.at) + BLOCKED_EXPIRES_MS + 1);
        return { kind: "blocked", wait: `${open.join(", ")}${BLOCKS_REVIEW}`, ...(blockers().openQuestion(open) ? { person: true } : {}) };
      }
      settled = true;
    }
    const ci = ciAt(repo, number, head);
    if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
    if (ci === "failure" && last && !settled) return { kind: "ci", wait: "CI on the latest commit to pass", red: true };
    const ours = last && last.head_oid !== head ? ourPath()(repo, number, last.head_oid, head) : null;
    if (ours?.complete && ours.commits.length) return null;
    const h = history().get(ref) ?? { n: 0, last: null };
    const r = runs().get(ref) ?? { n: 0, last: null };
    if (Math.max(h.n, r.n) >= MAX_REVIEWS_PER_DAY) return { kind: "cap", wait: "review cap for today reached; next on a maintainer's request or tomorrow", until: nextUtcMidnight(nowMs) };
    if (interval) {
      // Successful reviews only: failed calls count toward the cap, and the failure backoff spaces their retries.
      const until = h.last ? Date.parse(h.last) + interval : 0;
      if (until > nowMs) return { kind: "interval", wait: `next review after ${new Date(until).toISOString().slice(11, 16)}`, until };
    }
    return null;
  };
}

export const reviewHold = (db: DatabaseSync, repo: string, number: number, head: string, nowMs: number = Date.now()): ReviewHold | null => reviewHolds(db, nowMs, [`${repo}#${number}`])(repo, number, head);

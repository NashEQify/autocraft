// The conflict step's candidate shape, tries and per-head bucket (the PRs come from their Plans, fixup/select.ts).
import { BASE_NAME, CONFLICT_MAX_MERGES_PER_PR_PER_DAY, conflictNote as coreConflictNote, unsentAsk } from "../core/rules.ts";
import type { Db } from "../db/index.ts";

/** Base branch names the merge accepts as a fetch ref. */
export { BASE_NAME };

/** Merge tries per head (pushed, failed, refused or rejected) before the PR is left to a person. */
export const MAX_CONFLICT_TRIES = 2;

export const CONFLICT_STATES = ["pushing", "merged", "failed", "refused", "rejected", "asked", "comment-failed", "comment-unsent", "linting", "skipped", "cannot-push", "push-denied", "superseded"] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];
const TRY_STATES: ConflictState[] = ["pushing", "merged", "failed", "refused", "rejected"];

export type ConflictCandidate = {
  repo: string; number: number; head: string; /** The PR's base branch name. */ base: string; title: string;
  /** The final review's reason. */ reason: string; attempt: number; pushable: boolean;
  /** A model resolution stored and linted: the collect step pushes it, or gives it up. */
  lint?: { rowid: number; round: number; task: number | null; baseSha: string; resolved: string; files: string[]; /** The kept resolver sessions by file (src/prepush/resume.ts). */ session: string | null };
};
/** capped: the PR already had its merges of the base branch for the UTC day. merge: we will merge the base in; ask: comment once asking the contributor; ask-retry: that comment never reached GitHub and is due again at conflictAskRetryAt; asked: that comment is posted; held: nothing to do without a person and no comment approval to ask (two tries used, a deterministic skip recorded at this head, or a branch we can't push to); unapproved: pushable but the repo has no push approval; done: merged at this head already. */
export type ConflictBucket = "merge" | "ask" | "ask-retry" | "asked" | "held" | "unapproved" | "linting" | "capped" | "done";

/** A PR's conflict_merges rows, oldest first: what its tries, merges of the day, unsent asks and bucket are decided from. */
export type ConflictRow = { from_head: string | null; state: string; created_at: string | null };

/** The PR's conflict_merges rows, oldest first. */
export async function conflictRows(db: Db, repo: string, number: number): Promise<ConflictRow[]> {
  return await db.prepare("SELECT from_head, state, created_at FROM conflict_merges WHERE repo = ? AND number = ? ORDER BY rowid").all(repo, number) as ConflictRow[];
}

/** conflictTries() from the PR's rows. */
export const triesIn = (rows: ConflictRow[], head: string): number => rows.filter((r) => r.from_head === head && (TRY_STATES as string[]).includes(r.state)).length;

export async function conflictTries(db: Db, repo: string, number: number, head: string): Promise<number> {
  return triesIn(await conflictRows(db, repo, number), head);
}

/** Merges of the base branch pushed into the PR since the start of the UTC day of `nowMs`, over all its heads. */
function mergesToday(rows: ConflictRow[], nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return rows.filter((r) => (r.state === "merged" || r.state === "pushing") && r.created_at !== null && r.created_at >= day).length;
}

export async function conflictMergesToday(db: Db, repo: string, number: number, nowMs: number = Date.now()): Promise<number> {
  return mergesToday(await conflictRows(db, repo, number), nowMs);
}

/** Where the head's unsent ask comments leave the next ask (src/core/rules.ts unsentAsk). */
function unsentConflictAsk(rows: ConflictRow[], head: string, nowMs: number): { until: number } | "final" | null {
  return unsentAsk(rows.filter((r) => r.from_head === head && r.state === "comment-unsent").map((r) => r.created_at!), nowMs);
}

/** When an ask-retry bucket's comment is due again (ms), from the PR's rows. */
export function conflictAskRetryAtOf(rows: ConflictRow[], head: string, nowMs: number): number | undefined {
  const u = unsentConflictAsk(rows, head, nowMs);
  return u !== null && u !== "final" ? u.until : undefined;
}

export async function conflictAskRetryAt(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<number | undefined> {
  return conflictAskRetryAtOf(await conflictRows(db, repo, number), head, nowMs);
}

export async function conflictBucket(db: Db, p: { repo: string; number: number; head: string; pushable: boolean }, approvals: { push: boolean; comment: boolean }, nowMs: number = Date.now()): Promise<ConflictBucket> {
  return conflictBucketOf(await conflictRows(db, p.repo, p.number), p, approvals, nowMs);
}

/** conflictBucket() from the PR's rows. */
export function conflictBucketOf(rows: ConflictRow[], p: { head: string; pushable: boolean }, approvals: { push: boolean; comment: boolean }, nowMs: number): ConflictBucket {
  const here = new Set(rows.filter((r) => r.from_head === p.head).map((r) => r.state));
  const has = (state: string) => here.has(state);
  if (has("merged")) return "done";
  // Nothing more can be done by a merge at this head: the contributor is asked once (a comment needs approval).
  // A comment that failed is final too: GitHub may have posted it, so it is not posted again. One that never reached
  // GitHub is asked again after a backoff, and is final after the last one.
  const stuck = (): ConflictBucket => {
    if (has("asked")) return "asked";
    const unsent = unsentConflictAsk(rows, p.head, nowMs);
    if (has("comment-failed") || unsent === "final" || !approvals.comment) return "held";
    return unsent ? "ask-retry" : "ask";
  };
  if (has("skipped") || has("push-denied")) return stuck();
  if (has("linting")) return "linting";
  if (!p.pushable || has("cannot-push")) return stuck();
  if (triesIn(rows, p.head) >= MAX_CONFLICT_TRIES) return stuck();
  if (mergesToday(rows, nowMs) >= CONFLICT_MAX_MERGES_PER_PR_PER_DAY) return "capped";
  return approvals.push ? "merge" : "unapproved";
}

export const conflictNote = (bucket: ConflictBucket, base: string): string | null => coreConflictNote(bucket, base);

// The base branch a review read its diff against, and what may merge into which base.
import { audit } from "../dash/audit.ts";
import { dropCachedDiff } from "../review/diff.ts";
import type { Db } from "../db/index.ts";

/** The base branch the review of this head read its diff against; null when none was recorded. */
export async function reviewedBaseOf(db: Db, repo: string, number: number, head: string): Promise<string | null> {
  return (await db.prepare("SELECT base_ref FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, number, head) as { base_ref: string | null } | undefined)?.base_ref ?? null;
}

export async function defaultBranchOf(db: Db, repo: string): Promise<string | null> {
  return (await db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch ?? null;
}

/**
 * Why a PR may not merge into its current base, or null: the merge goes into the branch the review read the diff against.
 * A review that recorded none (stored earlier) allows only the default branch.
 */
export async function baseRefusal(db: Db, repo: string, head: string, number: number, liveBase: string): Promise<string | null> {
  const reviewed = await reviewedBaseOf(db, repo, number, head) ?? await defaultBranchOf(db, repo);
  if (!reviewed) return null;
  return liveBase === reviewed ? null : `the base branch is ${liveBase}, but the review read the diff against ${reviewed}`;
}

/** Whether another branch may be merged into a PR: the default branch or the base its review read. */
export async function mergeInAllowed(db: Db, repo: string, number: number, head: string, branch: string): Promise<boolean> {
  return branch === await defaultBranchOf(db, repo) || branch === await reviewedBaseOf(db, repo, number, head);
}

/**
 * A live read found the PR on another base than the mirror holds: the mirror takes the live base and the cached diff of the
 * old base is dropped. The planner then counts the review as stale (src/review/discussion.ts staleReviews), and the re-review
 * waits like one after a push: the PR author's retarget is no request for a review. `keepDiff`: the cached diff was just read
 * against the live base (a review's own read), so it stays.
 */
export async function recordLiveBase(db: Db, repo: string, number: number, head: string, liveBase: string, o: { by?: string; keepDiff?: boolean } = {}): Promise<void> {
  if (!o.keepDiff) await dropCachedDiff(db, repo, number, head);
  const was = (await db.prepare("SELECT base_ref FROM items WHERE repo = ? AND number = ?").get(repo, number) as { base_ref: string | null } | undefined)?.base_ref ?? null;
  if (was === liveBase) return;
  await db.prepare("UPDATE main.items SET base_ref = ? WHERE repo = ? AND number = ?").run(liveBase, repo, number);
  await audit(db, o.by ?? "merge", "base-changed", `${repo}#${number}`, { head, from: was, base: liveBase });
}

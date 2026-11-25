// Review, history, post and pre- and post-merge loaders (M13 review).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { Finding, Followup, HeadKey, HeadRef, HistoryRow, MirrorEntry, PendingDefect, PostmergeRow, PremergeRow, RefKey, ReviewPost, ReviewRow, ReviewTexts } from "./types.ts";

/** Window `row_number() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) = 1` over `final_reviews`. */
export async function loadLatestReviews(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRow>> {
  throw new Error("not built: review.loadLatestReviews");
}

/** The review at each head (tuple key); replaces every point read by `(repo, number, head)`. */
export async function loadReviewsAt(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, ReviewRow>> {
  throw new Error("not built: review.loadReviewsAt");
}

/** All heads' reviews of each PR, newest first. */
export async function loadReviewRows(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRow[]>> {
  throw new Error("not built: review.loadReviewRows");
}

/** The heavy columns, kept out of `ReviewRow`. */
export async function loadReviewTexts(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, ReviewTexts>> {
  throw new Error("not built: review.loadReviewTexts");
}

/** `opus_review_history` rows with a verdict, oldest first. */
export async function loadReviewHistory(db: Db, keys: KeySource, o?: { headOnly?: HeadKey[] }): Promise<Map<RefKey, HistoryRow[]>> {
  throw new Error("not built: review.loadReviewHistory");
}

/** The fixes of the latest history row at each head as `file: change`, at most 8. */
export async function loadFixesAsked(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, string[]>> {
  throw new Error("not built: review.loadFixesAsked");
}

/** `review_posts` rows. */
export async function loadPosts(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewPost>> {
  throw new Error("not built: review.loadPosts");
}

/** Mirrored comments and review bodies others wrote, oldest first (the fallback source of a review prompt that has no GitHub read). */
export async function loadDiscussionEntries(db: Db, keys: KeySource): Promise<Map<RefKey, MirrorEntry[]>> {
  throw new Error("not built: review.loadDiscussionEntries");
}

/** Pre-merge rows read against the same base branch as the head's Opus review. */
export async function loadPremerge(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, PremergeRow>> {
  throw new Error("not built: review.loadPremerge");
}

/** Post-merge rows. */
export async function loadPostmerge(db: Db, keys: KeySource): Promise<Map<RefKey, PostmergeRow>> {
  throw new Error("not built: review.loadPostmerge");
}

/** Ordered by `review_at`, `finding`. */
export async function loadFollowups(db: Db, keys: KeySource): Promise<Map<RefKey, Followup[]>> {
  throw new Error("not built: review.loadFollowups");
}

/** The PRs that are the fix PR of a follow-up issue this stage filed (`implementations.pr_number`). */
export async function loadFollowupFixPrs(db: Db, keys: KeySource): Promise<Set<RefKey>> {
  throw new Error("not built: review.loadFollowupFixPrs");
}

/** Defects of the latest clean post-merge review of each PR that filing may still try; three statements in one wave. */
export async function loadPendingDefects(db: Db, keys: KeySource, o: { now: number }): Promise<PendingDefect[]> {
  throw new Error("not built: review.loadPendingDefects");
}

/** Defects filed in the last 30 days with their finding, by one join. */
export async function loadRecentFiled(db: Db, repo: string, o: { now: number }): Promise<{ number: number; f: Finding }[]> {
  throw new Error("not built: review.loadRecentFiled");
}

/** Merged PRs since `since` with no post-merge row. */
export async function countUnreviewedMerges(db: Db, since: string): Promise<number> {
  throw new Error("not built: review.countUnreviewedMerges");
}

/** PRs whose latest review was at `head`. */
export async function loadReviewedRefs(db: Db, repo: string, head: string): Promise<RefKey[]> {
  throw new Error("not built: review.loadReviewedRefs");
}

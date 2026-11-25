// Writers (M13 review). Each opens `db.write` itself or joins an outer one and writes its audit rows and stage events in the same transaction.
import type { Db } from "../../db/index.ts";
import type { FollowupKey, FollowupRow, PostSave, PostmergeSave, PremergeSave, RefKey, SaveReviewInput, SaveReviewResult } from "./types.ts";

/** Copies the replaced row to history, writes the history row, upserts `opus_reviews`, updates `review_state` and writes the `reviewed` and verdict stage rows; a base change deletes the head's pre-merge row and calls `merge.markVerificationsStale`; no GitHub or model call inside. */
export async function saveReviews(db: Db, inputs: SaveReviewInput[]): Promise<SaveReviewResult[]> {
  throw new Error("not built: review.saveReviews");
}

/** Upserts `stale_at = now`; with `by` also writes `review-again` audit rows. */
export async function markStale(db: Db, items: { repo: string; number: number }[], by: string | null): Promise<void> {
  throw new Error("not built: review.markStale");
}

/** One upsert with `CASE WHEN fail_head = excluded.fail_head THEN fail_count + 1 ELSE 1 END`. */
export async function recordReviewFailures(db: Db, items: { repo: string; number: number; head: string; at: string }[]): Promise<void> {
  throw new Error("not built: review.recordReviewFailures");
}

/** The operator "Review again" on a hold: `DELETE ... WHERE verdict = 'hold' RETURNING` plus the audit row. */
export async function dropHoldReviews(db: Db, items: { repo: string; number: number; head: string }[], by: string): Promise<{ repo: string; number: number; reason: string }[]> {
  throw new Error("not built: review.dropHoldReviews");
}

/** Stored reviews and failed tries as two multi-row upserts. */
export async function savePremerge(db: Db, saves: PremergeSave[]): Promise<void> {
  throw new Error("not built: review.savePremerge");
}

/** A failed try never replaces a stored clean review; a `retry:` error adds to `tries` and becomes `held: gave up after N tries` at the maximum; one follow-up row per skipped finding. The caller records the defects with `control.tripMergeBreakers`. */
export async function savePostmerge(db: Db, saves: PostmergeSave[]): Promise<{ defects: Map<RefKey, number> }> {
  throw new Error("not built: review.savePostmerge");
}

/** `INSERT ... ON CONFLICT DO UPDATE SET state = 'filing' ... WHERE state NOT IN ('filing', 'filed') RETURNING`; returns the claimed keys. */
export async function claimFollowups(db: Db, rows: FollowupKey[], o: { at: string }): Promise<Set<string>> {
  throw new Error("not built: review.claimFollowups");
}

/** Upsert of follow-up rows (filing result, failed, skipped). */
export async function saveFollowups(db: Db, rows: FollowupRow[]): Promise<void> {
  throw new Error("not built: review.saveFollowups");
}

/** A fresh post is an upsert of every column; an edit updates head, edit time, `opus_at` and `posted_as` only. */
export async function saveReviewPosts(db: Db, rows: PostSave[]): Promise<void> {
  throw new Error("not built: review.saveReviewPosts");
}

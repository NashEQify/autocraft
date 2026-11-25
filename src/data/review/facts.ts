// The planner's review facts (M13 review).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ReviewFacts } from "./types.ts";

/** Ten statements in one wave: latest reviews, unsure heads, today's reviews, carried chains, posts, pre-merge and post-merge rows, `review_state` marks, discussion stats and blocker verdicts. */
export async function loadReviewFacts(db: Db, keys: KeySource, o: { now: number }): Promise<ReviewFacts> {
  throw new Error("not built: review.loadReviewFacts");
}

// Read models for pages (M13 review).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { RefKey, ReviewEventRow, ReviewRecord, ReviewSignature } from "./types.ts";

/** Everything the item page, MCP item tool and trace show of reviews; five statements in one wave. */
export async function loadReviewRecord(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRecord>> {
  throw new Error("not built: review.loadReviewRecord");
}

/** Counts and newest times for the trace cache key; five statements in one wave. */
export async function loadReviewSignature(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewSignature>> {
  throw new Error("not built: review.loadReviewSignature");
}

/** The three feeds of `dash/api/activity.ts`; three statements in one wave. */
export async function listReviewEvents(db: Db, f: { since: string; limit: number; repos?: string[] }): Promise<ReviewEventRow[]> {
  throw new Error("not built: review.listReviewEvents");
}

// The PR status comment (M11 workflow-b).
import type { Db } from "../../db/index.ts";
import type { ItemWorkflow, StatusRow } from "./types.ts";

/** Non-final rows, excluding a Closed line on a closed item. */
export async function loadStatusComments(db: Db, repo: string): Promise<StatusRow[]> {
  throw new Error("not built: workflow.loadStatusComments");
}

/** Latest workflow per item with the item's open state. */
export async function loadLatestWorkflows(db: Db, repo: string): Promise<Map<number, { wf: ItemWorkflow; open: boolean }>> {
  throw new Error("not built: workflow.loadLatestWorkflows");
}

/** Batched upsert. */
export async function saveStatusComments(db: Db, rows: StatusRow[]): Promise<void> {
  throw new Error("not built: workflow.saveStatusComments");
}

/** Next retry time of a repo's status comments. */
export async function loadStatusRetryAt(db: Db, repo: string, nowMs: number): Promise<number | null> {
  throw new Error("not built: workflow.loadStatusRetryAt");
}

/** Count for the lane fingerprint. */
export async function countStatusRetriesDue(db: Db, nowMs: number): Promise<number> {
  throw new Error("not built: workflow.countStatusRetriesDue");
}

// CI run approvals (`ci_run_approvals`) (package merge-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { HeadRef, RunApproval, RunResult, RunsInput } from "./types.ts";

/** Waiting and approved runs per head. 1 statement. */
export async function loadRunApprovals(db: Db, keys: KeySource): Promise<Map<HeadRef, RunApproval>> { throw new Error("not built: merge.loadRunApprovals"); }
/** Records the workflow runs waiting for approval at each PR's head; reads the previous rows in the transaction because `approved` merges with them. */
export async function recordRuns(db: Db, rows: RunsInput[], at: string): Promise<void> { throw new Error("not built: merge.recordRuns"); }
/** Marks PRs for a reread: deletes rows of other heads, upserts the mark. */
export async function markRereads(db: Db, rows: { repo: string; number: number; head: string }[], at: string): Promise<void> { throw new Error("not built: merge.markRereads"); }
/** Stores approval results; reads the current `approved` lists first, in the same `db.write`. */
export async function saveRunResults(db: Db, rows: RunResult[]): Promise<void> { throw new Error("not built: merge.saveRunResults"); }

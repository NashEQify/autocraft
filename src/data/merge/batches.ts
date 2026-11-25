// Batches (`merge_batches`, `merge_batch_prs`, `merge_repo_state`) (package merge-a).
import type { Db } from "../../db/index.ts";
import type { BatchByTask, BatchDue, BatchEnd, BatchLanded, BatchListRow, BatchPageView, BatchRun, BatchState, BatchUpdate, BatchView, HeadRef, HiddenRepos, NewBatch } from "./types.ts";

/** Active batches of the repo with members, and the repo's batch size. 2 statements in one wave. */
export async function loadBatchRun(db: Db, repo: string): Promise<BatchRun> { throw new Error("not built: merge.loadBatchRun"); }
/** Batches by id, with members. 1 statement. */
export async function loadBatches(db: Db, ids: number[]): Promise<Map<number, BatchView>> { throw new Error("not built: merge.loadBatches"); }
/** One-key wrapper over `loadBatches`. */
export async function getBatch(db: Db, id: number): Promise<BatchView | undefined> { throw new Error("not built: merge.getBatch"); }
/** The id of the batch with that branch. */
export async function loadBatchByBranch(db: Db, repo: string, branch: string): Promise<number | undefined> { throw new Error("not built: merge.loadBatchByBranch"); }
/** Child batches (split from `id`), newest first. */
export async function loadBatchChildren(db: Db, id: number): Promise<{ id: number; createdAt: string }[]> { throw new Error("not built: merge.loadBatchChildren"); }
/** The batch, its parent's state and its children in one statement. */
export async function loadBatchPage(db: Db, id: number): Promise<BatchPageView | null> { throw new Error("not built: merge.loadBatchPage"); }
/** Active batches with members, optionally of some repos and not hidden. 1 statement. */
export async function listActiveBatches(db: Db, f: { repos?: string[]; hidden?: HiddenRepos }): Promise<BatchView[]> { throw new Error("not built: merge.listActiveBatches"); }
/** A page of batches with members and areas: wave 1 count and page, wave 2 `triage.loadItemAreas`. */
export async function listBatchPage(db: Db, o: { repo?: string; hidden?: HiddenRepos; before?: number; limit: number }): Promise<{ batches: BatchListRow[]; total: number; more: boolean }> { throw new Error("not built: merge.listBatchPage"); }
/** The batch of each build task id. 1 statement. */
export async function loadBatchesByTask(db: Db, taskIds: number[]): Promise<Map<number, BatchByTask>> { throw new Error("not built: merge.loadBatchesByTask"); }
/** Active batches that are open, or checking and past their retry wait, with member refs. */
export async function loadBatchDue(db: Db, now: Date): Promise<BatchDue[]> { throw new Error("not built: merge.loadBatchDue"); }
/** Opens a batch in one `db.write`: branch name, batch row, member rows and the `batch-start` audit row. */
export async function openBatch(db: Db, b: NewBatch): Promise<{ id: number; branch: string }> { throw new Error("not built: merge.openBatch"); }
/** Updates batches with `kx.updateFrom`; `onlyIf` is the compare-and-set, `size` grows or shrinks the repo's batch size. Returns the ids changed. */
export async function updateBatches(db: Db, rows: BatchUpdate[]): Promise<number[]> { throw new Error("not built: merge.updateBatches"); }
/** Ends batches in one `db.write`: the batch rows, stage events, audit rows and merge holds. */
export async function endBatches(db: Db, rows: BatchEnd[]): Promise<void> { throw new Error("not built: merge.endBatches"); }
/** Records a landed batch: batch to `merged`, member `merges` rows, size growth, mirror write-through, stage events and audit. Max 8 statements. */
export async function recordLanded(db: Db, r: BatchLanded): Promise<{ was: BatchState }> { throw new Error("not built: merge.recordLanded"); }
/** Sets the repo's batch size. */
export async function setBatchSize(db: Db, repo: string, n: number, by?: string): Promise<number> { throw new Error("not built: merge.setBatchSize"); }
/** Batch sizes per repo. */
export async function loadBatchSizes(db: Db, repos?: string[]): Promise<Map<string, number>> { throw new Error("not built: merge.loadBatchSizes"); }
/** Supersedes the failed batch holding the head, with the `batch-again` audit row. */
export async function supersedeFailedBatch(db: Db, by: string, key: { repo: string; number: number; head: string }): Promise<{ id: number; summary: string | null }> { throw new Error("not built: merge.supersedeFailedBatch"); }
/** The failed batch holding each head. */
export async function loadFailedBatchOf(db: Db, keys: { repo: string; number: number; head: string }[]): Promise<Map<HeadRef, { id: number; summary: string | null }>> { throw new Error("not built: merge.loadFailedBatchOf"); }

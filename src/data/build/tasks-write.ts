// Task writers (package build-a).
import type { Db } from "../../db/index.ts";
import type { CancelOutcome, NewTask, PodRun, TaskRecord, TaskState, TaskResult } from "./types.ts";

/** Validates every row, refuses the whole set when `queued + rows.length` would pass the queue cap, then one multi-row insert returning ids in order. */
export async function createTasks(db: Db, rows: NewTask[]): Promise<number[]> { throw new Error("not built: build.createTasks"); }
/** Clones tasks (sources, count, insert); returns the new id per source id. */
export async function cloneTasks(db: Db, ids: number[]): Promise<Map<number, number>> { throw new Error("not built: build.cloneTasks"); }
/** Cancels tasks by id or by step and repo, with audit rows in the same transaction. */
export async function cancelTasks(db: Db, sel: { ids: number[] } | { step: string; repo?: string }, by: string, summaryOf?: (t: { id: number; repo: string; was: TaskState }) => string | null): Promise<CancelOutcome[]> { throw new Error("not built: build.cancelTasks"); }
/** Compare-and-set claim of a queued task plus the pod run insert; null when the task was no longer queued. */
export async function claimRun(db: Db, a: { envId: string; taskId: number; keyHash: string; pvc: string | null; stage: string; at: string; heads?: { head: string; base: string | null; plan: unknown } }): Promise<{ task: TaskRecord; run: PodRun } | null> { throw new Error("not built: build.claimRun"); }
/** Batched claim for worker environments; returns the ids that won. */
export async function claimTasks(db: Db, envId: string, picks: { id: number; head?: string; base?: string; plan?: unknown }[], at: string): Promise<number[]> { throw new Error("not built: build.claimTasks"); }
/** Fails queued tasks no environment can run. */
export async function failQueuedTasks(db: Db, rows: { id: number; summary: string }[], at: string): Promise<number> { throw new Error("not built: build.failQueuedTasks"); }
/** Queues claimed tasks again with the claim not counted and their logs removed. */
export async function releaseClaims(db: Db, envId: string, ids: number[]): Promise<number> { throw new Error("not built: build.releaseClaims"); }
/** Worker API start: `started_at = coalesce`, heartbeat; returns the environment's recent cancels. */
export async function startTasks(db: Db, envId: string, ids: number[], at: string): Promise<{ started: number[]; cancel: number[] }> { throw new Error("not built: build.startTasks"); }
/** Heartbeat of tasks a launcher or worker keeps alive. */
export async function touchTasks(db: Db, envId: string, ids: number[], at: string): Promise<number> { throw new Error("not built: build.touchTasks"); }
/** Worker API finish; state from `cancel_requested_at`, `done` when every step exited 0. */
export async function finishTask(db: Db, envId: string, id: number, r: { results: TaskResult[]; summary: string | null; sandbox: Record<string, string> | null; failed: boolean }): Promise<{ state: TaskState }> { throw new Error("not built: build.finishTask"); }
/** Appends log chunks: reserves the bytes with one conditional update, then one multi-row insert. */
export async function appendTaskLogs(db: Db, envId: string, id: number, step: string, chunks: string[]): Promise<{ truncated: boolean; logBytes: number }> { throw new Error("not built: build.appendTaskLogs"); }
/** Requeues lost tasks with attempts left, fails or cancels the rest, removes artifact rows; returns artifact file ids to delete. */
export async function loseTasks(db: Db, rows: { id: number; reason: string; cancelled: boolean }[], nowMs: number): Promise<number> { throw new Error("not built: build.loseTasks"); }
/** Selects stale claimed or running tasks without a pod run and without heartbeat, then `loseTasks`. */
export async function reapStaleTasks(db: Db, nowMs: number): Promise<{ lost: number; files: number[] }> { throw new Error("not built: build.reapStaleTasks"); }
/** One batch of up to 200 expired artifacts and tasks with logs; the caller loops and removes the artifact directories. */
export async function pruneTaskBatch(db: Db, a: { nowMs: number }): Promise<{ artifactIds: number[]; deleted: number[] }> { throw new Error("not built: build.pruneTaskBatch"); }

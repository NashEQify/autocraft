// Task loaders (package build-a).
import type { Db } from "../../db/index.ts";
import type { IdSource, NewTask, Ref, RefSource, TaskBrief, TaskLite, TaskRecord, TaskStateRow } from "./types.ts";

/** Task rows by id or id fragment; `patch` adds the stored patch. 1 statement. */
export async function loadTasks(db: Db, ids: IdSource, opt?: { patch?: boolean }): Promise<Map<number, TaskRecord>> { throw new Error("not built: build.loadTasks"); }
/** State, step and end time per task id. 1 statement. */
export async function loadTaskStates(db: Db, ids: IdSource): Promise<Map<number, TaskStateRow>> { throw new Error("not built: build.loadTaskStates"); }
/** Tasks of the items that are not in a terminal state. */
export async function loadOpenTasks(db: Db, refs: RefSource): Promise<Map<Ref, TaskLite[]>> { throw new Error("not built: build.loadOpenTasks"); }
/** Task rows per job with the step each one's log is on, for the live board and jobs. */
export async function loadTasksOfJobs(db: Db, jobIds: number[]): Promise<Map<number, TaskBrief[]>> { throw new Error("not built: build.loadTasksOfJobs"); }
/** True when the task is missing or terminal (the planner's rule over loaded states). */
export function taskEnded(states: ReadonlyMap<number, { state: string }>, id: number | null): boolean { throw new Error("not built: build.taskEnded"); }
/** The count of ended tasks and their newest id and end time, the planner's `tasksSig`. */
export async function loadEndedTaskSignature(db: Db): Promise<string> { throw new Error("not built: build.loadEndedTaskSignature"); }
/** Queued count and oldest queue time, optionally only older than a time, private steps only or excluded. */
export async function loadQueuedStats(db: Db, opt: { olderThan?: string; privateOnly?: boolean; excludePrivate?: boolean }): Promise<{ n: number; oldest: string | null }> { throw new Error("not built: build.loadQueuedStats"); }
/** Count of `warm_role = use` head tasks per key `step|repo#number|head` (verify, screenshots). */
export async function loadRetriesOf(db: Db, keys: { step: string; repo: string; number: number; headSha: string }[]): Promise<Map<string, number>> { throw new Error("not built: build.loadRetriesOf"); }
/** Task rows as `NewTask` for cloning. */
export async function loadCloneSources(db: Db, ids: number[]): Promise<Map<number, NewTask>> { throw new Error("not built: build.loadCloneSources"); }
/** Queued warm-build tasks of a head that moved (to cancel); heads come from the mirror in the caller's wave. */
export async function loadMovedWarmBuilds(db: Db, mainHeads: Map<string, string>): Promise<number[]> { throw new Error("not built: build.loadMovedWarmBuilds"); }
/** The time the private clock started (confidential environments online), null when none. */
export async function loadConfidentialReadyAt(db: Db): Promise<number | null> { throw new Error("not built: build.loadConfidentialReadyAt"); }
/** The task row when it runs on this env, else a 404 or 409 HTTP error. */
export async function loadWorkerTask(db: Db, envId: string, id: number): Promise<TaskRecord> { throw new Error("not built: build.loadWorkerTask"); }
/** Recent cancels the worker must kill. */
export async function loadCancelIds(db: Db, envId: string, since: string): Promise<number[]> { throw new Error("not built: build.loadCancelIds"); }

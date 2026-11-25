// Enqueue, load, claim and list (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { HiddenRepos, JobRow, LiveJob, LogCursor, NewJob, QueuedJob, RunningState } from "./types.ts";

/** One `INSERT ... SELECT ... WHERE NOT EXISTS` (a queued job with the same step and params) `RETURNING id`; maps input index to job id, refused indexes are duplicates. Validation stays in feature code. */
export async function enqueueJobs(db: Db, jobs: NewJob[]): Promise<{ queued: Map<number, number>; refused: number[] }> {
  throw new Error("not built: jobs.enqueueJobs");
}

/** Job rows by id. */
export async function loadJobs(db: Db, ids: number[]): Promise<Map<number, JobRow>> {
  throw new Error("not built: jobs.loadJobs");
}

/** Page and total in one wave. */
export async function listJobs(db: Db, filter: { step?: string; state?: string; limit: number; offset: number; hidden?: HiddenRepos }): Promise<{ rows: JobRow[]; total: number }> {
  throw new Error("not built: jobs.listJobs");
}

/** Queued and running jobs. */
export async function loadLiveJobs(db: Db): Promise<LiveJob[]> {
  throw new Error("not built: jobs.loadLiveJobs");
}

/** Everything a runner tick reads, in one round trip of three statements. */
export async function loadRunnerTick(db: Db, nowMs: number): Promise<{ queued: QueuedJob[]; running: RunningState[]; logCursors: Map<number, LogCursor> }> {
  throw new Error("not built: jobs.loadRunnerTick");
}

/** One guarded `UPDATE ... WHERE state = 'queued' AND NOT EXISTS (...)`; false when no row changed. */
export async function claimJob(db: Db, c: { id: number; step: string; repo: string | null; number: number | null; cap: number | null; mutexSteps: string[]; logPath: string }): Promise<boolean> {
  throw new Error("not built: jobs.claimJob");
}

/** One `updateFrom`. */
export async function setPids(db: Db, rows: { id: number; pid: number }[]): Promise<number> {
  throw new Error("not built: jobs.setPids");
}

/** Fails queued jobs that cannot run (unknown step, no Task Runner). */
export async function failQueued(db: Db, rows: { id: number; error: string }[]): Promise<number> {
  throw new Error("not built: jobs.failQueued");
}

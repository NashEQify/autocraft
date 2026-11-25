// State writers; the cross-table orchestration is feature code `src/runner/lifecycle.ts` (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { JobFlags, JobPatch, JobPulse, JobResult, JobRow } from "./types.ts";

/** One `UPDATE ... WHERE state = 'queued' ... RETURNING`. */
export async function markCancelQueued(db: Db, where: { ids?: number[]; pipelineOnly?: boolean }, by: string): Promise<{ id: number; resumes: number }[]> {
  throw new Error("not built: jobs.markCancelQueued");
}

/** The running branch; `coalesce` keeps the first requester. */
export async function markCancelRequested(db: Db, ids: number[], by: string): Promise<number> {
  throw new Error("not built: jobs.markCancelRequested");
}

/** The guarded update of `resumeJob` over many ids; ids missing from the result did not resume. */
export async function markResumed(db: Db, rows: { id: number; kind: "graceful" | "crash" }[]): Promise<{ id: number; resumes: number; crash_resumes: number; log_path: string | null }[]> {
  throw new Error("not built: jobs.markResumed");
}

/** One `updateFrom`. */
export async function markEnded(db: Db, rows: { id: number; state: string; error: string | null; clearProgress: boolean }[]): Promise<number> {
  throw new Error("not built: jobs.markEnded");
}

/** Running jobs, for `recover`. */
export async function loadRunning(db: Db): Promise<{ id: number; pid: number | null; cancel_requested_at: string | null }[]> {
  throw new Error("not built: jobs.loadRunning");
}

/** One `UPDATE ... RETURNING` that writes progress or counts and returns the cancel flag, stop error and claim time. */
export async function pulseJob(db: Db, id: number, patch: JobPatch): Promise<JobFlags> {
  throw new Error("not built: jobs.pulseJob");
}

/** The final writes of `exec.ts` as one update; stats add to the four count columns so resumed runs accumulate. */
export async function recordResult(db: Db, id: number, r: JobResult): Promise<void> {
  throw new Error("not built: jobs.recordResult");
}

/** In-process cache over `pulseJob`: writes merge into the next pulse; `cancelled()` and `timeUp()` return the last flags when younger than `minMs`. */
export async function openJobPulse(db: Db, row: { id: number }, o: { minMs: number }): Promise<JobPulse> {
  throw new Error("not built: jobs.openJobPulse");
}

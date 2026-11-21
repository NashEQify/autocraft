// Jobs that a runner stop or restart interrupted go back to the queue under the same id (resumeJob in jobs.ts) and run
// again from the start. Their remote calls stay: the resumed run adopts the call it makes again with the same bundle
// (enqueueCall), and a reply a Task Runner sent meanwhile is read from the row. Their successful GitHub writes are not
// made again (src/github/write.ts). Local model calls and local steps simply run again.
import type { Db } from "../db/index.ts";

/** A job may resume this many times; a stop past that fails it with RUNNER_STOPPED. */
export const MAX_RESUMES = 2;
/** Jobs waiting in the queue to resume. */
export const RESUMING_JOBS = "SELECT id FROM main.jobs WHERE state = 'queued' AND resumes > 0";
/** Resumed jobs that have not ended: their earlier run's remote calls wait for adoption, with no caller polling them. */
export const RESUMED_JOBS = "SELECT id FROM main.jobs WHERE resumes > 0 AND state IN ('queued', 'running')";
/** Remote calls a resumed run may adopt: open, or answered and not yet read. */
export const ADOPTABLE_CALL = "state IN ('queued', 'leased', 'done') AND consumed_at IS NULL";
/** Agent runs of the adoptable calls of resuming jobs: they stay running until the resumed run reads the reply or the job ends. */
export const KEPT_RUNS = `SELECT run_id FROM main.remote_calls WHERE run_id IS NOT NULL AND ${ADOPTABLE_CALL} AND job_id IN (${RESUMING_JOBS})`;

/** For a job that resumed: when its current run started (work recorded before that belongs to an earlier run). Null for a job that never resumed. */
export async function resumedRun(db: Db, jobId: number): Promise<{ resumes: number; startedAt: string } | null> {
  const r = await db.prepare("SELECT resumes, started_at FROM main.jobs WHERE id = ?").get(jobId) as { resumes: number | null; started_at: string | null } | undefined;
  return r && Number(r.resumes) > 0 && r.started_at ? { resumes: Number(r.resumes), startedAt: r.started_at } : null;
}

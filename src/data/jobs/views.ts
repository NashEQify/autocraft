// Read models for dashboards, health and rates (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { Ref } from "../keys.ts";
import type { ActiveJob, DeadlineStop, FailedJob, HiddenRepos, ItemsByBucket, JobDetail, JobRow, JobState, JobStamp, LiveBoard, RefKey, StageState, StepRun } from "./types.ts";

/** Row, items and log tail in one wave; item states come from `mirror.loadShown` in the same wave. */
export async function loadJobDetail(db: Db, id: number, o: { hidden?: HiddenRepos; logs: boolean }): Promise<JobDetail | null> {
  throw new Error("not built: jobs.loadJobDetail");
}

/** Running, queued (limited) and recently ended jobs with their items; one round trip. */
export async function loadLiveBoard(db: Db, o: { quietSteps: string[]; recentMs: number; queuedMax: number; recentMax: number; hidden?: HiddenRepos }): Promise<LiveBoard> {
  throw new Error("not built: jobs.loadLiveBoard");
}

/** Recent run durations per step. */
export async function loadStepDurations(db: Db, steps: string[]): Promise<Map<string, number[]>> {
  throw new Error("not built: jobs.loadStepDurations");
}

/** Latest job per step (window). */
export async function loadLastJobPerStep(db: Db, steps: string[], hidden?: HiddenRepos): Promise<Map<string, JobRow>> {
  throw new Error("not built: jobs.loadLastJobPerStep");
}

/** Per stage: any running, any queued, last finished state; one grouped statement. */
export async function loadStageStates(db: Db, stages: { n: number; steps: string[] }[]): Promise<Map<number, StageState>> {
  throw new Error("not built: jobs.loadStageStates");
}

/** Grouped counts. */
export async function countJobs(db: Db, states: JobState[], hidden?: HiddenRepos): Promise<Map<JobState, number>> {
  throw new Error("not built: jobs.countJobs");
}

/** Queued or running jobs naming each item. */
export async function loadActiveJobsOfItems(db: Db, refs: Ref[]): Promise<Map<RefKey, ActiveJob[]>> {
  throw new Error("not built: jobs.loadActiveJobsOfItems");
}

/** Jobs that crashed before writing a `job_items` row. */
export async function loadFailedJobsOfItems(db: Db, refs: Ref[], since: string): Promise<Map<RefKey, FailedJob[]>> {
  throw new Error("not built: jobs.loadFailedJobsOfItems");
}

/** `row_number() OVER (PARTITION BY step ORDER BY id)` over queued jobs. */
export async function loadQueuePositions(db: Db, jobIds?: number[]): Promise<Map<number, number>> {
  throw new Error("not built: jobs.loadQueuePositions");
}

/** Count, newest id and state list of an item's jobs, for the page version stamp. */
export async function loadJobStamp(db: Db, repo: string, refs?: Ref[]): Promise<JobStamp> {
  throw new Error("not built: jobs.loadJobStamp");
}

/** The health checks' step history. */
export async function loadStepRuns(db: Db, o: { requestedBy: string; sinceDays: number; window: number }): Promise<StepRun[]> {
  throw new Error("not built: jobs.loadStepRuns");
}

/** Failed stop rows, last done id per step and `control.loadAuditMax` in one wave. */
export async function loadDeadlineStops(db: Db): Promise<DeadlineStop[]> {
  throw new Error("not built: jobs.loadDeadlineStops");
}

/** The jobs half of the rate chart. */
export async function loadItemsByBucket(db: Db, from: string, to: string, bucket: string, hidden?: HiddenRepos): Promise<ItemsByBucket[]> {
  throw new Error("not built: jobs.loadItemsByBucket");
}

/** Sum of `items` of jobs started since a per-step time. */
export async function loadItemsSince(db: Db, steps: string[], sinceByStep: Record<string, string>): Promise<Map<string, number>> {
  throw new Error("not built: jobs.loadItemsSince");
}

/** The CLI wait loop. */
export async function loadJobState(db: Db, id: number): Promise<{ state: JobState; summary: string | null; error: string | null } | null> {
  throw new Error("not built: jobs.loadJobState");
}

/** A job of the step running for the repo; key `step\0repo`. */
export async function isRunning(db: Db, probes: { step: string; repo: string }[]): Promise<Set<string>> {
  throw new Error("not built: jobs.isRunning");
}

// Query-count records (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { StatRow, StepQueryStat } from "./types.ts";

/** `INSERT ... ON CONFLICT (scope, minute) DO UPDATE` adding to the counters; the runner flushes once a minute, unmetered. */
export async function addStats(db: Db, rows: StatRow[]): Promise<void> {
  throw new Error("not built: jobs.addStats");
}

/** For the `query-growth` health check. */
export async function loadStepQueryStats(db: Db, sinceDays: number): Promise<StepQueryStat[]> {
  throw new Error("not built: jobs.loadStepQueryStats");
}

/** Deletes records older than the keep window. */
export async function pruneStats(db: Db, before: string): Promise<number> {
  throw new Error("not built: jobs.pruneStats");
}

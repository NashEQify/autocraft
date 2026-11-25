// reads: jobs.jobs
import type { Db } from "../../db/index.ts";
import type { RunningCounts } from "./types.ts";

/** Running Claude calls by job repo and by step, for the Task Runner claim order. One statement (`UNION ALL` of the two groupings); reads `jobs.repo`. */
export async function loadRunningCounts(db: Db, nowMs: number): Promise<RunningCounts> { throw new Error("not built: inference.loadRunningCounts"); }

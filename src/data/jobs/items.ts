// `job_items` writer and readers (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { HiddenRepos, ItemJobRow, JobItemRow, NewJobItem, RefKey } from "./types.ts";
import type { Ref } from "../keys.ts";

/** Multi-row insert, one statement per 500 rows. */
export async function addJobItems(db: Db, rows: NewJobItem[]): Promise<void> {
  throw new Error("not built: jobs.addJobItems");
}

/** Logs the tagged line at once and queues the row in a per-process buffer keyed by the current job; the buffer flushes through `addJobItems` at 50 rows, after 2 s, at `JobPulse.flush()` and at the job's end. A failed flush logs and keeps the rows. */
export async function noteJobItem(db: Db, repo: string, number: number, outcome: string, log: (line: string) => void): Promise<void> {
  throw new Error("not built: jobs.noteJobItem");
}

/** What each job handled. */
export async function loadJobItems(db: Db, jobIds: number[], o?: { hidden?: HiddenRepos }): Promise<Map<number, JobItemRow[]>> {
  throw new Error("not built: jobs.loadJobItems");
}

/** `job_items` joined to `jobs`, oldest first. */
export async function loadItemJobTrail(db: Db, refs: Ref[], o?: { states?: string[] }): Promise<Map<RefKey, ItemJobRow[]>> {
  throw new Error("not built: jobs.loadItemJobTrail");
}

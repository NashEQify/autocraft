// The job log copy (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { LogChunkRow, LogDrop, LogTail } from "./types.ts";

/** The `copyLogs` insert. */
export async function addLogChunks(db: Db, rows: Pick<LogChunkRow, "job_id" | "seq" | "chunk" | "at">[]): Promise<void> {
  throw new Error("not built: jobs.addLogChunks");
}

/** The `copyLogs` delete. */
export async function dropLogChunks(db: Db, drops: LogDrop[]): Promise<number> {
  throw new Error("not built: jobs.dropLogChunks");
}

/** `DELETE ... WHERE at < ?` limited by a subselect on `(job_id, seq)`. */
export async function pruneLogChunks(db: Db, before: string, limit: number): Promise<number> {
  throw new Error("not built: jobs.pruneLogChunks");
}

/** The kept chunks of one job, newest first, stopping at `bytes` through a window sum of `octet_length`. */
export async function loadLogTail(db: Db, job: number, bytes: number): Promise<LogTail | null> {
  throw new Error("not built: jobs.loadLogTail");
}

/** Finished jobs older than the keep window. */
export async function loadPrunable(db: Db, before: string, limit: number): Promise<{ id: number; log_path: string | null }[]> {
  throw new Error("not built: jobs.loadPrunable");
}

/** Deletes items, chunks and jobs, three statements per batch of 1,000; one `db.write`. The caller unlinks log files first. */
export async function removeJobs(db: Db, ids: number[]): Promise<number> {
  throw new Error("not built: jobs.removeJobs");
}

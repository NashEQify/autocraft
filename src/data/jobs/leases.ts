// Work leases (M07 jobs).
import type { Db } from "../../db/index.ts";

/** One statement; returns the keys taken (free, held by the same job, or held by a job that is not running). */
export async function takeLeases(db: Db, keys: string[], job: { id: number; step: string }): Promise<Set<string>> {
  throw new Error("not built: jobs.takeLeases");
}

/** Releases leases. */
export async function releaseLeases(db: Db, o: { keys: string[]; jobId: number } | { jobIds: number[] }): Promise<number> {
  throw new Error("not built: jobs.releaseLeases");
}

/** `recover` clears every lease. */
export async function clearLeases(db: Db): Promise<number> {
  throw new Error("not built: jobs.clearLeases");
}

/** Keys held by running jobs. */
export async function loadHeldLeaseKeys(db: Db): Promise<Set<string>> {
  throw new Error("not built: jobs.loadHeldLeaseKeys");
}

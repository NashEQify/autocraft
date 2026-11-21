// Work leases: one job at a time works a PR, issue or finding. Rows are bookkeeping (not a planner input topic).
// A lease whose job is not running counts as free, so a crash leaves nothing behind.
import { currentJob } from "../agents/call.ts";
import type { Db } from "../db/index.ts";

let skipped = 0;
/** Items this process skipped because another job held their lease. */
export const leaseSkips = (): number => skipped;
const skippedKeys = new Set<string>();
/** The lease keys this process skipped, at most 500. */
export const leaseSkipKeys = (): string[] => [...skippedKeys];

/** The prefix of the skip key of a call withdrawn for lack of a taker: no lease; the planner's taker signature wakes the step. */
export const NO_TAKER_SKIP = "no-taker:";

/** Counts an item left for a later job (like a held lease) so the planner retries it, and logs why. */
export function skipItem(key: string, log: (line: string) => void, why: string): void {
  skipped++;
  if (skippedKeys.size < 500) skippedKeys.add(key);
  log(`  ${key}: skipped: ${why}`);
}

/** Takes the lease for the job. False when another running job holds it. */
export async function take(db: Db, key: string, jobId: number, step: string): Promise<boolean> {
  return await db.write(async () => {
    const held = await db.prepare("SELECT l.job_id AS job, j.state AS state FROM work_leases l LEFT JOIN jobs j ON j.id = l.job_id WHERE l.key = ?").get(key) as { job: number; state: string | null } | undefined;
    if (held && held.job !== jobId && held.state === "running") return false;
    await db.prepare("INSERT OR REPLACE INTO work_leases (key, job_id, step, taken_at) VALUES (?, ?, ?, ?)").run(key, jobId, step, new Date().toISOString());
    return true;
  });
}

export async function release(db: Db, key: string, jobId: number): Promise<void> {
  await db.prepare("DELETE FROM work_leases WHERE key = ? AND job_id = ?").run(key, jobId);
}

export async function releaseJob(db: Db, jobId: number): Promise<void> {
  await db.prepare("DELETE FROM work_leases WHERE job_id = ?").run(jobId);
}

/**
 * Leases the item for the job this process runs and returns what ends the lease, or null (one line logged) when
 * another running job holds it: the caller skips the item without counting it. Outside a job (command line) there is
 * no holder to record, so the item is free. Call it once per item at the outermost site. Takes of one key do not nest: the same job may take a key it holds, but the inner release frees the outer lease too.
 */
export async function leaseItem(db: Db, key: string, log: (line: string) => void): Promise<(() => Promise<void>) | null> {
  const job = currentJob();
  if (!job) return async () => {};
  if (!await take(db, key, job.id, job.step)) {
    skipItem(key, log, "another job is working it");
    return null;
  }
  return async () => await release(db, key, job.id);
}

// The items a job handled, for the item page: one job_items row per item, and the same line in the job log
// prefixed with the item ref, so a log parser can pick an item's lines out of the job log.
import { currentJobId } from "../agents/call.ts";
import type { Db } from "../db/index.ts";

/** `[owner/repo#n]`, the prefix of a job log line about one item. */
export const itemTag = (repo: string, number: number): string => `[${repo}#${number}]`;

/**
 * Records that the running job handled an item and logs the outcome (one line) under the item's tag. Stage code calls it once
 * per item it handled. `decision` is the id of the decision the job asked about the item. Outside a job (a dry run, a direct command) nothing is stored; the line is still logged.
 */
export async function jobItem(db: Db, repo: string, number: number, outcome: string, log: (line: string) => void = console.log, decision: string | null = null): Promise<void> {
  const line = outcome.replace(/\s+/g, " ").trim().slice(0, 300);
  log(`${itemTag(repo, number)} ${line}`);
  const job = currentJobId();
  if (job === null) return;
  // Bookkeeping: a failed insert must not fail the stage.
  try {
    await db.run(db.k.insertInto("job_items").values({ job_id: job, repo, number, outcome: line, at: new Date().toISOString(), ref: decision }));
  } catch (e) {
    log(`job item not recorded: ${(e as Error).message}`);
  }
}

export type ItemJob = { jobId: number; outcome: string | null; at: string };

/** The jobs that handled an item, oldest first. */
export async function itemJobs(db: Db, repo: string, number: number): Promise<ItemJob[]> {
  return (await db.all(db.k.selectFrom("job_items").select(["job_id", "outcome", "at"]).where("repo", "=", repo).where("number", "=", number).orderBy("id")))
    .map((r) => ({ jobId: r.job_id, outcome: r.outcome, at: r.at }));
}

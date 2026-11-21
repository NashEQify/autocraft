// `autocraft-server runner exec <id>`: runs one claimed job in the runner's child
// process. Writes progress, the summary or the error, and the job's model
// usage; the runner sets the final state from the exit code.
import type { JobUsage } from "../../web/src/api/types.ts";
import { NoTakerError, setCallContext, StoppedError } from "../agents/call.ts";
import { trackedNames } from "../repos.ts";
import { AUTOPILOT_USER, isDraining, isEnabled } from "./autopilot.ts";
import { leaseSkipKeys, leaseSkips } from "./leases.ts";
import { DEADLINE_ERROR, jobRow, scrub, type JobRow } from "./jobs.ts";
import { loadSteps, validateParams, type StepContext } from "./steps.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { stopWrites } from "../github/write.ts";

/** How long a stopping job waits for its GitHub writes in flight: inside the runner's 10 s before SIGKILL, with time left to record usage. */
const WRITE_SETTLE_MS = 7000;

const oneLine = (s: string, max = 500): string => scrub(s.replace(/\s+/g, " ").trim()).slice(0, max);

async function usageOf(db: Db, runs: Set<string>, since: string): Promise<JobUsage | null> {
  if (!runs.size) return null;
  const marks = [...runs].map(() => "?").join(",");
  const r = await db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
    SUM(cost_usd) AS cost FROM token_usage WHERE run_id IN (${marks}) AND started_at >= ?`).get(...runs, since) as
    { calls: number; input: number; output: number; cost: number | null };
  return { calls: r.calls, input: r.input, output: r.output, costUsd: r.cost };
}

export async function execJob(id: number): Promise<number> {
  const db = await openDb();
  const row = await jobRow(db, id);
  if (!row || row.state !== "running" || !row.started_at) {
    console.error(`job ${id} is not running`);
    return 2;
  }
  const startedAt = row.started_at;
  const runs = new Set<string>();
  // A resumed job (src/runner/resuming.ts) adds this run's calls to those of its earlier runs.
  let before: JobUsage | null = null;
  try { before = row.resumes && row.usage ? JSON.parse(row.usage) as JobUsage : null; } catch { /* unreadable: this run's alone */ }
  const itemsBefore = row.resumes ? Number(row.items ?? 0) : 0, actedBefore = row.resumes ? Number(row.acted ?? 0) : 0;
  const saveUsage = async () => {
    const u = await usageOf(db, runs, startedAt);
    const all = u && before ? { calls: before.calls + u.calls, input: before.input + u.input, output: before.output + u.output, costUsd: before.costUsd === null && u.costUsd === null ? null : (before.costUsd ?? 0) + (u.costUsd ?? 0) } : u;
    if (all) await db.prepare("UPDATE jobs SET usage = ? WHERE id = ?").run(JSON.stringify(all), id);
  };
  const fail = async (msg: string): Promise<number> => {
    await saveUsage();
    await db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(oneLine(msg), id);
    console.error(`failed: ${msg}`);
    return 1;
  };
  // The runner signals this process alone: GitHub writes in flight finish and are recorded, and a write asked for now is
  // not made (its caller waits, and a resumed run makes it); then the rest of the job's process group (model calls,
  // builds) is stopped. The process exits 143, or with the step's own code when the step returned during the stop.
  const ran: { code: number | null; stop: Promise<void> | null } = { code: null, stop: null };
  let stepEnded = (): void => {};
  const ended = new Promise<void>((r) => { stepEnded = r; });
  process.once("SIGTERM", () => {
    ran.stop = (async () => {
      const left = await stopWrites("the job is stopping", WRITE_SETTLE_MS, ended);
      if (left) console.log(`${left} GitHub writes still running at the stop; their outcome is unknown`);
      if (ran.code === null) {
        await saveUsage();
        console.log("stopped");
      }
      process.on("SIGTERM", () => {});
      try { process.kill(-process.pid, "SIGTERM"); } catch { /* not a group leader (a command-line run) */ }
      process.exit(ran.code ?? 143);
    })();
  });
  const code = await runJob(db, id, row, { runs, saveUsage, fail, itemsBefore, actedBefore });
  ran.code = code;
  stepEnded();
  // Stopping: the handler exits once the writes in flight are recorded.
  if (ran.stop) await ran.stop;
  return code;
}

/** Runs the job's step in this process; returns the exit code. */
async function runJob(db: Db, id: number, row: JobRow, o: { runs: Set<string>; saveUsage: () => Promise<void>; fail: (msg: string) => Promise<number>; itemsBefore: number; actedBefore: number }): Promise<number> {
  const { runs, saveUsage, fail, itemsBefore, actedBefore } = o;
  const startedAt = row.started_at!;
  const step = (await loadSteps()).get(row.step);
  if (!step) return await fail(`no step ${row.step} in this build`);
  console.log(`${new Date().toISOString()} job ${id}: ${step.name} ${row.params}, requested by ${row.requested_by}`);
  let params;
  try {
    params = validateParams(step, JSON.parse(row.params), await trackedNames(db));
    const why = step.available?.() ?? (step.check ? await step.check(db, params) : null);
    if (why) return await fail(why);
  } catch (e) {
    return await fail((e as Error).message);
  }

  let lastProgress = 0;
  const ctx: StepContext = {
    db,
    job: { id, requestedBy: row.requested_by, startedAt, resumes: Number(row.resumes ?? 0) },
    params,
    async progress(text) {
      const t = Date.now();
      if (t - lastProgress < 1000) return;
      lastProgress = t;
      await db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(oneLine(text, 200), id);
      console.log(text);
    },
    log: (line) => console.log(line),
    usageRun: (r) => void runs.add(r),
    // Counts of a resumed job add to its earlier runs', so the daily limits see all of them.
    handled: async (n) => void await db.prepare("UPDATE jobs SET items = ? WHERE id = ?").run(itemsBefore + n, id),
    acted: async (n) => void await db.prepare("UPDATE jobs SET acted = ? WHERE id = ?").run(actedBefore + n, id),
    cancelled: async () => {
      const r = await db.prepare("SELECT cancel_requested_at, error FROM jobs WHERE id = ?").get(id) as { cancel_requested_at: string | null; error: string | null };
      return !!r.cancel_requested_at || DEADLINE_ERROR.test(r.error ?? "");
    },
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !await isEnabled(db)),
  };
  setCallContext({ jobId: id, step: step.name, stage: step.stage, class: step.priority ?? 0, ...(typeof params.repo === "string" && { repo: params.repo }), cancelled: ctx.cancelled,
    // Model calls (local and remote) are withdrawn when the pipeline is switched off, not during a drain: running jobs finish with their calls.
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !await isEnabled(db) && !await isDraining(db)) });
  try {
    const summary = await step.run(ctx);
    await saveUsage();
    // Items skipped for a lease are work left for a later job: the planner retries once no job holds a lease (unchangedSinceIdle).
    if (leaseSkips()) await db.prepare("UPDATE jobs SET lease_skips = ?, lease_skip_keys = ? WHERE id = ?").run(leaseSkips(), JSON.stringify(leaseSkipKeys()), id);
    await db.prepare("UPDATE jobs SET summary = ? WHERE id = ?").run(oneLine(summary), id);
    console.log(`${new Date().toISOString()} done: ${summary}`);
    return 0;
  } catch (e) {
    if (e instanceof StoppedError || e instanceof NoTakerError) {
      await saveUsage();
      if (leaseSkips()) await db.prepare("UPDATE jobs SET lease_skips = ?, lease_skip_keys = ? WHERE id = ?").run(leaseSkips(), JSON.stringify(leaseSkipKeys()), id);
      const summary = e instanceof NoTakerError ? `skipped: ${e.message}` : "stopped: the pipeline was switched off";
      await db.prepare("UPDATE jobs SET summary = ? WHERE id = ?").run(summary, id);
      console.log(`${new Date().toISOString()} done: ${summary}`);
      return 0;
    }
    console.error((e as Error).stack ?? e);
    return await fail((e as Error).message ?? String(e));
  }
}

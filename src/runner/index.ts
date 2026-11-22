// autocraft-server runner serve | exec | enqueue | jobs | cancel | steps; autocraft-server pipeline on | off | status | limit
import { readSecrets } from "../dash/server/config.ts";
import { writeSetting } from "../settings-read.ts";
import { resumeStage, TripError } from "../push-outcomes.ts";
import { startWorkerServer } from "../build/worker-api.ts";
import { startPodLauncher } from "../build/launcher.ts";
import { acquireLock } from "../mirror.ts";
import { audit } from "../dash/audit.ts";
import { scopeToTracked } from "../repos.ts";
import { convertOpenDecisionsOnce } from "../decide/choices-convert.ts";
import { linkRepeatedFindings } from "../security/scan.ts";
import { autoFixConfirmed } from "../security/actions.ts";
import { execJob } from "./exec.ts";
import { isDraining, isEnabled, LimitError, pipelineState, resetLimitCount, setEnabled, setLimit } from "./autopilot.ts";
import { PilotError, pilotItems, setPilot } from "../pilot.ts";
import { enqueue, JobError, listJobs, requestCancel } from "./jobs.ts";
import { MIN_INTERVAL_KEY, reviewMinInterval, setReviewMinInterval } from "../review/gate.ts";
import { PICK_MINUTES_KEY, pickMinutes, setPickMinutes } from "../remote/picks.ts";
import { ParallelError, setStepParallel, stepParallelSetting } from "./concurrency.ts";
import { DEFAULT_MAX_JOBS, Runner, runnerLockPath } from "./runner.ts";
import { loadSteps } from "./steps.ts";
import { dropPlanChanges } from "../db/sqlite-backfill.ts";
import { dbReady, startHealthServer } from "../health.ts";
import { envVar } from "../env.ts";
import { startDiscord } from "../discord/index.ts";
import { openDb, setDbRole } from "../db/open.ts";
import { openAppKeys } from "../github/app-keys.ts";

const USAGE = `usage: autocraft-server runner serve
       autocraft-server runner steps
       autocraft-server runner enqueue <step> [--<param> <value> ...]
       autocraft-server runner jobs [--state queued|running|done|failed|cancelled] [--limit N]
       autocraft-server runner cancel <job id>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function serve(): Promise<void> {
  const lock = runnerLockPath();
  const release = acquireLock(lock);
  if (!release) die("another runner is running on this database");
  setDbRole("runner");
  const db = await openDb();
  await scopeToTracked(db);
  // The GitHub App's keys, from the database (imported once from the secrets file).
  await openAppKeys(db).catch((e: Error) => console.error(`runner: GitHub App keys not read: ${e.message}`));
  // Once per database: open decisions' proposed cards become choices. Here rather than in db.ts migrations, which cannot import the decision modules.
  const conv = await convertOpenDecisionsOnce(db);
  if (conv) console.log(`runner: converted ${conv.converted} open decisions to choices (${conv.skipped} skipped, ${conv.stale} stale cards, ${conv.unconverted} cards matching no choice)`);
  for (const note of conv?.notes ?? []) console.log(`runner: choices conversion: ${note}`);
  const linked = await linkRepeatedFindings(db);
  if (linked) console.log(`runner: linked ${linked} security findings to the earlier findings they repeat`);
  const fixes = await autoFixConfirmed(db);
  if (fixes) console.log(`runner: started the private fix of ${fixes} confirmed security findings`);
  const runner = new Runner({ db, lockFile: lock, maxJobs: Number(envVar("RUNNER_JOBS")) || DEFAULT_MAX_JOBS });
  const ac = new AbortController();
  process.once("SIGTERM", () => ac.abort());
  process.once("SIGINT", () => ac.abort());
  console.log(`runner: started on ${(await loadSteps()).size} steps`);
  // A failure to listen (port in use) must not stop the pipeline; workers just cannot connect.
  // The session key signs the dashboard's requests for the runner's files (build artifacts, Claude accounts).
  let internalKey: string | null = null;
  try { internalKey = readSecrets(envVar("SECRETS_FILE")).sessionKey; } catch (e) { console.error(`runner: dashboard requests are refused: ${(e as Error).message}`); }
  const workers = await startWorkerServer({ db, internalKey, log: (l) => console.log(l) }).then(
    (w) => (console.log(`runner: worker API on ${w.url}`), w),
    (e: Error) => (console.error(`runner: worker API not started: ${e.message}`), null),
  );
  // Starts and follows the build pods of kubernetes environments; outside a cluster they report that they cannot.
  startPodLauncher(db, ac.signal, (l) => console.log(l));
  // Optional: counts Discord mentions of tracked items when a bot token file is configured. A failure is logged and never stops the runner.
  try {
    await startDiscord(db, ac.signal, (l) => console.log(l));
  } catch (e) {
    console.error(`runner: Discord not started: ${(e as Error).message}`);
  }
  // Optional listener for the probes alone, for a runner whose worker API is not reachable by the prober.
  const healthListen = envVar("HEALTH_LISTEN");
  const health = healthListen
    ? await startHealthServer(healthListen, async () => await dbReady(db)).then(
        (h) => (console.log(`runner: health endpoints on ${h.url}`), h),
        (e: Error) => (console.error(`runner: health listener not started: ${e.message}`), null),
      )
    : null;
  // On a stop signal the runner claims nothing new and stops its jobs (10 s each to end, then killed). If that takes longer than the bound, exit anyway.
  const stopMs = (Number(envVar("STOP_TIMEOUT")) || 25) * 1000;
  // process.exit joins the worker threads, and a thread inside one long synchronous call cannot be terminated until the call returns: kill the process instead (the database is in WAL mode and survives it).
  const onStop = () => void setTimeout(() => (console.error("runner: stop timed out; exiting"), release(), process.kill(process.pid, "SIGKILL")), stopMs).unref();
  if (ac.signal.aborted) onStop();
  else ac.signal.addEventListener("abort", onStop, { once: true });
  try {
    await runner.serve(ac.signal, Number(envVar("RUNNER_POLL_MS")) || 2000);
  } finally {
    await health?.close();
    await workers?.close();
    release();
    await db.close();
  }
  console.log("runner: stopped");
}

async function exec(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) die(USAGE);
  process.exit(await execJob(id));
}

async function steps(): Promise<void> {
  for (const s of (await loadSteps()).values()) {
    const why = s.available?.();
    console.log(`${s.name.padEnd(16)} ${s.title}${why ? ` (${why})` : ""}`);
    for (const p of s.params) console.log(`  --${p.name.padEnd(12)} ${p.kind}${p.kind === "enum" ? ` ${p.options.join("|")}` : p.kind === "int" ? ` ${p.min}..${p.max}` : ""}${p.required ? " (required)" : ""}`);
  }
}

// Recorded as `cli`: only someone with a shell on the host can run this.
async function enqueueCmd(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) die(USAGE);
  const step = (await loadSteps()).get(name) ?? die(`no step ${name}`);
  const params: Record<string, string | number> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "") ?? "";
    const p = step.params.find((x) => x.name === k);
    if (!p || rest[i + 1] === undefined) die(`unknown or incomplete option ${rest[i]}`);
    params[k] = p.kind === "int" ? Number(rest[i + 1]) : rest[i + 1]!;
  }
  const db = await openDb();
  await scopeToTracked(db);
  // The GitHub App's keys, from the database (imported once from the secrets file).
  await openAppKeys(db).catch((e: Error) => console.error(`runner: GitHub App keys not read: ${e.message}`));
  try {
    const job = await enqueue(db, name, params, "cli");
    console.log(`job ${job.id} queued: ${job.step} ${JSON.stringify(job.params)}`);
  } catch (e) {
    if (e instanceof JobError) die(e.message);
    throw e;
  }
}

async function jobs(args: string[]): Promise<void> {
  const state = args[args.indexOf("--state") + 1];
  const limit = Number(args[args.indexOf("--limit") + 1]) || 20;
  const list = await listJobs(await openDb(), { state: args.includes("--state") ? (state as never) : undefined, limit });
  for (const j of list.jobs) {
    console.log(`${String(j.id).padStart(5)} ${j.state.padEnd(9)} ${j.step.padEnd(16)} ${j.requestedAt.slice(0, 16)} ${j.requestedBy.padEnd(12)} ${j.summary ?? j.error ?? j.progress ?? ""}`);
  }
}

async function cancel(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) die(USAGE);
  try {
    const j = await requestCancel(await openDb(), id, "cli");
    console.log(`job ${id}: ${j.state === "cancelled" ? "cancelled" : "cancel requested"}`);
  } catch (e) {
    if (e instanceof JobError) die(e.message);
    throw e;
  }
}

const SUB: Record<string, (args: string[]) => Promise<void> | void> = { serve, exec, steps, enqueue: enqueueCmd, jobs, cancel };

export const commands = {
  pipeline: { summary: "pipeline switch and limits: on | off | drain | status | limit <step> --per-day N | resume <stage>", run: (args: string[]) => pipeline(args) },
  runner: {
    summary: "pipeline runner: serve | steps | enqueue | jobs | cancel",
    run: async (args: string[]) => {
      const f = args[0] ? SUB[args[0]] : undefined;
      if (!f) die(USAGE);
      await f(args.slice(1));
    },
  },
  "plan-log": {
    summary: "the incremental planner's change log: status | shadow on|off (compare every incremental pass with a full load) | drop (before a rollback to a release without it)",
    run: async (args: string[]) => await planLog(args),
  },
};

async function planLog(args: string[]): Promise<void> {
  const db = await openDb();
  if (args[0] === "status") {
    console.log(JSON.stringify({
      logged: (await db.get(db.k.selectFrom("main.item_changes").select((eb) => eb.fn.countAll<number>().as("n"))))!.n,
      passes: await db.all(db.k.selectFrom("main.plan_pass_stats").select(["kind", "passes", "refs", "ms", "max_ms", "last_at"]).orderBy("kind")),
      fullCauses: await db.all(db.k.selectFrom("main.plan_full_causes").select(["source", "n"]).orderBy("n", "desc").limit(10)),
      shadowDiffs: (await db.get(db.k.selectFrom("main.plan_shadow_diffs").select((eb) => eb.fn.countAll<number>().as("n"))))!.n,
    }, null, 2));
    return;
  }
  if (args[0] === "shadow" && (args[1] === "on" || args[1] === "off")) {
    await writeSetting(db, "plan_shadow", args[1]);
    console.log(`plan shadow ${args[1]}`);
    return;
  }
  if (args[0] === "drop") {
    console.log(`dropped ${await dropPlanChanges(db)} triggers and the change log; the next connect migrates the schema`);
    return;
  }
  die("usage: autocraft-server plan-log status | shadow on|off | drop");
}

const PIPELINE_USAGE = `usage: autocraft-server pipeline on [--if-draining] | off | drain | status
       autocraft-server pipeline limit <step> --per-day <N|none>
       autocraft-server pipeline limit reset <step>|--all
       autocraft-server pipeline parallel [<N|none>]
       autocraft-server pipeline review-interval [<minutes>]
       autocraft-server pipeline pick-minutes [<minutes>]
       autocraft-server pipeline resume <fixup|cifix|fixissue|merge>
       autocraft-server pipeline pilot set <repo#number>... | show | clear`;

// Recorded as `cli`: only someone with a shell on the host can run this.
async function pipeline(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const db = await openDb();
  const mode = await isEnabled(db) ? "on" : await isDraining(db) ? "drain" : "off";
  if ((sub === "drain" && mode === "off") || (sub === "on" && rest[0] === "--if-draining" && mode !== "drain")) {
    // A deploy drains from On only and ends only a drain it started: an operator's Off stays Off.
    if (sub === "drain") die(`pipeline is OFF; not draining`);
    console.log(`pipeline is ${mode === "on" ? "ON" : "OFF"}; left as it is`);
    return;
  }
  if (sub === "on" || sub === "off" || sub === "drain") {
    await setEnabled(db, sub === "on", "cli", sub === "drain" ? "drain" : "off");
    await audit(db, "cli", "pipeline-switch", "pipeline", { enabled: sub === "on", ...(sub === "drain" && { draining: true }) });
    console.log(`pipeline ${sub}`);
  } else if (sub === "parallel") {
    if (rest.length > 1) die(PIPELINE_USAGE);
    try {
      if (rest[0] !== undefined) await setStepParallel(db, rest[0], "cli");
    } catch (e) {
      if (e instanceof ParallelError) die(e.message);
      throw e;
    }
    console.log(`step_parallel ${await stepParallelSetting(db)}`);
    return;
  } else if (sub === "review-interval") {
    if (rest.length > 1) die(PIPELINE_USAGE);
    try {
      if (rest[0] !== undefined) await setReviewMinInterval(db, rest[0], "cli");
    } catch (e) {
      die((e as Error).message);
    }
    console.log(`${MIN_INTERVAL_KEY} ${await reviewMinInterval(db)}`);
    return;
  } else if (sub === "pick-minutes") {
    if (rest.length > 1) die(PIPELINE_USAGE);
    try {
      if (rest[0] !== undefined) await setPickMinutes(db, rest[0], "cli");
    } catch (e) {
      die((e as Error).message);
    }
    console.log(`${PICK_MINUTES_KEY} ${await pickMinutes(db)}`);
    return;
  } else if (sub === "resume") {
    if (rest.length !== 1) die(PIPELINE_USAGE);
    try {
      await resumeStage(db, rest[0]!, "cli");
      console.log(`${rest[0]} resumed`);
    } catch (e) {
      if (e instanceof TripError) die(e.message);
      throw e;
    }
  } else if (sub === "limit" && rest[0] === "reset") {
    const target = rest[1] === "--all" ? "all" : rest[1];
    if (!target || rest.length > 2) die(PIPELINE_USAGE);
    try {
      const { steps } = await resetLimitCount(db, target, "cli");
      console.log(`reset today's count of ${steps.length === 1 ? steps[0] : `${steps.length} stages`}`);
    } catch (e) {
      if (e instanceof LimitError) die(e.message);
      throw e;
    }
  } else if (sub === "limit") {
    const step = rest[0], n = rest[rest.indexOf("--per-day") + 1];
    if (!step || rest.indexOf("--per-day") < 0 || n === undefined) die(PIPELINE_USAGE);
    try {
      await setLimit(db, step, { perDay: n === "none" ? null : Number(n) }, "cli");
    } catch (e) {
      if (e instanceof LimitError) die(e.message);
      throw e;
    }
  } else if (sub === "pilot") {
    const [action, ...refs] = rest;
    if (action === "set" && refs.length) {
      try {
        await setPilot(db, "cli", refs);
      } catch (e) {
        if (e instanceof PilotError) die(e.message);
        throw e;
      }
    } else if (action === "clear") await setPilot(db, "cli", []);
    else if (action !== "show") die(PIPELINE_USAGE);
    const p = await pilotItems(db);
    console.log(p.length ? `pilot: ${p.length} items: ${p.join(" ")}` : "no pilot");
    return;
  } else if (sub !== "status") die(PIPELINE_USAGE);
  const s = await pipelineState(db);
  console.log(`pipeline ${s.enabled ? "ON" : s.draining ? "DRAINING" : "OFF"}${s.changedAt ? ` (set by ${s.changedBy} at ${s.changedAt.slice(0, 16)})` : ""}`);
  for (const l of s.limits) {
    console.log(`${l.step.padEnd(14)} ${String(l.usedToday).padStart(5)} / ${l.perDay === null ? "no limit" : l.perDay}${l.pausedReason ? `  ${l.pausedReason}` : ""}`);
  }
}

// The Live board on Home: every running and queued unit of the pipeline's work (jobs, model calls and build tasks of their own, open
// integration batches) on one time axis, with the model calls and build steps inside it and how long the same work took before. Jobs that
// ended in the last minutes stay on it, faded. Repos the reader cannot see are left out as on the Now page (src/dash/api/now.ts); account
// labels are for operators only.
import type { ItemRef, ItemShown, LiveBoard, LiveEstimate, LiveLane, LiveOp, LiveOpKind } from "../../../web/src/api/types.ts";
import { privateStepExpr } from "../../build/tasks.ts";
import { touchesHiddenExpr } from "../../agents/runs.ts";
import { filtered, hiddenTestExpr, type HiddenRepos } from "../../hidden-sql.ts";
import type { Req } from "../types.ts";
import { QUIET_STEPS } from "./now.ts";
import { shownLookup } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { stepTitle } from "./trace.ts";
import { blankIfHidden, hiddenRepos } from "./visible.ts";
import { flatMapSeq, mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";
import type { Eb } from "../../db/kx.ts";

/** Ended jobs stay on the board this long. */
const RECENT_MS = 20 * 60_000;
const RECENT_MAX = 8;
const QUEUED_MAX = 6;
/** Earlier runs an estimate is read from. */
const SAMPLES = 60;
/** Fewer earlier runs than this give no estimate. */
const MIN_SAMPLES = 3;

/** `col` is not in a hidden repo (or is null, with `nullOk`). */
const notHidden = (db: Db, eb: Eb, col: string, hidden: HiddenRepos, nullOk = false) => {
  const not = eb.not(hiddenTestExpr(db, col, hidden));
  return nullOk ? eb.or([eb(col, "is", null), not]) : not;
};

/** Median and 90th percentile of durations in ms; null with too few. */
function estimateOf(ms: number[]): LiveEstimate | null {
  const xs = ms.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < MIN_SAMPLES) return null;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { median: at(0.5), p90: at(0.9), samples: xs.length };
}

/** A build step's kind from its name, as the timeline colours it. */
export function buildKind(name: string): LiveOpKind {
  const n = name.toLowerCase();
  if (/test|spec|jest|vitest|pytest/.test(n)) return "tests";
  if (/lint|clippy|eslint|fmt|format|check|typecheck|tsc/.test(n)) return "lint";
  if (/build|compile|bundle|package|make/.test(n)) return "build";
  if (/install|setup|fetch|checkout|clone|deps|restore|cache|prepare|\bci\b/.test(n)) return "setup";
  return "other";
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The milliseconds from `started_at` to `ended_at`. */
const durationMs = (eb: Eb) => eb(eb.parens(eb.fn<number>("julianday", ["ended_at"]), "-", eb.fn<number>("julianday", ["started_at"])), "*", eb.lit(86400000));

export async function live(db: Db, req: Req): Promise<LiveBoard> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const nowMs = Date.now();
  const shown = shownLookup(db);
  const item = async (repo: string, number: number): Promise<ItemRef & ItemShown> => ({ repo, number, ...await shown(repo, number) });

  // Estimates, read once per key.
  const memo = new Map<string, LiveEstimate | null>();
  const memoized = async (key: string, read: () => Promise<number[]>) => (memo.has(key) ? memo.get(key)! : memo.set(key, estimateOf(await read())).get(key)!);
  const jobEstimate = async (step: string) => await memoized(`job:${step}`, async () =>
    (await db.all(db.k.selectFrom("jobs").select((eb) => durationMs(eb).as("ms")).where("step", "=", step).where("state", "=", "done").where("started_at", "is not", null).where("ended_at", "is not", null)
      .orderBy("id", "desc").limit(SAMPLES))).map((r) => r.ms));
  const callEstimate = async (step: string, model: string) => await memoized(`call:${step}:${model}`, async () =>
    (await db.all(db.k.selectFrom("agent_runs").select((eb) => durationMs(eb).as("ms")).where("step", "=", step).where("model", "=", model).where("state", "=", "done").where("ended_at", "is not", null)
      .orderBy("id", "desc").limit(SAMPLES))).map((r) => r.ms));
  const taskEstimate = async (repo: string, step: string) => await memoized(`task:${repo}:${step}`, async () =>
    (await db.all(db.k.selectFrom("build_tasks").select((eb) => durationMs(eb).as("ms")).where("repo", "=", repo).where("step", "=", step).where("state", "=", "done").where("started_at", "is not", null).where("ended_at", "is not", null)
      .orderBy("id", "desc").limit(SAMPLES))).map((r) => r.ms));

  type Call = { id: number; job_id: number | null; step: string; model: string; provider: string; label: string | null; started_at: string; ended_at: string | null; state: string; progress: string | null };
  const callOp = async (c: Call): Promise<LiveOp> => ({
    kind: "model", label: c.provider === "jev" ? "Jev" : c.model, detail: c.provider !== "jev" && req.user.role === "operator" ? `${stepTitle(c.step)} on ${c.label ?? "an unknown account"}` : stepTitle(c.step),
    start: c.started_at, end: c.ended_at, estimate: c.state === "running" ? await callEstimate(c.step, c.model) : null, ...(c.state === "failed" ? { failed: true } : {}),
  });
  type Task = { id: number; job_id: number | null; step: string; repo: string; number: number | null; state: string; queued_at: string; started_at: string | null; ended_at: string | null; results: string; summary: string | null; current: string | null };
  /** A finished task as one op per step (from its recorded durations); a running one as one op named by the step its log is on. */
  const taskOps = async (t: Task): Promise<LiveOp[]> => {
    if (!t.started_at) return [];
    const start = Date.parse(t.started_at);
    if (t.ended_at) {
      let results: { step: string; durationMs: number; exitCode: number | null }[] = [];
      try { results = JSON.parse(t.results) as typeof results; } catch { /* none */ }
      if (!results.length) return [{ kind: "build", label: "Build task", detail: stepTitle(t.step), start: t.started_at, end: t.ended_at, estimate: null, ...(t.state !== "done" ? { failed: true } : {}) }];
      let at = start;
      return results.map((r) => {
        const op: LiveOp = { kind: buildKind(r.step), label: r.step, detail: stepTitle(t.step), start: iso(at), end: iso(at + r.durationMs), estimate: null, ...(r.exitCode !== 0 ? { failed: true } : {}) };
        at += r.durationMs;
        return op;
      });
    }
    return [{ kind: t.current ? buildKind(t.current) : "build", label: t.current ?? "Build task", detail: stepTitle(t.step), start: t.started_at, end: null, estimate: await taskEstimate(t.repo, t.step) }];
  };
  const taskQuery = () => db.k.selectFrom("build_tasks as t")
    .select(["t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.state", "t.queued_at", "t.started_at", "t.ended_at", "t.results", "t.summary",
      (eb) => eb.selectFrom("build_task_logs as l").select("l.step").whereRef("l.task_id", "=", "t.id").orderBy("l.seq", "desc").limit(1).as("current")])
    .$if(!staff, (q) => q.where((eb) => eb.not(privateStepExpr(eb, "t.step"))));
  const callQuery = () => db.k.selectFrom("agent_runs as r").leftJoin("claude_accounts as a", "a.id", "r.account_id")
    .select(["r.id", "r.job_id", "r.step", "r.model", "r.provider", (eb) => eb.fn.coalesce("a.label", "r.account_id").as("label"), "r.started_at", "r.ended_at", "r.state", "r.progress"])
    .$if(filtered(hidden), (q) => q.where((eb) => touchesHiddenExpr(db, eb, hidden)));

  // Jobs: running, then queued (the next few), then the ones that ended lately.
  type Job = { id: number; step: string; state: string; requested_at: string; started_at: string | null; ended_at: string | null; progress: string | null; summary: string | null; error: string | null; repo: string | null };
  const jobQuery = () => db.k.selectFrom("jobs").select(["id", "step", "state", "requested_at", "started_at", "ended_at", "progress", "summary", "error", "repo"])
    .where((eb) => eb.or([eb("state", "=", "failed"), eb("step", "not in", quiet)]));
  const since = iso(nowMs - RECENT_MS);
  // Housekeeping steps show only when they fail; left out before any LIMIT, so they never take a slot.
  const quiet = [...QUIET_STEPS];
  const jobs = [
    ...await db.all(jobQuery().where("state", "=", "running").$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true))).orderBy("id")),
    ...await db.all(jobQuery().where("state", "=", "queued").$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true))).orderBy("id").limit(QUEUED_MAX)),
    ...await db.all(jobQuery().where("state", "in", ["done", "failed"]).where("ended_at", ">", since).where("started_at", "is not", null).$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true)))
      .orderBy("ended_at", "desc").limit(RECENT_MAX * 3)),
  ];

  const lanes: LiveLane[] = [];
  let recent = 0;
  for (const j of jobs) {
    const ended = j.state === "done" || j.state === "failed";
    const its = await db.all(db.k.selectFrom("job_items").select(["repo", "number"]).where("job_id", "=", j.id).$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden))).orderBy("id"));
    if (ended && its.length === 0 && j.state !== "failed") continue;
    if (ended && ++recent > RECENT_MAX) continue;
    const calls = await db.all(callQuery().where("r.job_id", "=", j.id).orderBy("r.id"));
    const tasks = await db.all(taskQuery().where("t.job_id", "=", j.id).$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "t.repo", hidden))).orderBy("t.id"));
    const line = j.state === "running" ? blankIfHidden(j.progress, hidden) : j.state === "failed" ? (staff && j.error ? blankIfHidden(j.error, hidden) : "Failed") : j.state === "done" ? blankIfHidden(j.summary, hidden) : null;
    lanes.push({
      key: `job:${j.id}`, title: stepTitle(j.step), state: j.state === "running" ? "running" : j.state === "queued" ? "queued" : j.state === "failed" ? "failed" : "done",
      start: j.started_at ?? j.requested_at, end: j.ended_at, line: line || null,
      item: its[0] ? await item(its[0].repo, its[0].number) : null, itemCount: its.length, repo: j.repo, detail: `/pipeline/${j.id}`,
      estimate: j.state === "running" ? await jobEstimate(j.step) : null,
      ops: [...await mapSeq(calls, callOp), ...await flatMapSeq(tasks, taskOps)].sort((a, b) => a.start.localeCompare(b.start)),
    });
  }

  // Calls and build tasks that run without a job.
  for (const c of await db.all(callQuery().where("r.state", "=", "running").where("r.job_id", "is", null).orderBy("r.id"))) {
    const it = (await db.all(db.k.selectFrom("agent_run_items").select(["repo", "number"]).where("run_id", "=", c.id).orderBy("repo").orderBy("number").limit(1)))[0];
    const op = await callOp(c);
    lanes.push({ key: `run:${c.id}`, title: stepTitle(c.step), state: "running", start: c.started_at, end: null, line: blankIfHidden(c.progress, hidden) || null, item: it ? await item(it.repo, it.number) : null, itemCount: it ? 1 : 0, repo: it?.repo ?? null, detail: `/agents/${c.id}`, estimate: op.estimate, ops: [op] });
  }
  // Open integration batches, with the build task of their combined tree; that task gets no lane of its own.
  type Batch = { id: number; repo: string; state: string; created_at: string; summary: string | null; task_id: number | null; pr_number: number | null };
  const batches = await db.all(db.k.selectFrom("merge_batches").select(["id", "repo", "state", "created_at", "summary", "task_id", "pr_number"]).where("state", "in", ["checking", "open"])
    .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden))).orderBy("id"));
  const batchTasks = new Set(batches.map((b) => b.task_id).filter((id): id is number => id !== null));
  for (const b of batches) {
    const prs = await db.all(db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", b.id).orderBy("position"));
    const tasks = b.task_id === null ? [] : await db.all(taskQuery().where("t.id", "=", b.task_id));
    const ops = await flatMapSeq(tasks, taskOps);
    lanes.push({
      key: `batch:${b.id}`, title: "Integration batch", state: "running", start: b.created_at, end: null,
      line: blankIfHidden(b.summary, hidden) || (b.state === "checking" ? "Checking the combined tree" : b.pr_number !== null ? `Batch pull request #${b.pr_number} is open` : null),
      item: prs[0] ? await item(b.repo, prs[0].number) : null, itemCount: prs.length, repo: b.repo, detail: `/batches/${b.id}`, estimate: null, ops,
    });
  }
  for (const t of await db.all(taskQuery().where("t.state", "in", ["queued", "claimed", "running"]).where("t.job_id", "is", null).$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "t.repo", hidden))).orderBy("t.id"))) {
    if (batchTasks.has(t.id)) continue;
    const ops = await taskOps(t);
    lanes.push({
      key: `task:${t.id}`, title: `Build task, ${stepTitle(t.step)}`, state: t.state === "queued" ? "queued" : "running", start: t.started_at ?? t.queued_at, end: null, line: t.summary,
      item: t.number === null ? null : await item(t.repo, t.number), itemCount: t.number === null ? 0 : 1, repo: t.repo, detail: `/envs/${t.id}`, estimate: ops[0]?.estimate ?? null, ops,
    });
  }
  return { lanes };
}

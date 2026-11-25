// reads: build.build_tasks, build.build_task_logs
// The live board: running, queued and lately ended jobs, calls and build tasks without a job, open integration batches and, for staff,
// the worker rows, in three waves of loaders. The lanes are assembled by the handler.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { filtered } from "../control/hidden.ts";
import type { HiddenRepos } from "../control/types.ts";
import { privateStepExpr } from "../build/fragments.ts";
import { loadTaskDurations } from "../build/tasks-views.ts";
import { loadTaskCards } from "../build/tasks-views.ts";
import { parseJson } from "../build/rows.ts";
import type { TaskCard, TaskResult, TaskState } from "../build/types.ts";
import { loadCallDurations, loadJobRuns, loadLooseRuns, loadWorkerRuns } from "../inference/views.ts";
import type { RunRow } from "../inference/types.ts";
import { loadLiveBoard, loadStepDurations } from "../jobs/views.ts";
import type { LiveBoard } from "../jobs/types.ts";
import { listActiveBatches } from "../merge/batches.ts";
import type { BatchView } from "../merge/types.ts";
import { loadShown } from "../mirror/items.ts";
import type { ItemShown } from "../mirror/types.ts";
import { loadRunnerBoard } from "../runners/views.ts";
import type { RunnerRow } from "../runners/types.ts";
import type { LiveOptions } from "./types.ts";

export type LiveView = {
  board: LiveBoard;
  looseRuns: RunRow[];
  batches: BatchView[];
  /** Queued, claimed and running build tasks without a job. */
  standalone: TaskCard[];
  stepDurations: Map<string, number[]>;
  workerRuns: RunRow[] | null;
  runnerBoard: { leases: Map<number, number>; helpers: RunnerRow[]; private: Set<string> } | null;
  jobRuns: Map<number, RunRow[]>;
  jobTasks: Map<number, TaskCard[]>;
  /** The combined-tree tasks of the open batches, by task id. */
  batchTasks: Map<number, TaskCard>;
  /** Earlier done calls by `step:model`. */
  callDurations: Map<string, { startedAt: string; endedAt: string }[]>;
  /** Earlier done tasks' durations in ms by `repo|step`. */
  taskDurations: Map<string, number[]>;
  shown: Map<string, ItemShown>;
};

/** Earlier runs an estimate is read from. */
export const LIVE_SAMPLES = 60;

type CardRow = { id: number; job_id: number | null; step: string; repo: string; number: number | null; state: string; queued_at: string; started_at: string | null; ended_at: string | null; results: string; summary: string | null; current: string | null };
const cardOf = (r: CardRow): TaskCard => ({
  id: Number(r.id), jobId: r.job_id === null ? null : Number(r.job_id), step: r.step, state: r.state as TaskState, repo: r.repo, number: r.number === null ? null : Number(r.number),
  queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at, results: parseJson<TaskResult[]>(r.results, []), summary: r.summary, logStep: r.current,
});

// NEEDS build.loadStandaloneTasks: tasks without a job by state, and tasks by id, as cards with the step their log is on; the view reads build_tasks itself until then.
async function loadCards(db: Db, o: { states?: string[]; ids?: number[]; staff: boolean; hidden: HiddenRepos }): Promise<TaskCard[]> {
  if (o.ids && !o.ids.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.build_tasks as t")
    .select(["t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.state", "t.queued_at", "t.started_at", "t.ended_at", "t.results", "t.summary",
      (eb) => eb.selectFrom("main.build_task_logs as l").select("l.step").whereRef("l.task_id", "=", "t.id").orderBy("l.seq", "desc").limit(1).as("current")])
    .$if(!!o.states, (b) => b.where("t.state", "in", o.states!).where("t.job_id", "is", null))
    .$if(!!o.ids, (b) => b.where(kx.inList(db, "t.id", o.ids!, "bigint")))
    .$if(!o.staff, (b) => b.where((eb) => eb.not(privateStepExpr(eb, "t.step"))))
    .$if(!!o.states && filtered(o.hidden), (b) => b.where(hiddenRepos(db, "t.repo", o.hidden)))
    .orderBy("t.id"), { label: "views.loadLiveCards" });
  return (rows as CardRow[]).map(cardOf);
}

/**
 * Wave 1: the job board, runs without a job, open batches, standalone tasks, step durations (every step, not only the running ones) and, for staff,
 * the worker runs and runner board. Wave 2: calls and tasks of the board's jobs and of the batches. Wave 3: the earlier durations behind the
 * estimates of what runs now and the shown fields of every first item.
 */
export async function loadLiveView(db: Db, scope: { hidden: HiddenRepos; staff: boolean }, o: LiveOptions & { steps: string[] }): Promise<LiveView> {
  const vis = { hidden: scope.hidden, staff: scope.staff };
  const taskScope = { hiddenRepos: scope.hidden, staff: scope.staff };
  const since = new Date(o.nowMs - o.workerWindowMs).toISOString();
  const [board, looseRuns, batches, standalone, stepDurations, workerRuns, runnerBoard] = await db.together(() => Promise.all([
    loadLiveBoard(db, { quietSteps: o.quietSteps, recentMs: o.recentMs, queuedMax: o.queuedMax, recentMax: o.recentMax, hidden: scope.hidden }),
    loadLooseRuns(db, vis),
    listActiveBatches(db, { hidden: scope.hidden }),
    loadCards(db, { states: ["queued", "claimed", "running"], staff: scope.staff, hidden: scope.hidden }),
    loadStepDurations(db, o.steps),
    scope.staff ? loadWorkerRuns(db, vis, since, o.workerCallsMax) : null,
    scope.staff ? loadRunnerBoard(db, o.nowMs, o.workerWindowMs) : null,
  ]));
  const jobIds = [...board.running, ...board.queued, ...board.recent].map((j) => j.id);
  const taskIds = batches.flatMap((b) => (b.task_id === null ? [] : [b.task_id]));
  const [jobRuns, jobTasks, batchCards] = await db.together(() => Promise.all([
    loadJobRuns(db, jobIds, vis),
    loadTaskCards(db, jobIds, taskScope),
    loadCards(db, { ids: taskIds, staff: scope.staff, hidden: scope.hidden }),
  ]));
  const batchTasks = new Map(batchCards.map((t) => [t.id, t]));

  const running = [...looseRuns, ...[...jobRuns.values()].flat(), ...(workerRuns ?? [])].filter((r) => r.state === "running");
  const pairs = new Map<string, { step: string; model: string }>(running.map((r) => [`${r.step}:${r.model}`, { step: r.step, model: r.model }]));
  const jobTaskCards = [...jobTasks.values()].flat();
  const tasks = new Map<string, { repo: string; step: string }>([...standalone, ...jobTaskCards, ...batchCards].filter((t) => !t.endedAt).map((t) => [`${t.repo}|${t.step}`, { repo: t.repo, step: t.step }]));
  const refs = [
    ...[...board.items.values()].flatMap((l) => (l[0] ? [{ repo: l[0].repo, number: l[0].number }] : [])),
    ...looseRuns.flatMap((r) => (r.firstRepo !== null && r.firstNumber !== null ? [{ repo: r.firstRepo, number: r.firstNumber }] : [])),
    ...(workerRuns ?? []).flatMap((r) => (r.firstRepo !== null && r.firstNumber !== null ? [{ repo: r.firstRepo, number: r.firstNumber }] : [])),
    ...batches.flatMap((b) => (b.members[0] ? [{ repo: b.repo, number: b.members[0].number }] : [])),
    ...standalone.flatMap((t) => (t.number === null ? [] : [{ repo: t.repo, number: t.number }])),
  ];
  const [callDurations, taskDurations, shown] = await db.together(() => Promise.all([
    loadCallDurations(db, [...pairs.values()], LIVE_SAMPLES),
    loadTaskDurations(db, [...tasks.values()], LIVE_SAMPLES),
    loadShown(db, refs),
  ]));
  return { board, looseRuns, batches, standalone, stepDurations, workerRuns, runnerBoard, jobRuns, jobTasks, batchTasks, callDurations, taskDurations, shown };
}

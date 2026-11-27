// Why a queued job or model call about an item does not start, for the item page, the agent's get_item and `workflow status`.
// Each reason is read from the rule that holds the work back, so it cannot disagree with what happens. A job: the runner's start
// pass (runner.ts startJobs): the pipeline switch, the job ceiling (capacity.ts), the same work or mutex (concurrency.ts
// jobBlockOf), the taker rule (concurrency.ts untakenTest) and the Task Runners' room (src/remote/room.ts jobRoom). A call: the
// model queue's whyWaiting (src/remote/queue-view.ts), the line the Work queue shows. Work none of them holds gets no reason.
// The pass's own moment is not seen from here: a Claude job still preparing its call holds a slot only inside the runner, so a
// job that waits only for that slot shows no reason.
import { freshConfig } from "../data/control/index.ts";
import { loadJobs, loadLaneState, loadLiveJobs } from "../data/jobs/index.ts";
import type { LiveJob } from "../data/jobs/types.ts";
import { queueView } from "../remote/queue-view.ts";
import { jobRoom, roomState, type RoomState } from "../remote/room.ts";
import { stageOfStep } from "../stages/registry.ts";
import { loginWaitIn, runnerWaitText, waitingOnIn } from "../remote/takers.ts";
import type { Db } from "../db/index.ts";
import { AUTOPILOT_USER, KEY_ENABLED } from "./autopilot.ts";
import { capacityOf } from "./capacity.ts";
import { jobBlockOf, STEP_PARALLEL_KEY, untakenTest, wantOf, type Active, type JobBlock, type UntakenTest } from "./concurrency.ts";
import { JOB_CAPACITY_MARK, jobCalls } from "./runner.ts";
import { knownStep, loadSteps, modelsOf, usesClaude, type Params, type StepDef } from "./steps.ts";

/** One queued job or model call about an item: `title` its stage (or step) as the item page names it, `since` when it was queued; `why` one short line, or null when no rule holds it back. */
export type QueuedWork = { kind: "job" | "call"; id: number; step: string; title: string; since: string; why: string | null };

type Ref = { repo: string; number: number };
const keyOf = (r: Ref): string => `${r.repo}#${r.number}`;
const titleOf = (step: string): string => knownStep(step)?.title ?? step;
const workTitle = (step: string): string => stageOfStep(step)?.title ?? titleOf(step);

/**
 * Per item (`repo#n`), its queued jobs (a job whose `number` is the item: a lane job or a run for one item) and the queued calls that
 * name it, oldest first. `shown`: the reader may see whose Task Runner work waits for (operators and maintainers).
 */
export async function queuedOfItems(db: Db, refs: readonly Ref[], o: { shown: boolean; nowMs?: number }): Promise<Map<string, QueuedWork[]>> {
  const nowMs = o.nowMs ?? Date.now();
  const out = new Map<string, QueuedWork[]>(refs.map((r) => [keyOf(r), []]));
  if (!refs.length) return out;
  const [live, queue] = await db.together(() => Promise.all([loadLiveJobs(db), queueView(db, nowMs, o.shown)]));
  for (const c of queue.calls) {
    for (const r of c.refs) out.get(keyOf(r))?.push({ kind: "call", id: c.id, step: c.step, title: workTitle(c.step), since: new Date(nowMs - c.waitedMs).toISOString(), why: c.why.text });
  }
  const jobs = live.filter((j) => j.state === "queued" && j.repo !== null && j.number !== null && j.step !== "security-fix" && out.has(`${j.repo}#${j.number}`));
  if (jobs.length) {
    const [rows, why] = await Promise.all([loadJobs(db, jobs.map((j) => j.id)), jobWaits(db, live, jobs, nowMs, o.shown)]);
    for (const j of jobs) out.get(`${j.repo}#${j.number}`)!.push({ kind: "job", id: j.id, step: j.step, title: workTitle(j.step), since: rows.get(j.id)?.requested_at ?? new Date(nowMs).toISOString(), why: why.get(j.id) ?? null });
  }
  for (const list of out.values()) list.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id - b.id));
  return out;
}

/** Per queued job of `jobs`, why the runner's start pass passes it over now (startJobs, in its order); absent when nothing does. */
async function jobWaits(db: Db, live: readonly LiveJob[], jobs: readonly LiveJob[], nowMs: number, shown: boolean): Promise<Map<number, string>> {
  const [steps, cfg, marks] = await Promise.all([loadSteps(), freshConfig(db, [KEY_ENABLED, STEP_PARALLEL_KEY]), loadLaneState(db, ["mark"])]);
  const cap = capacityOf(marks.get(`mark|${JOB_CAPACITY_MARK}|`)?.value);
  const running: Active[] = live.filter((j) => j.state === "running").map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
  let untaken: UntakenTest | undefined, room: { st: RoomState; rooms: ReturnType<typeof jobRoom> } | undefined;
  const out = new Map<number, string>();
  for (const q of jobs) {
    const why = await (async (): Promise<string | null> => {
      if (cfg.pipelineDraining) return "The pipeline is draining: no new job starts";
      if (q.requested_by === AUTOPILOT_USER && !cfg.pipelineEnabled) return "The pipeline is off";
      if (cap && running.length >= cap.max) return `All ${cap.max} job slots are busy`;
      const step = steps.get(q.step);
      if (!step) return null;
      const block = await jobBlockOf(db, steps, { ...wantOf(q.step, q.params), repo: q.repo }, { states: ["running"], mutex: true, active: running, cap: cfg.stepParallel });
      if (block) return blockLine(block, q);
      if (!claudeJob(step, q.params) || !q.repo) return null;
      const calls = jobCalls(q.step, q.repo, q.params);
      const none = await (untaken ??= await untakenTest(db, steps, nowMs))({ step: q.step, repo: q.repo, params: q.params, ...(calls.refs && { refs: calls.refs }) });
      if (none) return none;
      // With no job of its step running, a job starts without room (startJobs).
      if (!running.some((j) => j.step === step.name)) return null;
      room ??= await (async () => { const st = await roomState(db, nowMs); return { st, rooms: jobRoom(st) }; })();
      if (room.rooms.room(step.priority ?? 0, calls) > 0) return null;
      const call = { prompt_id: "", repos: calls.repos ?? [], step: q.step, ...(calls.refs && { refs: calls.refs }) };
      const [off] = waitingOnIn(room.st.v, call);
      if (off) return runnerWaitText(off, shown);
      const renew = loginWaitIn(room.st.v, call);
      if (renew) return runnerWaitText({ login: renew.login, renewsAt: renew.at }, shown);
      return "Every Task Runner that may take it is busy";
    })();
    if (why !== null) out.set(q.id, why);
  }
  return out;
}

function claudeJob(step: StepDef, params: string): boolean {
  try { return usesClaude(modelsOf(step, JSON.parse(params) as Params)); } catch { return false; }
}

function blockLine(b: JobBlock, q: LiveJob): string {
  if (b.kind === "parallel") return `${titleOf(q.step)} is running on ${b.repos} repo${b.repos === 1 ? "" : "s"}, the most at once`;
  if (b.kind === "mutex") return `Waiting for ${titleOf(b.job.step)}, which does not run at the same time`;
  return b.job.repo === q.repo && b.job.number === q.number ? "Waiting for another job on this item" : `Waiting for another ${titleOf(q.step)} job on ${b.job.repo ?? "every repo"}`;
}

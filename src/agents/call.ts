// The context of the model calls a job makes (its job, step and queue class), the claim order of queued calls, and the room
// and taker questions a step asks before it queues Task Runner calls. Jev runs are recorded here too.
import { insertRun, type RunStart } from "./runs.ts";
import { remoteRoom, roomOf, roomState, type RoomState } from "../remote/room.ts";
import { batchKey, roomKey, takerTestIn, type TakerCall } from "../remote/takers.ts";
import { loadRunningCounts } from "../data/inference/index.ts";
import type { Db } from "../db/index.ts";

/** Set by the job process: which job and step the calls belong to, and whether a cancel was asked. */
export type CallContext = { jobId: number; step: string; stage: number; /** Queue class of the step (StepDef.priority). */ class?: 0 | 1 | 2; /** The job's repo param. */ repo?: string; cancelled(): Promise<boolean>; /** True once the job is cancelled or the pipeline is switched off: no new model call starts. */ stopping?(): Promise<boolean> };
let context: CallContext | null = null;
export const setCallContext = (c: CallContext | null): void => void (context = c);
/** The job this process runs, or null outside a job. */
export const currentJobId = (): number | null => context?.jobId ?? null;
/** The job and step this process runs, or null outside a job. */
export const currentJob = (): { id: number; step: string } | null => (context ? { id: context.jobId, step: context.step } : null);
/** Throws CancelledError or StoppedError when the job was cancelled or the pipeline switched off: a waiting call gives up. */
export async function throwIfHalted(what: string): Promise<void> {
  if (await context?.cancelled()) throw new CancelledError(`cancelled while ${what}`);
  if (await context?.stopping?.()) throw new StoppedError("the pipeline was switched off");
}
/** Queue fields of a call made now: the job's repo and the queue class of the call's prompt. */
export const callQueue = (promptId: string): { repo: string | null; cls: 0 | 1 | 2; jobId: number | null } => ({ repo: context?.repo ?? null, cls: currentClass(promptId), jobId: context?.jobId ?? null });

/** Step names for calls made outside a job (the classify and decide commands). */
const PROMPT_STEP: Record<string, { step: string; stage: number }> = {
  "classify.haiku": { step: "classify-new", stage: 2 }, "classify.jev": { step: "classify-new", stage: 2 }, "referee.sonnet": { step: "referee", stage: 2 },
  "fixup.patch": { step: "fixup", stage: 6 }, "verify.plan": { step: "verify", stage: 6 }, "verify.screenshot": { step: "verify", stage: 6 }, "verify.compare": { step: "verify-collect", stage: 6 },
  "verify.summary": { step: "verify-collect", stage: 6 }, "priority.jev": { step: "prioritize", stage: 2 }, "priority.haiku": { step: "prioritize", stage: 2 },
  "dupes.jev": { step: "dupes", stage: 3 }, "dupes.haiku": { step: "dupes", stage: 3 },
  "review.opus": { step: "opus-review", stage: 5 }, "postmerge.opus": { step: "postmerge", stage: 8 }, "premerge.opus": { step: "premerge", stage: 6 },
  "dupes.compare-prs.opus": { step: "dupes-compare", stage: 3 }, "dupes.compare-issues.sonnet": { step: "dupes-compare", stage: 3 },
  "fixup.check": { step: "fixup", stage: 6 },
  "conversation.turn": { step: "conversation", stage: 3 },
  "areas.jev": { step: "classify-new", stage: 2 }, "areas.haiku": { step: "classify-new", stage: 2 },
  "areas.propose": { step: "areas-propose", stage: 2 }, "areas.suggest": { step: "areas-suggest", stage: 2 },
  "fixup.conflict": { step: "fixup", stage: 6 }, "discord.signal.jev": { step: "discord-signal", stage: 3 }, "discord.signal.haiku": { step: "discord-signal", stage: 3 },
  "discord.issue-questions": { step: "discord-issue", stage: 3 }, "discord.issue-draft": { step: "discord-issue", stage: 3 }, "discord.junk.jev": { step: "discord-issue", stage: 3 }, "discord.junk.haiku": { step: "discord-issue", stage: 3 },
  "discord.result.haiku": { step: "discord-result", stage: 3 },
  "command.read": { step: "command-read", stage: 3 }, "interactive.command-read": { step: "command-read", stage: 3 }, "command.read.jev": { step: "command-read", stage: 3 },
  "cifix.patch": { step: "cifix", stage: 6 }, "mainfix.classify": { step: "main-fix", stage: 6 },
  "lint.reference.jev": { step: "opus-review", stage: 5 }, "lint.reference.haiku": { step: "opus-review", stage: 5 },
  "security.model": { step: "security-scan", stage: 9 }, "security.area": { step: "security-scan", stage: 9 }, "security.verify": { step: "security-scan", stage: 9 },
  "security.scantest": { step: "security-scan", stage: 9 }, "security.fix": { step: "security-fix", stage: 9 }, "security.fixcheck": { step: "security-fix", stage: 9 },
  "implement.session": { step: "implement", stage: 7 },
};

/** The step a call of `promptId` made now is stored under (stepOf), for room and taker questions; undefined when neither is known. */
const askStep = (promptId?: string): string | undefined => context?.step ?? (promptId === undefined ? undefined : PROMPT_STEP[promptId]?.step);

export function stepOf(promptId: string): { jobId: number | null; step: string; stage: number } {
  if (context) return { jobId: context.jobId, step: context.step, stage: context.stage };
  return { jobId: null, ...(PROMPT_STEP[promptId] ?? { step: "unknown", stage: 0 }) };
}

export const allocation = { pollMs: 3000, logEveryMs: 5 * 60_000, staleMs: 30_000 };

export class CancelledError extends Error {}
/** The pipeline was switched off: the job ends as done, not failed. */
export class StoppedError extends Error {}
/**
 * A user-local call was withdrawn because no Task Runner could take it (src/remote/takers.ts): the unit of work that made it
 * is skipped and left for a later pass, with no failure counted (pool skips it; a job it ends finishes as done).
 */
export class NoTakerError extends Error {}
/** True for an error that ends a step's work, or a unit of it (NoTakerError), without a failure row. */
export const isHalt = (e: unknown): boolean => e instanceof CancelledError || e instanceof StoppedError || e instanceof NoTakerError;

/** Queue class of a call outside a job, from the step its prompt belongs to (inside a job the step's priority is used). */
const classOfStep = (step: string): 0 | 1 | 2 =>
  step.startsWith("security-") ? 2
    : ["fixup", "cifix", "main-fix", "verify", "verify-collect", "premerge", "opus-review", "decide", "conversation"].includes(step) ? 1 : 0;

/** The queue class of the call being made: the job step's priority, or for calls outside a job the class of the prompt's step. */
export const currentClass = (promptId?: string): 0 | 1 | 2 =>
  context?.class ?? classOfStep(promptId ? (PROMPT_STEP[promptId]?.step ?? "unknown") : (context?.step ?? "unknown"));

export type Waiter = { id: number; cls: number; level: number; step: string; repo: string | null; since: number };

/** A waiter gains one level band for each of these minutes it has waited (at most all 4 bands), so a steady flow of P0 calls cannot starve P2 ones. Aging orders waiters; nothing waits on a timer. */
export const LEVEL_AGING_MS = 30 * 60_000;
export const agedLevel = (level: number, sinceMs: number, nowMs: number): number => level + Math.min(4, Math.floor(Math.max(0, nowMs - sinceMs) / LEVEL_AGING_MS));

/**
 * Calls in claim order: class, then fewest running calls of the call's repo (one repo cannot take every slot), then the item's
 * priority level raised by the time waited (P0 first), then fewest running calls of its step, then oldest. `clsOf` gives the
 * class a call ranks with (the user-local queue raises gating and long-waiting small calls, src/remote/claim-class.ts).
 * Sorts `rows` in place.
 */
export async function queueOrder<T extends Waiter>(db: Db, nowMs: number, rows: T[], clsOf: (r: T) => number = (r) => r.cls): Promise<T[]> {
  return sortQueue(rows, await runningCounts(db, nowMs), nowMs, clsOf);
}

/** The running calls by repo and by step that queueOrder ranks with. */
export type RunningCounts = { repoN: Map<string, number>; stepN: Map<string, number> };

/** What queueOrder reads, for a caller that reads it at the same time as the rows. */
export async function runningCounts(db: Db, nowMs: number): Promise<RunningCounts> {
  return await loadRunningCounts(db, nowMs);
}

/** queueOrder with its counts already read. */
export function sortQueue<T extends Waiter>(rows: T[], { repoN, stepN }: RunningCounts, nowMs: number, clsOf: (r: T) => number = (r) => r.cls): T[] {
  const cls = new Map(rows.map((r) => [r, clsOf(r)]));
  return rows.sort((x, y) => cls.get(y)! - cls.get(x)! || (repoN.get(x.repo ?? "") ?? 0) - (repoN.get(y.repo ?? "") ?? 0) || agedLevel(y.level, y.since, nowMs) - agedLevel(x.level, x.since, nowMs) || (stepN.get(x.step) ?? 0) - (stepN.get(y.step) ?? 0) || x.since - y.since || x.id - y.id);
}

/**
 * Splits `items` into batches of at most `size`. Each batch holds one repo's items, so any user who may take that repo can take
 * the call (a mixed batch waits for a user who may take every repo in it), and only items the same filtered users take
 * (`refsOf`: the items a unit's call names; src/remote/takers.ts batchKey), so a runner that takes only some items is never
 * handed others and a chosen item never waits in a batch nobody takes; items keep their order within a batch and batches are
 * in the order of their first item.
 */
export async function repoBatches<T>(db: Db, items: readonly T[], size: number, repoOf: (x: T) => string, refsOf: (x: T) => readonly ItemRefLike[]): Promise<T[][]> {
  const out: T[][] = [];
  const keyOf = await batchKey(db);
  const open = new Map<string, T[]>();
  for (const x of items) {
    const key = `${repoOf(x)}\n${keyOf(refsOf(x))}`;
    let b = open.get(key);
    if (!b || b.length >= size) { open.set(key, (b = [])); out.push(b); }
    b.push(x);
  }
  return out;
}

/** An item a call names, as the room and the taker rule read it. */
export type ItemRefLike = { repo: string; number: number };

/** The repos of a call's items, for queueRoom. */
export const itemRepos = (items: readonly { repo: string }[]): string[] => [...new Set(items.map((i) => i.repo))];

/** The repos a call made now names: those of its items (`repos`) and the job's repo param. Unknown (undefined) when neither is given. */
const callRepos = (repos: readonly string[] | undefined): readonly string[] | undefined => {
  const job = context?.repo;
  if (repos === undefined) return job ? [job] : undefined;
  return job && !repos.includes(job) ? [...repos, job] : repos;
};

/**
 * How many more Claude calls a caller may start now: the free slots of the Task Runners that may take a call naming the repos
 * of the next call (`repos`: its items' repos; the job's repo param is added), minus the queued remote calls that rank at or
 * above the class and that those Task Runners may take (src/remote/room.ts).
 */
export async function queueRoom(db: Db, cls: 0 | 1 | 2 = currentClass(), repos?: readonly string[]): Promise<number> {
  return await remoteRoom(db, cls, Date.now(), callRepos(repos), context?.step);
}

/**
 * Room questions answered from one reading of the helpers (queueRoomPass). `step`: the step of the calls asked about, for the
 * tasks the runners take (src/remote/my-tasks.ts); left out, the current job's step, or outside a job the step of the pass's
 * prompt (none known: every task counts).
 */
export type RoomPass = {
  /** `refs`: the items the calls name, for the runners that take only some items (src/remote/task-items.ts); left out, not known yet. */
  room(cls: 0 | 1 | 2, repos?: readonly string[], step?: string, refs?: readonly ItemRefLike[]): Promise<number>;
  /** Whether a call naming `repos` (and `refs`, as for room) has a taker (src/remote/takers.ts). A call naming no repo (none given and no job repo) has one only in an operator's Task Runner, as the sweep reads it. */
  taker(repos?: readonly string[], step?: string, refs?: readonly ItemRefLike[]): Promise<boolean>;
  /** Whether a runner whose user takes only some items takes the call. */
  filteredTaker(repos?: readonly string[], step?: string, refs?: readonly ItemRefLike[]): Promise<boolean>;
  /** roomKey of `refs` at this pass's moment. */
  key(refs: readonly ItemRefLike[]): Promise<string>;
};

/**
 * queueRoom for many questions at one moment (the runner's pass over queued jobs, a pool's round): in the user-local mode the
 * helpers, their permissions and repos are read once. `promptId`: the prompt of the calls asked about, whose step stands in
 * outside a job.
 */
export async function queueRoomPass(db: Db, promptId?: string, read?: RoomState): Promise<RoomPass> {
  const nowMs = Date.now();
  let st = read;
  const state = async (): Promise<RoomState> => (st ??= await roomState(db, nowMs));
  // The taker rule of src/remote/takers.ts and the room, over one reading per pass.
  let takes: ((c: TakerCall) => boolean) | undefined;
  const taker = async (c: TakerCall): Promise<boolean> => (takes ??= takerTestIn((await state()).v))(c);
  let keyOf: ((refs: readonly ItemRefLike[]) => string) | undefined;
  return {
    room: async (cls, repos, step = askStep(promptId), refs) => roomOf(await state(), cls, callRepos(repos), step, refs),
    taker: async (repos, step = askStep(promptId), refs) => await taker({ prompt_id: "", repos: callRepos(repos) ?? [], step, refs }),
    filteredTaker: async (repos, step = askStep(promptId), refs) => await taker({ prompt_id: "", repos: callRepos(repos) ?? [], step, refs, filtered: true }),
    key: async (refs) => (keyOf ??= roomKey((await state()).v))(refs),
  };
}

/**
 * `items` with those whose calls no connected Task Runner may take moved behind the others (stable), and before them those a
 * runner that takes only some items (src/remote/task-items.ts) takes. A job cuts its selection to a limit before its pool runs;
 * sorted this way the cut never fills with items the pool would skip, and never cuts an item a filtered runner waits for.
 * `refsOf`: the items a unit's call names. `promptId`: as for queueRoomPass.
 */
export async function takersFirst<T>(db: Db, items: readonly T[], reposOf: (t: T) => readonly string[] | undefined, refsOf: (t: T) => readonly ItemRefLike[], promptId?: string): Promise<T[]> {
  const pass = await queueRoomPass(db, promptId);
  const rank: number[] = [];
  for (const t of items) rank.push(await pass.filteredTaker(reposOf(t), undefined, refsOf(t)) ? 2 : await pass.taker(reposOf(t), undefined, refsOf(t)) ? 1 : 0);
  return [...items.keys()].sort((a, b) => rank[b]! - rank[a]! || a - b).map((i) => items[i]!);
}

/**
 * The first `limit` items of a one-repo job's selection (all of them without a limit), taken in takersFirst order when the limit
 * cuts, so the cut keeps the items a Task Runner takes. `numberOf`: the item a unit's call names.
 */
export async function takersCut<T>(db: Db, items: readonly T[], limit: number | undefined, repo: string, numberOf: (t: T) => number): Promise<T[]> {
  if (limit === undefined || items.length <= limit) return [...items];
  return (await takersFirst(db, items, () => [repo], (t) => [{ repo, number: numberOf(t) }])).slice(0, Math.max(0, limit));
}

/** The model queue's room for a pool's units by index (classify/run.ts pool): answers are kept for one round of the pool's scheduling. */
export type PoolRoom = { round(): void; room(i: number): Promise<number>; taker(i: number): Promise<boolean> };

/**
 * PoolRoom for units whose calls name `reposOf(i)` (the job's repo param is added) and the items `refsOf(i)`, in the current call's
 * class. A runner that takes only some items (src/remote/task-items.ts) counts only for the units on them, so a pool never queues
 * a call it would leave unclaimed, and finds room for those units while the other runners are busy. `mayNotCall`: a unit may
 * finish without a model call (collecting build results), so every unit counts as having a taker and a unit of a repo no Task
 * Runner takes still starts when none of the pool's units runs. `promptId`: the prompt the units call, whose step and class stand
 * in outside a job.
 */
export function poolRoom(db: Db, reposOf: (i: number) => readonly string[] | undefined, refsOf: (i: number) => readonly ItemRefLike[], opts: { mayNotCall?: boolean; promptId?: string } = {}): PoolRoom {
  const cls = currentClass(opts.promptId);
  let pass: RoomPass | null = null;
  const rooms = new Map<string, number>(), takers = new Map<string, boolean>();
  // The answers depend on the items only through which filtered users take them, so units of one repo share them when nobody filters.
  const keyOf = async (i: number): Promise<string> => {
    const r = reposOf(i);
    return `${r === undefined ? "\0" : [...r].sort().join("\n")}\t${await (pass ??= await queueRoomPass(db, opts.promptId)).key(refsOf(i))}`;
  };
  return {
    round: () => { pass = null; rooms.clear(); takers.clear(); },
    room: async (i) => {
      const k = await keyOf(i);
      let n = rooms.get(k);
      if (n === undefined) rooms.set(k, (n = await (pass ??= await queueRoomPass(db, opts.promptId)).room(cls, reposOf(i), undefined, refsOf(i))));
      return n;
    },
    taker: async (i) => {
      if (opts.mayNotCall) return true;
      const k = await keyOf(i);
      let t = takers.get(k);
      if (t === undefined) takers.set(k, (t = await (pass ??= await queueRoomPass(db, opts.promptId)).taker(reposOf(i), undefined, refsOf(i))));
      return t;
    },
  };
}

export class WaitLimitError extends Error {}

/** Records a Jev call (no account, no slot). */
export async function startJevRun(db: Db, s: Omit<RunStart, "jobId" | "step" | "stage">): Promise<number> {
  return await insertRun(db, { ...s, ...stepOf(s.promptId) });
}

// Agent runs: one row per model call made through the prompt registry. Written by the callers in src/classify/run.ts, read by the API.
// Storage and queries live in src/data/inference; this file shapes the API rows and carries the end-of-run waker.
import type { AgentRun, AgentRunDetail, AgentRunFilter, AgentRunPage, AgentRunTool, ItemRef, ItemShown, RateBucket, Rates } from "../../web/src/api/types.ts";
import { loadModelChecksOfRun } from "../data/changes/index.ts";
import * as inference from "../data/inference/index.ts";
import type { HiddenRepos, RunEnd as ModuleRunEnd, RunRow, RunStart as ModuleRunStart } from "../data/inference/index.ts";
import { loadItemsByBucket } from "../data/jobs/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import { scrub } from "../runner/scrub.ts";
import type { Db } from "../db/index.ts";

export { MAX_ITEM_REFS, RUN_KEEP_MS, TEXT_KEEP_MS, packText, unpackText } from "../data/inference/index.ts";

export type RunStart = ModuleRunStart;
export type RunEnd = Omit<ModuleRunEnd, "id">;

const endWakers = new Set<() => void>();
/** Calls `f` when a run of this process ends (a slot may be free); returns the way to stop listening. */
export function onRunEnd(f: () => void): () => void {
  endWakers.add(f);
  return () => void endWakers.delete(f);
}
const runEnded = (): void => { for (const f of [...endWakers]) f(); };

/** A prompt in its stored form (scrubbed, cut and compressed), for a caller that builds it before a write transaction. */
export const packPrompt = (prompt: string): Uint8Array => inference.packPrompt(prompt, scrub);

/** Inserts the running row, its item refs and its prompt text. Does not open a transaction. */
export async function insertRun(db: Db, s: RunStart): Promise<number> {
  return await inference.openRun(db, s, scrub);
}

export async function finishRun(db: Db, id: number, e: RunEnd): Promise<void> {
  await inference.finishRun(db, { ...e, id }, scrub);
  setImmediate(runEnded); // after the caller's own follow-up claim, which gets the freed slot first
}

/** The latest progress line of a running call (src/classify/progress.ts). */
export async function setRunProgress(db: Db, id: number, line: string): Promise<void> {
  await inference.setRunProgress(db, [{ id, line }]);
}

/** Marks running rows as failed: all of them, or those of one job. Used when the process that made the calls is gone. */
export async function failRunning(db: Db, reason: string, jobId?: number): Promise<number> {
  return await inference.failRunning(db, reason, jobId === undefined ? undefined : { jobId });
}

// ---- reading -----------------------------------------------------------------

/** `via` (the helper's login) goes to staff only. */
function toRun(r: RunRow, shown: Map<string, ItemShown>, staff: boolean): AgentRun {
  const none: ItemShown = { kind: null, state: null, title: null };
  return {
    id: r.id, jobId: r.jobId, step: r.step, stage: r.stage, promptId: r.promptId, promptVersion: r.promptVersion,
    provider: r.provider, model: r.model, accountId: null, accountLabel: null,
    items: r.items.map((x) => ({ ...x, ...(shown.get(`${x.repo}#${x.number}`) ?? none) })), itemCount: r.itemCount, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt,
    inputTokens: r.tokens.input, outputTokens: r.tokens.output, cacheReadTokens: r.tokens.cacheRead, cacheWriteTokens: r.tokens.cacheWrite, costUsd: r.costUsd, summary: r.summary,
    ...(staff && r.userLogin && { via: { login: r.userLogin, harness: r.harness ?? "", model: r.reportedModel ?? "" } }),
    ...(r.state === "running" && r.progress && { progress: r.progress }),
  };
}

const shownOf = async (db: Db, runs: RunRow[]): Promise<Map<string, ItemShown>> => await loadShown(db, [...new Map(runs.flatMap((r) => r.items).map((x) => [`${x.repo}#${x.number}`, x as ItemRef])).values()]);

export class RunQueryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STEP_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CURSOR_RE = /^[1-9][0-9]{0,15}$/;
export const AGENT_PAGE_DEFAULT = 50, AGENT_PAGE_MAX = 200;

/** Newest first, keyset on id: a page costs index reads proportional to its size, however many runs exist. */
export async function listRuns(db: Db, f: AgentRunFilter, hidden: HiddenRepos = [], staff = false): Promise<AgentRunPage> {
  if (f.state !== undefined && !["running", "done", "failed", "recent"].includes(f.state)) throw new RunQueryError(400, "unknown state");
  if (f.step !== undefined && !STEP_RE.test(f.step)) throw new RunQueryError(400, "bad step");
  if (f.repo !== undefined && !REPO_RE.test(f.repo)) throw new RunQueryError(400, "bad repo");
  if (f.cursor !== undefined && !CURSOR_RE.test(f.cursor)) throw new RunQueryError(400, "bad cursor");
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > AGENT_PAGE_MAX)) throw new RunQueryError(400, `limit must be a whole number from 1 to ${AGENT_PAGE_MAX}`);
  const { rows, nextCursor } = await inference.listRuns(db, { ...f, limit: f.limit ?? AGENT_PAGE_DEFAULT }, { hidden, staff });
  const shown = await shownOf(db, rows);
  return { runs: rows.map((x) => toRun(x, shown, staff)), nextCursor };
}

/** A run that touches a hidden repo is not found; prompt and output text go only to `texts` viewers (operators). */
export async function getRun(db: Db, id: unknown, view: { hidden?: HiddenRepos; texts?: boolean } = { texts: true }): Promise<AgentRunDetail> {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new RunQueryError(400, "not a run id");
  const staff = view.texts === true;
  const [detail, checks] = await db.together(() => Promise.all([inference.loadRun(db, id, { hidden: view.hidden ?? [], staff }), loadModelChecksOfRun(db, id)]));
  if (!detail) throw new RunQueryError(404, `no agent run ${id}`);
  const byId = new Map(checks.map((c) => [c.id, c]));
  // Tool arguments carry file paths and patch text: like the prompt, for operators only.
  const tools: AgentRunTool[] = detail.tools.map((t) => {
    const c = t.checkId === null ? undefined : byId.get(t.checkId);
    return { seq: t.seq, tool: t.tool, args: t.args, resultBytes: t.resultBytes, isError: t.isError, startedAt: t.startedAt, endedAt: t.endedAt,
      check: t.checkId === null ? null : { id: t.checkId, command: c?.command ?? "", crate: c?.crate ?? null, testName: c?.testName ?? null, outcome: c?.outcome ?? null } };
  });
  const run = toRun(detail.run, await shownOf(db, [detail.run]), staff);
  if (!view.texts) return { ...run, prompt: null, output: null, error: detail.run.error ? "failed" : null, tools, textsHidden: true };
  return { ...run, prompt: inference.unpackText(detail.prompt), output: inference.unpackText(detail.output), error: detail.run.error, tools };
}

/** The tool uses of a run in order; a check-tool use carries its model_checks row. */
export async function runTools(db: Db, runId: number): Promise<AgentRunTool[]> {
  return (await getRun(db, runId, { texts: true })).tools;
}

// ---- rates ---------------------------------------------------------------------

/** Items moved per stage in hourly (24h) or daily (7d) buckets ending now (UTC). */
export async function rates(db: Db, window: unknown, nowMs: number = Date.now(), hidden: HiddenRepos = []): Promise<Rates> {
  if (window !== "24h" && window !== "7d") throw new RunQueryError(400, "window must be 24h or 7d");
  const hourly = window === "24h", step = hourly ? 3600_000 : 86_400_000, n = hourly ? 24 : 7;
  const end = Math.floor(nowMs / step) * step + step;
  const start = end - n * step;
  const from = new Date(start).toISOString(), to = new Date(end).toISOString();
  // The hour or day an ISO time falls in: its leading characters, completed to the bucket's start time by `bucketKey`.
  const prefix = hourly ? 13 : 10;
  const bucketKey = (b: string) => hourly ? `${b}:00:00.000Z` : `${b}T00:00:00.000Z`;
  const keys = Array.from({ length: n }, (_, i) => new Date(start + i * step).toISOString());

  const empty = () => new Map<string, RateBucket>(keys.map((t) => [t, { t, items: 0, runs: 0, failed: 0 }]));
  const byStep = new Map<string, Map<string, RateBucket>>();
  const bucketsOf = (s: string) => byStep.get(s) ?? (byStep.set(s, empty()), byStep.get(s)!);

  const [items, runs] = await db.together(() => Promise.all([
    loadItemsByBucket(db, from, to, hourly ? "hour" : "day", hidden),
    inference.loadRunBuckets(db, { from, to, prefixLen: prefix, vis: { hidden, staff: false } }),
  ]));
  for (const r of items) { const b = bucketsOf(r.step).get(bucketKey(r.bucket)); if (b) b.items = r.items; }
  for (const r of runs) { const b = bucketsOf(r.step).get(bucketKey(r.bucket)); if (b) { b.runs = r.runs; b.failed = r.failed; } }
  // Loaded here: steps.ts imports modules that import the model-call code, which imports this file.
  const steps = await (await import("../runner/steps.ts")).loadSteps();
  const names = [...new Set([...steps.keys(), ...byStep.keys()])];
  const stages = names.map((s) => ({ step: s, title: steps.get(s)?.title ?? s, buckets: [...bucketsOf(s).values()] }))
    .sort((a, b) => (steps.get(a.step)?.stage ?? 99) - (steps.get(b.step)?.stage ?? 99) || a.step.localeCompare(b.step));
  return { window, bucket: hourly ? "hour" : "day", stages, accounts: [] };
}

// ---- retention -----------------------------------------------------------------

/** Drops prompt and output text and tool uses with their runs after RUN_KEEP_MS (ten years). */
export async function pruneRuns(db: Db, nowMs: number = Date.now()): Promise<{ texts: number; runs: number }> {
  return await inference.pruneRuns(db, nowMs);
}

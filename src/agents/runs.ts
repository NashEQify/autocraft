// Agent runs: one row per model call made through the prompt registry. Written
// by the callers in src/classify/run.ts, read by the API.
import type { AliasableExpression, SqlBool } from "kysely";
import { filtered, hiddenTestExpr, type HiddenRepos } from "../hidden-sql.ts";
import type { Eb } from "../db/kx.ts";
import * as kx from "../db/kx.ts";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentRun, AgentRunDetail, AgentRunFilter, AgentRunPage, AgentRunState, AgentRunTool, ItemRef, ItemShown, RateBucket, Rates } from "../../web/src/api/types.ts";

export const MAX_ITEM_REFS = 50;
/** Ten years: the item history keeps every model call with its prompt and output. */
export const RUN_KEEP_MS = 3650 * 86_400_000;
/** Texts are kept as long as the runs; they are stored compressed. */
export const TEXT_KEEP_MS = RUN_KEEP_MS;
const TEXT_MAX = 1_000_000;
const ERROR_MAX = 400;

export type RunStart = {
  jobId: number | null; step: string; stage: number;
  promptId: string; promptVersion: string; provider: "claude" | "jev"; model: string; accountId: string | null;
  items: ItemRef[];
  /** The prompt text, or the stored form packPrompt made of it. */
  prompt: string | Uint8Array;
  /** A call a Task Runner leased: its user, harness and the model the claim named. */
  remote?: { userLogin: string; harness: string; reportedModel: string };
};

export type RunEnd = {
  state: Exclude<AgentRunState, "running">;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  summary?: string | null; error?: string | null; output?: string | null;
  costUsd?: number | null;
};

/** A stored text: gzip, which SQLite keeps as a BLOB. */
export const packText = (s: string): Uint8Array => gzipSync(s);
/** Reads a stored text; rows from before compression hold plain strings. */
export const unpackText = (v: unknown): string | null => (typeof v === "string" ? v : v instanceof Uint8Array ? gunzipSync(v).toString("utf8") : null);

import { shownLookup } from "../dash/api/shown.ts";
import { scrub } from "../runner/scrub.ts";
import { mapSeq } from "../async-seq.ts";
import { keptRunsExpr } from "../runner/resuming.ts";
import type { Db } from "../db/index.ts";

const now = (): string => new Date().toISOString();

const endWakers = new Set<() => void>();
/** Calls `f` when a run of this process ends (a slot may be free); returns the way to stop listening. */
export function onRunEnd(f: () => void): () => void {
  endWakers.add(f);
  return () => void endWakers.delete(f);
}
const runEnded = (): void => { for (const f of [...endWakers]) f(); };

/** A prompt in its stored form (scrubbed, cut and compressed), for a caller that builds it before a write transaction. */
export const packPrompt = (prompt: string): Uint8Array => packText(scrub(prompt.slice(0, TEXT_MAX)));

/** Inserts the running row, its item refs and its prompt text. Does not open a transaction. */
export async function insertRun(db: Db, s: RunStart): Promise<number> {
  const refs = s.items.slice(0, MAX_ITEM_REFS);
  const id = Number((await db.get(db.k.insertInto("agent_runs").values({
    job_id: s.jobId, step: s.step, stage: s.stage, prompt_id: s.promptId, prompt_version: s.promptVersion, provider: s.provider, model: s.model,
    account_id: s.accountId, items: JSON.stringify(refs), item_count: s.items.length, state: "running", started_at: now(),
    ...(s.remote && { user_login: s.remote.userLogin, harness: s.remote.harness, reported_model: s.remote.reportedModel }),
  }).returning("id")))!.id);
  if (s.items.length) await db.run(db.k.insertInto("agent_run_items").values(s.items.map((r) => ({ run_id: id, repo: r.repo, number: r.number }))).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("agent_run_texts").values({ run_id: id, prompt: typeof s.prompt === "string" ? packPrompt(s.prompt) : s.prompt }));
  return id;
}

export async function finishRun(db: Db, id: number, e: RunEnd): Promise<void> {
  const t = e.tokens;
  await db.run(db.k.updateTable("agent_runs").set({
    state: e.state, ended_at: now(), input_tokens: t?.input ?? null, output_tokens: t?.output ?? null, cache_read_tokens: t?.cacheRead ?? null,
    cache_write_tokens: t?.cacheWrite ?? null, cost_usd: e.costUsd ?? null, summary: e.summary ?? null, error: e.error ? e.error.slice(0, ERROR_MAX) : null, progress: null,
  }).where("id", "=", id).where("state", "=", "running"));
  if (e.output) await db.run(db.k.updateTable("agent_run_texts").set({ output: packText(scrub(e.output.slice(0, TEXT_MAX))) }).where("run_id", "=", id));
  setImmediate(runEnded); // after the caller's own follow-up claim, which gets the freed slot first
}

/** The latest progress line of a running call (src/classify/progress.ts). */
export async function setRunProgress(db: Db, id: number, line: string): Promise<void> {
  await db.run(db.k.updateTable("agent_runs").set({ progress: line }).where("id", "=", id).where("state", "=", "running"));
}

/**
 * Marks running rows as failed: all of them, or those of one job. Used when the process that made the calls is gone. The
 * runs of remote calls that a resuming job may adopt stay running (keptRunsExpr): a Task Runner may still answer them.
 */
export async function failRunning(db: Db, reason: string, jobId?: number): Promise<number> {
  const r = await db.run(db.k.updateTable("agent_runs").set({ state: "failed", ended_at: now(), error: reason, summary: reason }).where("state", "=", "running")
    .$if(jobId !== undefined, (q) => q.where("job_id", "=", jobId!)).where("id", "not in", keptRunsExpr(db)));
  return Number(r.changes);
}

// ---- reading -----------------------------------------------------------------

type RunRow = {
  id: number; job_id: number | null; step: string; stage: number; prompt_id: string; prompt_version: string; provider: string; model: string;
  account_id: string | null; account_label: string | null; items: string; item_count: number; state: AgentRunState; started_at: string; ended_at: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; summary: string | null; error: string | null; progress: string | null; cost_usd: number | null;
  user_login: string | null; harness: string | null; reported_model: string | null;
};

const RUN_COLS = [...kx.cols("agent_runs", "r"), "a.label as account_label"] as const;

function refs(s: string): ItemRef[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as ItemRef[]).filter((x) => typeof x?.repo === "string" && Number.isInteger(x?.number)) : [];
  } catch {
    return [];
  }
}

/** `via` (the helper's login) goes to staff only. */
async function toRun(r: RunRow, shown: (repo: string, number: number) => Promise<ItemShown>, staff: boolean): Promise<AgentRun> {
  return {
    id: r.id, jobId: r.job_id, step: r.step, stage: r.stage, promptId: r.prompt_id, promptVersion: r.prompt_version,
    provider: r.provider === "jev" ? "jev" : "claude", model: r.model, accountId: r.account_id, accountLabel: r.account_id ? (r.account_label ?? r.account_id) : null,
    items: await mapSeq(refs(r.items), async (x) => ({ ...x, ...await shown(x.repo, x.number) })), itemCount: r.item_count, state: r.state, startedAt: r.started_at, endedAt: r.ended_at,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd, summary: r.summary,
    ...(staff && r.user_login && { via: { login: r.user_login, harness: r.harness ?? "", model: r.reported_model ?? "" } }),
    ...(r.state === "running" && r.progress && { progress: r.progress }),
  };
}

export class RunQueryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STEP_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CURSOR_RE = /^[1-9][0-9]{0,15}$/;
export const AGENT_PAGE_DEFAULT = 50, AGENT_PAGE_MAX = 200;

/** Newest first, keyset on id: a page costs index reads proportional to its size, however many runs exist. */
export async function listRuns(db: Db, f: AgentRunFilter, hidden: HiddenRepos = [], staff = false): Promise<AgentRunPage> {
  if (f.state !== undefined && !["running", "done", "failed", "recent"].includes(f.state)) throw new RunQueryError(400, "unknown state");
  if (f.step !== undefined && !STEP_RE.test(f.step)) throw new RunQueryError(400, "bad step");
  if (f.account !== undefined && !ACCOUNT_RE.test(f.account)) throw new RunQueryError(400, "bad account");
  if (f.repo !== undefined && !REPO_RE.test(f.repo)) throw new RunQueryError(400, "bad repo");
  if (f.cursor !== undefined && !CURSOR_RE.test(f.cursor)) throw new RunQueryError(400, "bad cursor");
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > AGENT_PAGE_MAX)) throw new RunQueryError(400, `limit must be a whole number from 1 to ${AGENT_PAGE_MAX}`);
  const limit = f.limit ?? AGENT_PAGE_DEFAULT;
  const cursorCol = f.repo ? "i.run_id" : "r.id";
  const conds = (eb: Eb) => {
    const c = [];
    if (f.cursor) c.push(eb(cursorCol, "<", Number(f.cursor)));
    if (f.state && f.state !== "recent") c.push(eb("r.state", "=", f.state));   // validated above
    if (f.step) c.push(eb("r.step", "=", f.step));
    if (f.account) c.push(eb("r.account_id", "=", f.account));
    if (filtered(hidden)) c.push(touchesHiddenExpr(db, eb, hidden));
    return eb.and(c);
  };
  const rows: RunRow[] = f.repo
    // Driven by the (repo, run_id, number) index, newest run first, one row per run (the run's lowest number in the repo): no sort, stops at the limit.
    ? await db.all(db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id").leftJoin("claude_accounts as a", "a.id", "r.account_id").select(RUN_COLS)
      .where("i.repo", "=", f.repo)
      .where((eb) => eb("i.number", "=", eb.selectFrom("agent_run_items as j").select((e) => e.fn.min("j.number").as("n")).whereRef("j.run_id", "=", "i.run_id").whereRef("j.repo", "=", "i.repo")))
      .where(conds).orderBy("i.run_id", "desc").limit(limit + 1).$narrowType<{ state: AgentRunState }>())
    : await db.all(db.k.selectFrom("agent_runs as r").leftJoin("claude_accounts as a", "a.id", "r.account_id").select(RUN_COLS).where(conds).orderBy("r.id", "desc").limit(limit + 1).$narrowType<{ state: AgentRunState }>());
  const shown = shownLookup(db);
  const page = rows.slice(0, limit);
  return { runs: await mapSeq(page, async (x) => await toRun(x, shown, staff)), nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

/**
 * True when the run `r` may be shown under a repo filter: it is bound to an item and has no item in a
 * hidden repo. A run recorded without items is about no repo the filter can test, so only operators (no filter) see it.
 */
export const touchesHiddenExpr = (db: Db, eb: Eb, hidden: HiddenRepos): AliasableExpression<SqlBool> => eb.and([
  eb.exists(db.k.selectFrom("agent_run_items as y").select(eb.lit(1).as("one")).where("y.run_id", "=", eb.ref("r.id"))),
  eb.not(eb.exists(db.k.selectFrom("agent_run_items as x").select(eb.lit(1).as("one")).where("x.run_id", "=", eb.ref("r.id")).where(hiddenTestExpr(db, "x.repo", hidden)))),
]);

/** A run that touches a hidden repo is not found; prompt and output text go only to `texts` viewers (operators). */
export async function getRun(db: Db, id: unknown, view: { hidden?: HiddenRepos; texts?: boolean } = { texts: true }): Promise<AgentRunDetail> {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new RunQueryError(400, "not a run id");
  const r = await db.get(db.k.selectFrom("agent_runs as r").leftJoin("claude_accounts as a", "a.id", "r.account_id").select(RUN_COLS).where("r.id", "=", id).$narrowType<{ state: AgentRunState }>());
  if (!r) throw new RunQueryError(404, `no agent run ${id}`);
  const hidden = view.hidden;
  if (hidden && filtered(hidden) && !await db.get(db.k.selectFrom("agent_runs as r").select((eb) => eb.lit(1).as("one")).where("r.id", "=", id).where((eb) => touchesHiddenExpr(db, eb, hidden)))) {
    throw new RunQueryError(404, `no agent run ${id}`);
  }
  const tools = await runTools(db, id);
  // Tool arguments carry file paths and patch text: like the prompt, for operators only.
  if (!view.texts) return { ...await toRun(r, shownLookup(db), false), prompt: null, output: null, error: r.error ? "failed" : null, tools: tools.map((t) => ({ ...t, args: null })), textsHidden: true };
  const t = await db.get(db.k.selectFrom("agent_run_texts").select(["prompt", "output"]).where("run_id", "=", id));
  return { ...await toRun(r, shownLookup(db), view.texts === true), prompt: unpackText(t?.prompt), output: unpackText(t?.output), error: r.error, tools };
}

/** The tool uses of a run in order; a check-tool use carries its model_checks row. */
export async function runTools(db: Db, runId: number): Promise<AgentRunTool[]> {
  const rows = await db.all(db.k.selectFrom("agent_run_tools as t").leftJoin("model_checks as c", "c.id", "t.check_id")
    .select(["t.seq", "t.tool", "t.args", "t.result_bytes", "t.is_error", "t.started_at", "t.ended_at", "t.check_id", "c.command", "c.crate", "c.test_name", "c.outcome"])
    .where("t.run_id", "=", runId).orderBy("t.seq"));
  return rows.map((r) => ({
    seq: r.seq, tool: r.tool, args: r.args, resultBytes: r.result_bytes, isError: r.is_error === 1, startedAt: r.started_at, endedAt: r.ended_at,
    check: r.check_id === null ? null : { id: r.check_id, command: r.command ?? "", crate: r.crate, testName: r.test_name, outcome: r.outcome },
  }));
}

/** Labels of the accounts each job's runs used, for a page of jobs. */
export async function accountLabelsByJob(db: Db, jobIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!jobIds.length) return out;
  const rows = await db.all(db.k.selectFrom("agent_runs as r").leftJoin("claude_accounts as a", "a.id", "r.account_id").distinct()
    .select((eb) => ["r.job_id as job", eb.fn.coalesce("a.label", "r.account_id").as("label")])
    .where(kx.inList(db, "r.job_id", jobIds, "bigint")).where("r.account_id", "is not", null)
    .orderBy("job").orderBy("label")
    .$narrowType<{ job: number; label: string }>());
  for (const r of rows) out.set(r.job, [...(out.get(r.job) ?? []), r.label]);
  return out;
}

// ---- rates ---------------------------------------------------------------------

/** Items moved per stage, and usage of the enabled accounts, in hourly (24h) or daily (7d) buckets ending now (UTC). */
export async function rates(db: Db, window: unknown, nowMs: number = Date.now(), hidden: HiddenRepos = []): Promise<Rates> {
  if (window !== "24h" && window !== "7d") throw new RunQueryError(400, "window must be 24h or 7d");
  const hourly = window === "24h", step = hourly ? 3600_000 : 86_400_000, n = hourly ? 24 : 7;
  const end = Math.floor(nowMs / step) * step + step;
  const start = end - n * step;
  const from = new Date(start).toISOString();
  // The hour or day an ISO time falls in: its leading characters, completed to the bucket's start time by `bucketKey`.
  const prefix = hourly ? 13 : 10;
  const bucketOf = (eb: Eb, col: string) => eb.fn<string>("substr", [eb.ref(col), eb.lit(1), eb.lit(prefix)]).as("bucket");
  const bucketKey = (b: string) => hourly ? `${b}:00:00.000Z` : `${b}T00:00:00.000Z`;
  const keys = Array.from({ length: n }, (_, i) => new Date(start + i * step).toISOString());

  const empty = () => new Map<string, RateBucket>(keys.map((t) => [t, { t, items: 0, runs: 0, failed: 0 }]));
  const byStep = new Map<string, Map<string, RateBucket>>();
  const bucketsOf = (s: string) => byStep.get(s) ?? (byStep.set(s, empty()), byStep.get(s)!);

  const to = new Date(end).toISOString();
  for (const r of await db.all(db.k.selectFrom("jobs").select((eb) => ["step", bucketOf(eb, "started_at"), eb.fn.coalesce(eb.fn.sum<number>("items"), eb.lit(0)).as("items")])
    .where("started_at", ">=", from).where("started_at", "<", to)
    .$if(filtered(hidden), (q) => q.where((eb) => eb.or([eb("repo", "is", null), eb.not(hiddenTestExpr(db, "repo", hidden))])))
    .groupBy("step").groupBy("bucket"))) {
    const b = bucketsOf(r.step).get(bucketKey(r.bucket));
    if (b) b.items = r.items;
  }
  for (const r of await db.all(db.k.selectFrom("agent_runs as r").select((eb) => ["r.step", bucketOf(eb, "r.started_at"), eb.fn.countAll<number>().as("runs"),
    eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("r.state", "=", "failed").then(1).else(0).end()), eb.lit(0)).as("failed")])
    .where("r.started_at", ">=", from).where("r.started_at", "<", to)
    .$if(filtered(hidden), (q) => q.where((eb) => touchesHiddenExpr(db, eb, hidden)))
    .groupBy("r.step").groupBy("bucket"))) {
    const b = bucketsOf(r.step).get(bucketKey(r.bucket));
    if (b) { b.runs = r.runs; b.failed = r.failed; }
  }
  // Loaded here: steps.ts imports modules that import the model-call code, which imports this file.
  const steps = await (await import("../runner/steps.ts")).loadSteps();
  const names = [...new Set([...steps.keys(), ...byStep.keys()])];
  const stages = names.map((s) => ({ step: s, title: steps.get(s)?.title ?? s, buckets: [...bucketsOf(s).values()] }))
    .sort((a, b) => (steps.get(a.step)?.stage ?? 99) - (steps.get(b.step)?.stage ?? 99) || a.step.localeCompare(b.step));

  const accounts = await mapSeq(await db.all(db.k.selectFrom("claude_accounts").select(["id", "label"]).where("enabled", "=", 1).orderBy("id")), async (a) => ({
    id: a.id, label: a.label,
    samples: (await db.all(db.k.selectFrom("account_usage_samples").select((eb) => [bucketOf(eb, "t"), eb.fn.max("five_hour_pct").as("fiveHourPct"), eb.fn.max("weekly_pct").as("weeklyPct")])
      .where("account_id", "=", a.id).where("t", ">=", from).groupBy("bucket").orderBy("bucket")))
      .map((x) => ({ t: bucketKey(x.bucket), fiveHourPct: x.fiveHourPct, weeklyPct: x.weeklyPct })),
  }));
  return { window, bucket: hourly ? "hour" : "day", stages, accounts };
}

// ---- retention -----------------------------------------------------------------

/** Drops prompt and output text and tool uses with their runs after RUN_KEEP_MS (ten years). Cutoffs are by id, found through the started_at index. */
export async function pruneRuns(db: Db, nowMs: number = Date.now()): Promise<{ texts: number; runs: number }> {
  const maxBefore = async (ms: number): Promise<number> => (await db.get(db.k.selectFrom("agent_runs").select((eb) => eb.fn.coalesce(eb.fn.max("id"), eb.lit(0)).as("id"))
    .where("started_at", "<", new Date(nowMs - ms).toISOString())))!.id;
  const texts = Number((await db.run(db.k.deleteFrom("agent_run_texts").where("run_id", "<=", await maxBefore(TEXT_KEEP_MS)))).changes);
  const old = await maxBefore(RUN_KEEP_MS);
  await db.run(db.k.deleteFrom("agent_run_tools").where("run_id", "<=", old));
  await db.run(db.k.deleteFrom("agent_run_items").where("run_id", "<=", old));
  const runs = Number((await db.run(db.k.deleteFrom("agent_runs").where("id", "<=", old))).changes);
  return { texts, runs };
}

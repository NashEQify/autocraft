import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentRunFilter, AgentRunState, CostReport, ItemRef } from "../../../web/src/api/types.ts";
import type { KeySource } from "../keys.ts";

import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
/** Hidden repos (empty: no filter) and whether the viewer may read texts. */
export type HiddenRepos = string[] & { visible?: string[] };
export type RunVisibility = { hidden: HiddenRepos; staff: boolean };

export const MAX_ITEM_REFS = 50;
/** Ten years: the item history keeps every model call with its prompt and output. */
export const RUN_KEEP_MS = 3650 * 86_400_000;
export const TEXT_KEEP_MS = RUN_KEEP_MS;
export const RUN_SLOT_MS = 60 * 60_000;
export const TEXT_MAX = 1_000_000;
export const ERROR_MAX = 400;

/** A stored text: gzip, which SQLite keeps as a BLOB. */
export const packText = (s: string): Uint8Array => gzipSync(s);
/** Reads a stored text; rows from before compression hold plain strings. */
export const unpackText = (v: unknown): string | null => (typeof v === "string" ? v : v instanceof Uint8Array ? gunzipSync(v).toString("utf8") : null);
/** A prompt in its stored form (scrubbed by the caller's `scrub`, cut and compressed), for a caller that builds it before a write transaction. */
export const packPrompt = (prompt: string, scrub: (s: string) => string): Uint8Array => packText(scrub(prompt.slice(0, TEXT_MAX)));

export type RunStart = {
  jobId: number | null; step: string; stage: number; promptId: string; promptVersion: string; provider: "claude" | "jev"; model: string;
  items: ItemRef[];
  /** The prompt text (stored scrubbed: `openRun` then needs the caller's `scrub`), or the stored form `packPrompt` made of it. */
  prompt: string | Uint8Array;
  /** A call a Task Runner leased: its user, harness and the model the claim named. */
  remote?: { userLogin: string; harness: string; reportedModel: string };
};
export type RunEnd = {
  id: number; state: Exclude<AgentRunState, "running"> | "cancelled";
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  summary?: string | null; error?: string | null; costUsd?: number | null;
  /** The output text (stored scrubbed: `finishRuns` then needs the caller's `scrub`), or the stored form `packPrompt` made of it. */
  output?: string | Uint8Array | null;
};
export type RunRow = {
  id: number; jobId: number | null; step: string; stage: number; promptId: string; promptVersion: string; provider: "claude" | "jev"; model: string;
  /** At most `MAX_ITEM_REFS`. */
  items: ItemRef[]; itemCount: number; firstRepo: string | null; firstNumber: number | null;
  state: AgentRunState; startedAt: string; endedAt: string | null;
  /** Null until the run ends. */
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
  costUsd: number | null; summary: string | null; error: string | null; progress: string | null;
  userLogin: string | null; harness: string | null; reportedModel: string | null;
};
export type ItemRun = RunRow & { toolCount: number; repo: string; number: number };
export type ToolRow = { runId: number; seq: number; tool: string; args: string | null; resultBytes: number | null; isError: boolean; startedAt: string | null; endedAt: string | null; checkId: number | null };
export type ToolView = Omit<ToolRow, "runId">;
export type RunFilter = Omit<AgentRunFilter, "account">;
/** Texts as stored (`unpackText` reads both forms); null when the viewer is not staff or the run has none. Tool arguments are null for a viewer who is not staff. */
export type RunDetail = { run: RunRow; prompt: Uint8Array | string | null; output: Uint8Array | string | null; tools: ToolView[] };
export type RunningCounts = { repoN: Map<string, number>; stepN: Map<string, number> };

export type Usage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
  /** Subagent use on other models, one entry per model; the fields above count the called model only. */
  extra?: { model: string; usage: Usage }[];
};
export type UsageRow = { runId: string; agent: string; stage: string; model: string; items: number; u: Usage; start: string; end: string };
export type JobUsage = { calls: number; input: number; output: number; costUsd: number | null };
/** `wallSeconds` runs from the model's first start to its last end; `busySeconds` sums its calls' own durations. */
export type UsageModelRow = { model: string; calls: number; items: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; wallSeconds: number; busySeconds: number; first: string | null; last: string | null };
export type UsageReport = Omit<CostReport, "itemsClassified">;
export type PromptSpend = { prompt: string; dayCalls: number; dayUsd: number; weekCalls: number; weekUsd: number };

export type ResultState = "queued" | "pass" | "fail" | "error" | "skipped" | "warn";
export type NightlyResult = { runId: number; checkId: string; taskId: number | null; state: ResultState; summary: string | null; issueNumber: number | null; finishedAt: string | null };
export type NightlyRun = { id: number; repo: string; sha: string; startedAt: string; state: "running" | "done" };
export type NightlySelection = { repo: string; checkId: string; enabled: boolean; crates: string[]; targets: string[] };
export type BenchPoint = { repo: string; bench: string; sha: string; at: string; value: number; unit: string };
export type NightlyCheckState = { enabledChecks: number; recentRun: boolean; queued: { runId: number; checkId: string; taskId: number | null }[] };
export type NightlyGridRow = { selection: NightlySelection[]; runs: (NightlyRun & { results: NightlyResult[] })[]; benches: Map<string, BenchPoint[]> };
export type ReviewRunKeys = Ref[] | KeySource;

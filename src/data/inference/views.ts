// Run reads for pages, the live board, MCP and Discord. Reads that take `vis` apply the hidden-repo test `fragments.runVisible`.
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ItemRun, PromptSpend, Ref, RunDetail, RunFilter, RunRow, RunVisibility } from "./types.ts";

/** A page of runs for the Agents page. */
export async function listRuns(db: Db, f: RunFilter, vis: RunVisibility): Promise<{ rows: RunRow[]; nextCursor: string | null }> { throw new Error("not built: inference.listRuns"); }
/** Run detail; texts only when `vis.staff`. 3 statements in one wave; the caller joins `changes.loadModelChecksOfRun` to the tools. */
export async function loadRun(db: Db, id: number, vis: RunVisibility): Promise<RunDetail | null> { throw new Error("not built: inference.loadRun"); }
/** Runs by id, with no hidden test. */
export async function loadRunsById(db: Db, ids: number[]): Promise<Map<number, RunRow>> { throw new Error("not built: inference.loadRunsById"); }
/** Runs per item in run id order with tool counts. */
export async function loadItemRuns(db: Db, refs: Ref[], vis: RunVisibility, o?: { state?: "running" }): Promise<Map<Ref, ItemRun[]>> { throw new Error("not built: inference.loadItemRuns"); }
/** Calls per job lane of the live board. */
export async function loadJobRuns(db: Db, jobIds: number[], vis: RunVisibility): Promise<Map<number, RunRow[]>> { throw new Error("not built: inference.loadJobRuns"); }
/** Running calls with no job, with their first item. */
export async function loadLooseRuns(db: Db, vis: RunVisibility): Promise<RunRow[]> { throw new Error("not built: inference.loadLooseRuns"); }
/** The worker view's calls: running, or ended after `sinceIso`, newest `limit`, oldest first. */
export async function loadWorkerRuns(db: Db, vis: RunVisibility, sinceIso: string, limit: number): Promise<RunRow[]> { throw new Error("not built: inference.loadWorkerRuns"); }
/** The `model-call` source of the activity stream: one row per run at its first item. */
export async function listRunEvents(db: Db, f: { before?: string; limit: number; vis: RunVisibility }): Promise<(RunRow & { toolCount: number })[]> { throw new Error("not built: inference.listRunEvents"); }
/** Last `samples` done runs per `step:model`, for the live board's estimates. */
export async function loadCallDurations(db: Db, keys: { step: string; model: string }[], samples: number): Promise<Map<string, { startedAt: string; endedAt: string }[]>> { throw new Error("not built: inference.loadCallDurations"); }
/** Last `n` done costs per prompt. */
export async function loadCostSamples(db: Db, promptIds: string[], n: number): Promise<Map<string, number[]>> { throw new Error("not built: inference.loadCostSamples"); }
/** Calls and spend per prompt for the Discord usage table, summed in SQL. */
export async function loadPromptSpend(db: Db, prefix: string, dayIso: string, weekIso: string): Promise<PromptSpend[]> { throw new Error("not built: inference.loadPromptSpend"); }
/** Cost of runs per step since a time. */
export async function loadStepSpend(db: Db, steps: string[], sinceIso: string): Promise<Map<string, number>> { throw new Error("not built: inference.loadStepSpend"); }
/** The highest run id, for the "runs this call made" pattern. */
export async function runWatermark(db: Db): Promise<number> { throw new Error("not built: inference.runWatermark"); }
/** Runs after `after` of the given prompts or item. */
export async function loadRunsAfter(db: Db, after: number, f: { promptIds?: string[]; item?: { repo: string; number: number } }): Promise<{ id: number; summary: string | null; costUsd: number | null }[]> { throw new Error("not built: inference.loadRunsAfter"); }
/** Newest start and running count, the activity poll stamp. */
export async function loadRunStamp(db: Db): Promise<{ newestStartedAt: string | null; running: number }> { throw new Error("not built: inference.loadRunStamp"); }
/** Opus review runs per PR since `todayIso`, for the review gate. */
export async function loadReviewRunCounts(db: Db, keys: Ref[] | KeySource, todayIso: string): Promise<Map<Ref, { n: number; last: string | null }>> { throw new Error("not built: inference.loadReviewRunCounts"); }
/** A login's runs since a time (MCP "my runs"), case-insensitive. */
export async function loadUserRuns(db: Db, login: string, sinceIso: string, limit: number): Promise<RunRow[]> { throw new Error("not built: inference.loadUserRuns"); }
/** The summaries of the last `n` Jev runs. */
export async function loadRecentJevSummaries(db: Db, n: number): Promise<(string | null)[]> { throw new Error("not built: inference.loadRecentJevSummaries"); }
/** Runs per step and time bucket for the Rates page. */
export async function loadRunBuckets(db: Db, o: { from: string; to: string; prefixLen: number; vis: RunVisibility }): Promise<{ step: string; bucket: string; runs: number; failed: number }[]> { throw new Error("not built: inference.loadRunBuckets"); }

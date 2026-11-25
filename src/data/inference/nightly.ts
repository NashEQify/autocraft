// Nightly checks and benchmarks (`nightly_*`).
import type { Db } from "../../db/index.ts";
import type { BenchPoint, NightlyCheckState, NightlyGridRow, NightlyResult, NightlyRun, NightlySelection, ResultState } from "./types.ts";

/** Check selections per repo. */
export async function loadSelections(db: Db, repos: string[]): Promise<Map<string, NightlySelection[]>> { throw new Error("not built: inference.loadSelections"); }
/** Upserts a selection, keeping old crates and targets when not given (read and write share one `db.write`). */
export async function setSelection(db: Db, row: { repo: string; checkId: string; enabled: boolean; crates?: string[]; targets?: string[] }): Promise<void> { throw new Error("not built: inference.setSelection"); }
/** What `nightlyDue` asks per repo: enabled checks, a recent run, queued results. 3 statements. */
export async function loadNightlyState(db: Db, repos: string[], o: { since: string; staleSince: string }): Promise<Map<string, NightlyCheckState>> { throw new Error("not built: inference.loadNightlyState"); }
/** Starts a run; returns its id. */
export async function startRun(db: Db, o: { repo: string; sha: string; at: string }): Promise<number> { throw new Error("not built: inference.startRun"); }
/** Inserts results. */
export async function addResults(db: Db, rows: { runId: number; checkId: string; taskId: number | null; state: ResultState; summary: string | null; finishedAt: string | null }[]): Promise<void> { throw new Error("not built: inference.addResults"); }
/** Open runs per repo. */
export async function loadOpenRuns(db: Db, repos: string[]): Promise<Map<string, NightlyRun[]>> { throw new Error("not built: inference.loadOpenRuns"); }
/** Results per run, optionally of one state. */
export async function loadResults(db: Db, runIds: number[], state?: ResultState): Promise<Map<number, NightlyResult[]>> { throw new Error("not built: inference.loadResults"); }
/** Updates results with `UPDATE ... FROM`. */
export async function setResults(db: Db, rows: { runId: number; checkId: string; state: ResultState; summary: string | null; finishedAt?: string | null; issueNumber?: number | null }[]): Promise<void> { throw new Error("not built: inference.setResults"); }
/** Marks runs `done` when none of their results is `queued`. */
export async function closeRuns(db: Db, runIds: number[]): Promise<number> { throw new Error("not built: inference.closeRuns"); }
/** Earlier results per check, newest first (the failing streak). */
export async function loadHistory(db: Db, repo: string, checkIds: string[], beforeRun: number): Promise<Map<string, NightlyResult[]>> { throw new Error("not built: inference.loadHistory"); }
/** Sets `issue_number` on the failing streak's results. */
export async function markIssue(db: Db, o: { repo: string; checkId: string; runIds: number[]; issue: number }): Promise<void> { throw new Error("not built: inference.markIssue"); }
/** The Nightly page read model; a repo is shown when it has a selection or a run. 4 statements. */
export async function loadNightlyGrid(db: Db, repos: string[], o: { nights: number; sparkPoints: number; window: number }): Promise<Map<string, NightlyGridRow>> { throw new Error("not built: inference.loadNightlyGrid"); }
/** One bench's series. */
export async function loadBenchSeries(db: Db, repo: string, bench: string): Promise<BenchPoint[]> { throw new Error("not built: inference.loadBenchSeries"); }
/** The last `window` earlier values per bench. */
export async function loadBenchPrior(db: Db, repo: string, benches: string[], before: { sha: string; at: string }, window: number): Promise<Map<string, number[]>> { throw new Error("not built: inference.loadBenchPrior"); }
/** Upserts bench points. */
export async function saveBenchPoints(db: Db, rows: BenchPoint[]): Promise<void> { throw new Error("not built: inference.saveBenchPoints"); }
/** Deletes bench points older than the keep window. */
export async function pruneBench(db: Db, nowMs: number): Promise<number> { throw new Error("not built: inference.pruneBench"); }

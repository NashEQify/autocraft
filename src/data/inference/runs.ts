// Run records: write and lifecycle (`agent_runs`, `agent_run_items`, `agent_run_texts`, `agent_run_tools`). No writer opens a transaction or a named lock.
import type { Db } from "../../db/index.ts";
import type { RunEnd, RunStart, ToolRow } from "./types.ts";

/** Inserts the running row, its item rows and its prompt text; runs inside the caller's transaction (`leaseCall` calls it under the login lock). 3 statements. */
export async function openRun(db: Db, s: RunStart): Promise<number> { throw new Error("not built: inference.openRun"); }
/** Ends runs with one `UPDATE ... FROM` guarded by `state = 'running'`, plus one for texts when any end has output. */
export async function finishRuns(db: Db, ends: RunEnd[]): Promise<number> { throw new Error("not built: inference.finishRuns"); }
/** One-line wrapper over `finishRuns`. */
export async function finishRun(db: Db, end: RunEnd): Promise<number> { throw new Error("not built: inference.finishRun"); }
/** Sets the progress line of running runs. */
export async function setRunProgress(db: Db, rows: { id: number; line: string }[]): Promise<number> { throw new Error("not built: inference.setRunProgress"); }
/** Sets the model a Task Runner reported. */
export async function setReportedModel(db: Db, rows: { id: number; model: string }[]): Promise<number> { throw new Error("not built: inference.setReportedModel"); }
/** Fails running runs, except those of adoptable calls of resuming jobs (the runners fragment `keptRunIds`). */
export async function failRunning(db: Db, reason: string, scope?: { jobId: number }): Promise<number> { throw new Error("not built: inference.failRunning"); }
/** Upserts tool rows, 1 statement per 500 rows. */
export async function saveTools(db: Db, rows: ToolRow[]): Promise<void> { throw new Error("not built: inference.saveTools"); }
/** Upserts prompt or output texts, at most 2 statements. */
export async function recordTexts(db: Db, rows: { runId: number; prompt?: string | Uint8Array; output?: string }[]): Promise<void> { throw new Error("not built: inference.recordTexts"); }
/** Deletes texts of runs of the given steps, optionally only finished ones. */
export async function removeRunTexts(db: Db, f: { steps: string[]; finishedOnly: boolean }): Promise<number> { throw new Error("not built: inference.removeRunTexts"); }
/** Deletes old runs and texts as separate lone statements so the writer lock is not held across the large deletes. */
export async function pruneRuns(db: Db, nowMs: number): Promise<{ texts: number; runs: number }> { throw new Error("not built: inference.pruneRuns"); }
/** Guard, not a query: counts a model call as an effect and throws in tests (logs in production) when a transaction is open. */
export function enterModelCall(db: Db, kind: "claude" | "jev" | "workspace"): void { throw new Error("not built: inference.enterModelCall"); }

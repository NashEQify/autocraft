// reads: access.mcp_tokens
// Read models for pages and health checks (package runners-b).
import type { Db } from "../../db/index.ts";
import type { LowerLogin, QueuedCall, ReadyRunner, RunnerHealth, RunnerRow, RunnerSnapshot, Tier } from "./types.ts";

/** The queue and snapshot waves merged: calls, ready runners and the snapshot. 1 RT. */
export async function loadQueueView(db: Db, now: number, o: { showPicker: boolean; canWriteOf?: (login: string, repo: string) => boolean }): Promise<{ calls: QueuedCall[]; runners: ReadyRunner[]; snapshot: RunnerSnapshot }> { throw new Error("not built: runners.loadQueueView"); }
/** Leasing token per run, helpers and private logins for the live board. 3 statements, 1 RT. */
export async function loadRunnerBoard(db: Db, now: number, windowMs: number): Promise<{ leases: Map<number, number>; helpers: RunnerRow[]; private: Set<LowerLogin> }> { throw new Error("not built: runners.loadRunnerBoard"); }
/** Counts and oldest queued time per bucket, last lease time, ready and Manual-only runners, no-taker repos and operators' Interactive slots. 6 statements, 1 RT. */
export async function loadRunnerHealth(db: Db, now: number, th: { queuedMs: number; tierWaitMs: Record<Tier, number>; interactiveWaitMs: number }): Promise<RunnerHealth> { throw new Error("not built: runners.loadRunnerHealth"); }

// The check relay (`remote_checks`) (package runners-b).
import type { Db } from "../../db/index.ts";
import type { RelayedCheck } from "./types.ts";

/** Stores a check a call asked its helper to run. */
export async function requestCheck(db: Db, call: { id: number; runId: number | null }, input: string, now: number): Promise<number> { throw new Error("not built: runners.requestCheck"); }
/** One check row, read through `db.fresh`. */
export async function loadCheckResult(db: Db, id: number): Promise<{ id: number; state: string; result: string | null } | null> { throw new Error("not built: runners.loadCheckResult"); }
/** Marks the call's requested checks `running` in one `UPDATE ... RETURNING`. */
export async function takeRequestedChecks(db: Db, callId: number): Promise<RelayedCheck[]> { throw new Error("not built: runners.takeRequestedChecks"); }
/** Stores results, compare-and-set on `state != 'done'`. */
export async function finishChecks(db: Db, rows: { id: number; result: string }[], now: number): Promise<void> { throw new Error("not built: runners.finishChecks"); }
/** Refuses a call's open checks, or one check, with a text. */
export async function refuseChecks(db: Db, a: { callId: number } | { id: number }, text: string, now: number): Promise<void> { throw new Error("not built: runners.refuseChecks"); }
/** The texts of the checks relayed for a call and run. */
export async function loadRelayedCheckTexts(db: Db, callId: number, runId: number | null): Promise<string[]> { throw new Error("not built: runners.loadRelayedCheckTexts"); }

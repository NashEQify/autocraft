// reads: access.mcp_tokens, access.access
// Runner snapshot and takers (package runners-b).
import type { Db } from "../../db/index.ts";
import type { RunnerSnapshot, SweepState, TakerSweepPlan } from "./types.ts";

/**
 * One `together` wave: runner credentials left-joined to helper status and `access` with lease counts, `user_settings` of those logins,
 * live cool-offs, per-login lease counts, permission denials and started work. Cached 2 s per `Db`, dropped by queue writers.
 */
export async function loadRunnerSnapshot(db: Db, now: number): Promise<RunnerSnapshot> { throw new Error("not built: runners.loadRunnerSnapshot"); }
/** The taker signature the planner reads: the grouped signature, the oldest non-write permission check, and per filtered login the repos it takes. */
export async function loadTakerSignature(db: Db, now: number): Promise<string> { throw new Error("not built: runners.loadTakerSignature"); }
/** What `sweepTakers` needs: snapshot, queue, tracked repos, `remote_no_taker` rows and calls with `no_taker_since`. One wave. */
export async function loadSweepState(db: Db, now: number): Promise<SweepState> { throw new Error("not built: runners.loadSweepState"); }
/** Applies a sweep plan: `remote_no_taker` insert and delete, `no_taker_since` set and clear, then withdraws. Returns the number withdrawn. */
export async function saveTakerSweep(db: Db, plan: TakerSweepPlan, now: number): Promise<number> { throw new Error("not built: runners.saveTakerSweep"); }

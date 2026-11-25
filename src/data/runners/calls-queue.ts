// Enqueue and withdraw calls (package runners-a).
import type { Db } from "../../db/index.ts";
import type { NewCall } from "./types.ts";

/**
 * Queues calls: one read wave (resumed run, parent rows, adoption candidates, item authors), then one write with a multi-row insert of
 * `remote_calls` and `remote_call_items`. A resumed job adopts an equal earlier call instead of inserting.
 */
export async function enqueueCalls(db: Db, calls: NewCall[], now?: number): Promise<number[]> { throw new Error("not built: runners.enqueueCalls"); }
/** One-call wrapper over `enqueueCalls`. */
export async function enqueueCall(db: Db, call: NewCall, now?: number): Promise<number> { throw new Error("not built: runners.enqueueCall"); }
/** Withdraws calls in the given states with a per-row reason and finishes their runs in the same transaction. Returns the ids withdrawn. */
export async function withdrawCalls(db: Db, rows: { id: number; reason: string }[], opts?: { states?: string[]; now?: number }): Promise<number[]> { throw new Error("not built: runners.withdrawCalls"); }
/** Withdraws the open calls of a job, or of every job except resuming ones, and finishes their runs. */
export async function withdrawJobCalls(db: Db, reason: string, jobId?: number): Promise<number> { throw new Error("not built: runners.withdrawJobCalls"); }
/** Withdraws the open queued calls whose only item is `ref`. */
export async function withdrawItemCalls(db: Db, ref: string, reason: string): Promise<number> { throw new Error("not built: runners.withdrawItemCalls"); }
/** Withdraws queued or leased `conversation.turn` calls bound to `forLogin` that name `ref`. */
export async function withdrawTurnCalls(db: Db, a: { ref: string; forLogin: string; reason: string }): Promise<number> { throw new Error("not built: runners.withdrawTurnCalls"); }
/** Sets the claim level of the queued calls of each item. */
export async function setCallLevels(db: Db, rows: { ref: string; level: number }[]): Promise<number> { throw new Error("not built: runners.setCallLevels"); }
/** Stamps `seen_at` on the calls a process awaits. */
export async function markCallersSeen(db: Db, ids: number[], now: number): Promise<void> { throw new Error("not built: runners.markCallersSeen"); }
/** Clears `reply` on the done calls of the jobs. */
export async function clearJobReplies(db: Db, jobIds: number[]): Promise<number> { throw new Error("not built: runners.clearJobReplies"); }

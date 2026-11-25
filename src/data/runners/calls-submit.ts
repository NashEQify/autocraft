// Lease completion writers (package runners-a).
import type { Db } from "../../db/index.ts";
import type { LiveLease, ParsedSubmit, RefusalRetry, SubmitResult } from "./types.ts";

/** Stores a validated reply: compare-and-set to `done` (or the requeue or refusal write), success note, reported model and tools, in one transaction. */
export async function submitLease(db: Db, lease: LiveLease, s: ParsedSubmit): Promise<SubmitResult> { throw new Error("not built: runners.submitLease"); }
/** Requeues with the helper's error, notes the failure and the last attempt's usage, in one transaction. */
export async function failLease(db: Db, lease: LiveLease, f: { error: string; skipLogin: boolean; usage: unknown; duration: number }, now: number): Promise<boolean> { throw new Error("not built: runners.failLease"); }
/** The safety-filter case: update, tombstone and run finish; `to` is decided by the pure `refusalRetry`. */
export async function refuseLease(db: Db, lease: LiveLease, to: RefusalRetry, a: { reason: string; tokenId: number }, now: number): Promise<boolean> { throw new Error("not built: runners.refuseLease"); }
/** Unleases with `released_by`, tombstone and run finish. */
export async function releaseLease(db: Db, lease: LiveLease, reason: string, now: number): Promise<boolean> { throw new Error("not built: runners.releaseLease"); }

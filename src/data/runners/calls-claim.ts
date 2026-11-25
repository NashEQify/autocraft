// Claim reads and the orphan return (package runners-a).
import type { Db } from "../../db/index.ts";
import type { ClaimCaller, ClaimFacts, LeaseSource, QueueSnapshot, RunnerSnapshot } from "./types.ts";

/** Wave A of a claim: role and idle flag, cool-off, settings, lease counts, queue signature, orphan lease, liveness, lost and gone reads. About 9 statements, 1 RT. */
export async function loadClaimFacts(db: Db, caller: ClaimCaller, opts: { requestId?: string; now: number }): Promise<ClaimFacts> { throw new Error("not built: runners.loadClaimFacts"); }
/** Wave B, only on a cache miss: the queue and the runner snapshot in one wave, cached 2 s. */
export async function loadClaimWave(db: Db, caller: ClaimCaller, facts: ClaimFacts, now: number): Promise<{ queue: QueueSnapshot; snapshot: RunnerSnapshot }> { throw new Error("not built: runners.loadClaimWave"); }
/** The queued call about to be leased, with its bundle (not in the queue read). */
export async function loadLeaseSource(db: Db, id: number): Promise<LeaseSource | null> { throw new Error("not built: runners.loadLeaseSource"); }
/** Records an idle helper's tiers and repos. */
export async function markHelperIdle(db: Db, tokenId: number, a: { now: number; tiers: string[]; repos: string[] }): Promise<void> { throw new Error("not built: runners.markHelperIdle"); }
/** Clears picks of calls, optionally only those of `login`. */
export async function clearPicks(db: Db, ids: number[], login?: string): Promise<number> { throw new Error("not built: runners.clearPicks"); }
/** Returns the lease a repeated claim took before a restart: unlease, tombstone and run failure in one transaction. */
export async function returnOrphanLease(db: Db, orphan: { id: number; runId: number | null; leaseSecretHash: string | null }, now: number): Promise<void> { throw new Error("not built: runners.returnOrphanLease"); }

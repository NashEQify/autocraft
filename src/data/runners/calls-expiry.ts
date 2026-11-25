// Lease expiry, liveness and lease state reads (package runners-a).
import type { Db } from "../../db/index.ts";
import type { ClaimFacts, ExpiryResult } from "./types.ts";

/**
 * Requeues or fails lost leases (`kx.updateFrom`, compare-and-set on state, attempt and `leased_at`), writes tombstones, finishes the runs,
 * notes drops, and withdraws calls whose caller is gone, in one transaction after one read wave unless `facts` carries the reads.
 */
export async function expireLeases(db: Db, o: { now: number; ids?: number[]; facts?: ClaimFacts }): Promise<ExpiryResult> { throw new Error("not built: runners.expireLeases"); }
/** The call by secret hash, else its tombstone, as one statement. */
export async function loadLeaseState(db: Db, secret: string): Promise<{ id: number; live: boolean } | null> { throw new Error("not built: runners.loadLeaseState"); }
/** Deletes old calls, tombstones, drops, checks, passages and cool-offs in one transaction. */
export async function pruneRemote(db: Db, now: number): Promise<void> { throw new Error("not built: runners.pruneRemote"); }
/** Stamps `remote_liveness`; one statement usually, a transaction after a gap. */
export async function stampAlive(db: Db, now: number): Promise<void> { throw new Error("not built: runners.stampAlive"); }
/** The liveness stamp. */
export async function loadLiveness(db: Db, now: number): Promise<{ alive: boolean; since: number }> { throw new Error("not built: runners.loadLiveness"); }

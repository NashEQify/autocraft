// Cool-offs after repeated drops or failures (`remote_cooloffs`, `remote_lease_drops`) (package runners-b).
import type { Db } from "../../db/index.ts";
import type { LowerLogin } from "./types.ts";

/**
 * Records dropped leases: one read wave, the sequential rule over the batch in memory, then multi-row inserts of drops, an upsert of
 * cool-offs, a delete of the logins' drops and audit rows. Returns the logins that started a cool-off.
 */
export async function noteDrops(db: Db, drops: { tokenId: number; login: string; callId: number }[], now: number): Promise<string[]> { throw new Error("not built: runners.noteDrops"); }
/** Counts a failure against the login; cools it off at the limit. */
export async function noteFailure(db: Db, login: string, now: number): Promise<void> { throw new Error("not built: runners.noteFailure"); }
/** Resets failure counts; joins `submitLease`'s transaction. */
export async function noteSuccess(db: Db, logins: string[]): Promise<void> { throw new Error("not built: runners.noteSuccess"); }
/** Ends a cool-off, deletes the login's drops and audits when it was cooling off. */
export async function clearCooloff(db: Db, login: string, by: string, now: number): Promise<boolean> { throw new Error("not built: runners.clearCooloff"); }
/** Live cool-offs per login. */
export async function loadCooloffs(db: Db, logins: string[], now: number): Promise<Map<LowerLogin, { until: string; reason: string }>> { throw new Error("not built: runners.loadCooloffs"); }

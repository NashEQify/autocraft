// reads: workflow.item_workflows, implement.implementations, access.mcp_tokens, access.access
// The conditions that must hold at the instant of the lease, under the login's lock, so they cannot be loaded beforehand.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import type { Eb } from "../../db/kx.ts";
import type { LiveLease } from "./types.ts";

/**
 * The started-work condition inside the lease update: every item of the call (`remote_call_items`) has a live workflow started or
 * approved by `login`, or is the PR of a current attempt of one.
 */
export function startedWorkAllows(db: Db, eb: Eb, login: string, callIdRef: string): Expression<SqlBool> { throw new Error("not built: runners.startedWorkAllows"); }
/** The call by lease secret joined to the runner credential (`mcp_tokens`, `access`), with a `lost` flag. 1 statement; the slow path runs `expireLeases` or `unlease`. */
export async function loadLiveLease(db: Db, secret: string, now: number): Promise<LiveLease | null> { throw new Error("not built: runners.loadLiveLease"); }
/** The live lease with its bundle, harness and reference repo in one statement. */
export async function loadLeaseBundle(db: Db, secret: string, now: number): Promise<{ lease: LiveLease; bundle: string; harness: string | null; referenceRepo: string | null } | null> { throw new Error("not built: runners.loadLeaseBundle"); }
/** Fast path of a heartbeat: one compare-and-set update guarded by the lease, the lost test and a valid credential. */
export async function heartbeatLease(db: Db, secret: string, h: { progress: string | null; phase: string | null }, now: number): Promise<{ runId: number | null } | null> { throw new Error("not built: runners.heartbeatLease"); }

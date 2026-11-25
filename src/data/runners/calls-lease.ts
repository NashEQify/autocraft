// The lease writer (package runners-a).
import type { Db } from "../../db/index.ts";
import type { Lease, LeaseRequest } from "./types.ts";

/**
 * Leases a call inside one transaction under the module lock `remote-lease:<login>`: opens the agent run, then one compare-and-set
 * `UPDATE remote_calls ... WHERE state = 'queued'` with every condition in the statement, then clears the helper's idle mark.
 * A miss runs one diagnostic read and rolls back. Must not be called inside an outer `db.write`.
 */
export async function leaseCall(db: Db, req: LeaseRequest): Promise<Lease | "limit" | "gone" | null> { throw new Error("not built: runners.leaseCall"); }

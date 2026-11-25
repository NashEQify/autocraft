// reads: access.mcp_tokens
// Task Runner helpers (`remote_helpers`) (package runners-b).
import type { Db } from "../../db/index.ts";
import type { HelperInfo, HelperStatus, LowerLogin, Machine } from "./types.ts";

/** Upserts a helper's status, including `machine`. */
export async function saveHelperStatus(db: Db, tokenId: number, login: string, s: HelperStatus, now: number): Promise<void> { throw new Error("not built: runners.saveHelperStatus"); }
/** Creates a helper stub row; called by `access` in its token-creation transaction. */
export async function addHelper(db: Db, a: { tokenId: number; login: string; machine: Machine | null; helperVersion: string | null }): Promise<void> { throw new Error("not built: runners.addHelper"); }
/** Deletes helper rows; called by `access` when it deletes tokens. */
export async function removeHelpers(db: Db, tokenIds: number[]): Promise<void> { throw new Error("not built: runners.removeHelpers"); }
/** Helpers per login with machine, version, times and scopes (one cross read of `mcp_tokens`) and cool-offs. 2 statements, 1 RT. */
export async function loadHelpers(db: Db, logins: string[], now: number): Promise<Map<LowerLogin, HelperInfo[]>> { throw new Error("not built: runners.loadHelpers"); }
/** The logins that have a fresh ready runner. */
export async function hasFreshRunners(db: Db, logins: string[], now: number): Promise<Set<LowerLogin>> { throw new Error("not built: runners.hasFreshRunners"); }

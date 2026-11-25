// The planner's merge facts (package merge-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { BatchMembership, MergeFacts, RefKey } from "./types.ts";

/**
 * Every merge fact the planner needs for `keys`: attempts, merged history, verifications, run approvals, unknown state, batch
 * membership. 7 statements in one `together` wave whatever the key count.
 */
export async function loadMergeFacts(db: Db, keys: KeySource): Promise<MergeFacts> { throw new Error("not built: merge.loadMergeFacts"); }
/** The active batch of each PR in `keys`. 1 statement. */
export async function loadBatchMembership(db: Db, keys: KeySource): Promise<Map<RefKey, BatchMembership>> { throw new Error("not built: merge.loadBatchMembership"); }
/** Integration PRs we opened, optionally of some repos. 1 statement. */
export async function loadOwnIntegration(db: Db, repos?: string[]): Promise<Set<RefKey>> { throw new Error("not built: merge.loadOwnIntegration"); }

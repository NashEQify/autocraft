// Mergeable-unknown state (`merge_state`) (package merge-a).
import type { Db } from "../../db/index.ts";
import type { PrChecks, RefKey, UnknownState } from "./types.ts";

/** Upserts the rows waiting on GitHub's mergeable answer (`reads + 1` at the same head, reset at a new head) and deletes the rest. `taken` is loaded by the caller. */
export async function noteMergeable(db: Db, rows: PrChecks[], at: string, taken: Set<string>): Promise<void> { throw new Error("not built: merge.noteMergeable"); }
/** `merge_state` rows of the repo that are open PRs. 1 statement. */
export async function loadUnknownDue(db: Db, repo: string): Promise<{ number: number; state: UnknownState }[]> { throw new Error("not built: merge.loadUnknownDue"); }
/** Marks rows stuck after a read through the REST API; a row rewritten meanwhile does not match. Returns the rows changed. */
export async function markUnknownStuck(db: Db, rows: { repo: string; number: number; head: string; reads: number }[]): Promise<number> { throw new Error("not built: merge.markUnknownStuck"); }
/** Removes rows of closed or merged PRs, by repo or by keys. Returns the rows removed. */
export async function removeMergeState(db: Db, f: { repo: string; closed: true } | { keys: { repo: string; number: number }[] }): Promise<number> { throw new Error("not built: merge.removeMergeState"); }

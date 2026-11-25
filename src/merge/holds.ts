// Merge holds: a held PR is reviewed and fixed as usual but does not merge, alone or in a batch, until released.
// Different from Backlog, which stops all work on the item. A hold of a closed or merged PR is ignored.
import { loadHolds } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** Held PRs as `repo#number`, optionally of one repo. */
export async function mergeHolds(db: Db, repo?: string): Promise<Set<string>> {
  return new Set((await loadHolds(db, repo === undefined ? {} : { repo })).keys());
}

export const mergeHeld = async (db: Db, repo: string, number: number): Promise<boolean> =>
  (await loadHolds(db, { refs: [{ repo, number }] })).size > 0;

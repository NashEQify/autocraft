// Merge holds: a held PR is reviewed and fixed as usual but does not merge, alone or in a batch, until released.
// Different from Backlog, which stops all work on the item. A hold of a closed or merged PR is ignored.
import type { Db } from "../db/index.ts";

/** Held PRs as `repo#number`, optionally of one repo. */
export async function mergeHolds(db: Db, repo?: string): Promise<Set<string>> {
  const rows = await db.prepare(`SELECT repo, number FROM main.merge_holds ${repo ? "WHERE repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { repo: string; number: number }[];
  return new Set(rows.map((r) => `${r.repo}#${r.number}`));
}

export const mergeHeld = async (db: Db, repo: string, number: number): Promise<boolean> =>
  await db.prepare("SELECT 1 FROM main.merge_holds WHERE repo = ? AND number = ?").get(repo, number) !== undefined;

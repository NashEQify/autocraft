// Whether a repo has upstream CI at all; shared by the merge queue, Verify and the database migration.
import type { Db } from "../db/index.ts";

/** Checks of the repo's most recent PRs that were read; a repo has no CI when none of them ever reported a check. */
export const NO_CI_SAMPLE = 20;
/** Whether any checks of the repo were read yet; before that, whether it has CI is unknown. */
export const repoChecksKnown = async (db: Db, repo: string): Promise<boolean> => !!await db.prepare("SELECT 1 FROM pr_checks WHERE repo = ? LIMIT 1").get(repo);
/** True when the repo has checks fetched for some PRs and none of the latest NO_CI_SAMPLE reported any. */
export async function repoHasNoCi(db: Db, repo: string): Promise<boolean> {
  return noCiFrom(await db.prepare(NO_CI_SQL).all(repo, NO_CI_SAMPLE) as { overall: string | null }[]);
}

/** The latest checks of one repo, newest first (parameters: repo, NO_CI_SAMPLE). */
export const NO_CI_SQL = "SELECT overall FROM pr_checks WHERE repo = ? ORDER BY fetched_at DESC LIMIT ?";

/** repoHasNoCi() from the rows of NO_CI_SQL. */
export const noCiFrom = (rows: { overall: string | null }[]): boolean => rows.length > 0 && rows.every((r) => !r.overall || r.overall === "none");

/** repoHasNoCi() for every repo, from one reading of each repo's latest NO_CI_SAMPLE checks. */
export async function reposWithNoCi(db: Db): Promise<Set<string>> {
  const seen = new Map<string, boolean>();
  for (const r of await db.prepare(`SELECT repo, overall FROM (SELECT repo, overall, ROW_NUMBER() OVER (PARTITION BY repo ORDER BY fetched_at DESC) AS n FROM pr_checks) WHERE n <= ?`).all(NO_CI_SAMPLE) as { repo: string; overall: string | null }[])
    seen.set(r.repo, (seen.get(r.repo) ?? true) && (!r.overall || r.overall === "none"));
  return new Set([...seen].filter(([, none]) => none).map(([repo]) => repo));
}

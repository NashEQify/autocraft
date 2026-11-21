// The quiet pull request of a security fix: opened by the Land step, in the pipeline's name, and kept free of anything that
// names the problem from the moment it opens until the advisory is published. One definition for every place that asks.
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { ref, type Eb, type Ex } from "../db/kx.ts";

/** SQL condition: the findings whose pull request is quiet (the quiet route has no fork). */
export const QUIET_FINDING_SQL = "state IN ('landing', 'landed') AND fork IS NULL AND fix_pr IS NOT NULL";

/** SQL condition on item expressions `repo` and `number`: the item is a quiet pull request. */
export const quietSqlFor = (repo: string, number: string): string =>
  `(EXISTS (SELECT 1 FROM main.security_findings qf WHERE qf.repo = ${repo} AND qf.fix_pr = ${number} AND qf.state IN ('landing', 'landed') AND qf.fork IS NULL)
    OR EXISTS (SELECT 1 FROM main.security_quiet_prs qp JOIN main.security_findings qg ON qg.repo = qp.repo AND qg.number = qp.finding WHERE qp.repo = ${repo} AND qp.pr = ${number} AND ${FORMER_OPEN_SQL}))`;

/** `quietSqlFor` as an expression: `repo` and `number` are column references or values (`eb.val(v)`). */
export function quietExprFor(db: Db, eb: Eb, repo: Ex, number: Ex): AliasableExpression<SqlBool> {
  return eb.or([
    eb.exists(db.k.selectFrom("main.security_findings as qf").select(eb.lit(1).as("one"))
      .where("qf.repo", "=", ref<string>(repo)).where("qf.fix_pr", "=", ref<number>(number)).where("qf.state", "in", ["landing", "landed"]).where("qf.fork", "is", null)),
    eb.exists(db.k.selectFrom("main.security_quiet_prs as qp")
      .innerJoin("main.security_findings as qg", (j) => j.onRef("qg.repo", "=", "qp.repo").onRef("qg.number", "=", "qp.finding"))
      .select(eb.lit(1).as("one"))
      .where("qp.repo", "=", ref<string>(repo)).where("qp.pr", "=", ref<number>(number)).where("qg.state", "not in", FORMER_CLOSED)),
  ]);
}

/** The finding states after which a closed quiet pull request is no longer quiet (FORMER_OPEN_SQL). */
const FORMER_CLOSED = ["published", "dismissed"];

/** A closed quiet pull request stays quiet while its finding is neither published nor dismissed. */
const FORMER_OPEN_SQL = "qg.state NOT IN ('published', 'dismissed')";

/** Remembers that `pr` was the quiet pull request of a finding; call before the finding's fix_pr is cleared. */
export async function rememberQuietPr(db: Db, repo: string, finding: number, pr: number): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO main.security_quiet_prs (repo, pr, finding) VALUES (?, ?, ?)").run(repo, pr, finding);
}

/** Quiet pull requests as `repo#number`. */
export async function quietFixPrs(db: Db, repo?: string): Promise<Set<string>> {
  const rows = await db.prepare(`SELECT repo, fix_pr AS n FROM main.security_findings WHERE ${QUIET_FINDING_SQL}${repo ? " AND repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { repo: string; n: number }[];
  const former = await db.prepare(`SELECT qp.repo, qp.pr AS n FROM main.security_quiet_prs qp JOIN main.security_findings qg ON qg.repo = qp.repo AND qg.number = qp.finding WHERE ${FORMER_OPEN_SQL}${repo ? " AND qp.repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { repo: string; n: number }[];
  return new Set([...rows, ...former].map((r) => `${r.repo}#${r.n}`));
}

/** True when `repo#number` is a quiet pull request. */
export const isQuiet = async (db: Db, repo: string, number: number): Promise<boolean> =>
  !!await db.prepare(`SELECT 1 FROM main.security_findings WHERE repo = ? AND fix_pr = ? AND ${QUIET_FINDING_SQL} LIMIT 1`).get(repo, number) ||
  !!await db.prepare(`SELECT 1 FROM main.security_quiet_prs qp JOIN main.security_findings qg ON qg.repo = qp.repo AND qg.number = qp.finding WHERE qp.repo = ? AND qp.pr = ? AND ${FORMER_OPEN_SQL} LIMIT 1`).get(repo, number);

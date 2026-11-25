// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import * as kx from "../../db/kx.ts";

/** The number of the post-merge PR whose follow-up issue is `repo#number`, or null. */
export const followupParentOf = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): Expression<number | null> =>
  kx.schemaEb(eb).selectFrom("main.postmerge_followups as pf").select("pf.number").where("pf.repo", "=", kx.exprOf(eb, repo)).where("pf.issue_number", "=", kx.exprOf(eb, number)).limit(1) as unknown as Expression<number | null>;

/** The PR has an Opus review with a take or take-fix verdict. */
export const hasTakeReview = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.opus_reviews as tr").select(eb.lit(1).as("one")).where("tr.repo", "=", kx.exprOf(eb, repo)).where("tr.number", "=", kx.exprOf(eb, number)).where("tr.verdict", "in", ["take", "take-fix"]));

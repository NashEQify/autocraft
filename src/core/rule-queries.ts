// The merge rule's SQL fragments in rules.ts as builder queries. Kept apart from rules.ts, which the web client imports.
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { like, type Eb } from "../db/kx.ts";

/** `UNSURE_AT_SQL` as a query: a take or take-fix review with sure = 0 at the head, in the history or the current reviews. */
export const unsureAtQuery = (db: Db, repo: string, number: number, head: string) => db.k.selectFrom("opus_review_history").select((eb) => eb.lit(1).as("one"))
  .where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "in", ["take", "take-fix"]).where("sure", "=", 0)
  .unionAll(db.k.selectFrom("opus_reviews").select((eb) => eb.lit(1).as("one"))
    .where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "in", ["take", "take-fix"]).where("sure", "=", 0))
  .limit(1);

/** `OPEN_GROUP_SQL` as an expression on `g` (a decisions row). */
export const openGroupExpr = (db: Db, eb: Eb): AliasableExpression<SqlBool> => eb.and([
  eb("g.kind", "=", "duplicate"),
  like(db, "g.id", eb.val("%:dupegroup:%")),
  eb.or([
    eb("g.answer", "is", null),
    eb.and([
      like(db, "g.answer", eb.val("keep:%")),
      eb(eb.fn.coalesce(db.k.selectFrom("dupe_groups as dg").select("dg.applied_answer").where("dg.decision_id", "=", eb.ref("g.id")), eb.val("")), "<>", eb.ref("g.answer")),
    ]),
  ]),
]);

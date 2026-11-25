// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { sql } from "../../db/sql.ts";
import { registerKeySource } from "../keys.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/fragments.ts";
import * as intake from "../intake/fragments.ts";
import * as access from "../access/fragments.ts";
import * as review from "../review/fragments.ts";
import * as security from "../security/fragments.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
/** Live states of `item_workflows`, spelled out so the SQL needs no import of the store. */
export const LIVE_STATES = ["running", "waiting", "blocked", "recommending"];

/** The item has a live workflow, or is the PR of a live implement workflow. */
export function liveWorkflowExpr(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  return eb.exists(t.selectFrom("main.item_workflows as pw").select(one(eb)).where("pw.repo", "=", r).where("pw.state", "in", LIVE_STATES)
    .where((w) => w.or([
      w("pw.number", "=", n),
      w.and([w("pw.entry", "=", "implement"), w.exists(t.selectFrom("main.implementations as pwi").select(one(eb))
        .where("pwi.repo", "=", w.ref("pw.repo")).where("pwi.number", "=", w.ref("pw.number")).where("pwi.pr_number", "=", n))]),
    ])));
}

/**
 * The item is in the pipeline: `liveWorkflowExpr`, or auto-eligible (the repo's pipeline is on, an outside-author hold does not keep it back,
 * a pilot list narrows it only when set, and a follow-up issue of an in-scope merged PR or a quiet security PR counts). Not ended by a person
 * (stopped, backlog).
 */
export function inScopeExpr(db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const endedByPerson = t.selectFrom("main.item_workflows as ew").select(one(eb)).where("ew.repo", "=", r).where("ew.number", "=", n).where("ew.state", "in", ["stopped", "backlog", "closed"])
    .where((w) => w.not(w.exists(t.selectFrom("main.item_workflows as lw").select(one(eb)).where("lw.repo", "=", kx.ref<string>("ew.repo")).where("lw.number", "=", kx.ref<number>("ew.number")).where("lw.state", "in", LIVE_STATES))))
    .where("ew.id", "=", t.selectFrom("main.item_workflows as mw").select((e) => e.fn.max("mw.id").as("m")).where("mw.repo", "=", kx.ref<string>("ew.repo")).where("mw.number", "=", kx.ref<number>("ew.number")));
  return eb.or([
    liveWorkflowExpr(eb, repo, number),
    eb.and([
      control.pipelineOn(eb, repo),
      eb.not(intake.heldExpr(eb, repo, number)),
      eb.not(eb.exists(endedByPerson)),
      eb.or([
        control.pilotNarrows(db, eb, repo, number),
        security.quietPrExpr(eb, repo, number),
        eb(review.followupParentOf(eb, repo, number), "is not", null),
      ]),
    ]),
  ]);
}

/** The work score of the item (`1e15 + weight * 1e12 - id` of its live workflow, or of the live implement workflow of its issue), falling back to `fallback`. */
export function weightScoreExpr(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, fallback: kx.Ex): Expression<number> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const score = t.selectFrom("main.item_workflows as sw").select((e) => e.fn.max(sql<number>`1e15 + sw.weight * 1e12 - sw.id`).as("s"))
    .where("sw.repo", "=", r).where("sw.state", "in", LIVE_STATES).where((w) => w.or([
      w("sw.number", "=", n),
      w.and([w("sw.entry", "=", "implement"), w.exists(t.selectFrom("main.implementations as si").select(one(eb)).where("si.repo", "=", kx.ref<string>("sw.repo")).where("si.number", "=", kx.ref<number>("sw.number")).where("si.pr_number", "=", n))]),
    ]));
  return eb.fn.coalesce(score, kx.exprOf(eb, fallback)) as unknown as Expression<number>;
}

/** Every ref of a call (`refs`, a column holding JSON or the caller's list) has a live workflow the login started or approved, directly or through an implementation PR. */
export function boundToExpr(db: Db, eb: kx.AnyEb, refs: readonly { repo: string; number: number }[], login: string): AliasableExpression<SqlBool> {
  if (!refs.length) return eb.val(false) as unknown as AliasableExpression<SqlBool>;
  return eb.and(refs.map((ref) => {
    const t = kx.schemaEb(eb);
    return eb.exists(t.selectFrom("main.item_workflows as bw").select(one(eb)).where("bw.repo", "=", ref.repo).where("bw.state", "in", LIVE_STATES)
      .where((w) => w.or([kx.ciEq(db, "bw.started_by", login), kx.ciEq(db, "bw.approved_by", login)]))
      .where((w) => w.or([
        w("bw.number", "=", ref.number),
        w.and([w("bw.entry", "=", "implement"), w.exists(t.selectFrom("main.implementations as bi").select(one(eb)).where("bi.repo", "=", kx.ref<string>("bw.repo")).where("bi.number", "=", kx.ref<number>("bw.number")).where("bi.pr_number", "=", ref.number))]),
      ])));
  })) as AliasableExpression<SqlBool>;
}

/** The PR has a merge hold. */
export const mergeHeldExpr = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.merge_holds as mh").select(one(eb)).where("mh.repo", "=", kx.exprOf(eb, repo)).where("mh.number", "=", kx.exprOf(eb, number)));

/** A live workflow in `recommending` or `blocked`: it needs a person. */
export const needsPerson = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as np").select(one(eb)).where("np.repo", "=", kx.exprOf(eb, repo)).where("np.number", "=", kx.exprOf(eb, number)).where("np.state", "in", ["recommending", "blocked"]));

/** The repo has a live workflow. */
export const startedRepo = (eb: kx.AnyEb, repoCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as sr").select(one(eb)).where("sr.repo", "=", kx.exprOf(eb, repoCol)).where("sr.state", "in", LIVE_STATES));

/** Items with a live workflow, optionally of some repos. */
registerKeySource<{ repos?: string[] }>("workflow.liveItems", (db, o) =>
  queryDb(db).k.selectFrom("main.item_workflows as kw").select(["kw.repo", "kw.number"]).where("kw.state", "in", LIVE_STATES)
    .$if(!!o.repos, (b) => b.where(kx.inList(db, "kw.repo", o.repos!))));

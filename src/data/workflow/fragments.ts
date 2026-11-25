// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { registerKeySource } from "../keys.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/fragments.ts";
import * as intake from "../intake/fragments.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
/** Live states of `item_workflows`, spelled out so the SQL needs no import of the store. */
export const LIVE_STATES = ["running", "waiting", "blocked", "recommending"];

/**
 * `kind` (a column of workflow_events) is not `archived`: what happened in the maintainer workflow, without the history of the decision system before it,
 * whose rows are written later than what they record. Written as the partial indexes of workflow_events write it.
 */
export const notArchived = (eb: kx.AnyEb, kind: string): Expression<SqlBool> => eb(kind, "<>", kx.literal("archived"));

/** Attempt states that no longer work a PR (src/implement/types.ts ENDED_STATES). */
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];

/**
 * The attempt `i` is one the implement workflow `w` of its issue works on: the current one, or one that ended in it. An attempt that ended
 * before the workflow started belongs to an earlier one, and its PR (reopened, say) is no work of this one.
 */
export const attemptOf = (eb: kx.AnyEb, i: string, w: string): Expression<SqlBool> =>
  eb.or([eb(`${i}.state`, "not in", ENDED_ATTEMPTS), eb(`${i}.updated_at`, ">=", eb.ref(`${w}.started_at`))]);

/** A live workflow approved for merge (an approver, or a merge entry) handed the PR over to the merge queue at `head`: its leg is queued there. */
export const handedOverAt = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, head: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.preapprovals as hl").innerJoin("main.item_workflows as hw", "hw.id", "hl.workflow_id").select(one(eb))
    .where("hl.repo", "=", kx.exprOf(eb, repo)).where("hl.number", "=", kx.exprOf(eb, number)).where("hl.head", "=", kx.exprOf(eb, head)).where("hl.state", "=", "queued")
    .where("hw.state", "in", LIVE_STATES).where((w) => w.or([w("hw.approved_by", "is not", null), w("hw.entry", "=", "merge")])));

/** The item has a live workflow, or is the PR of a live implement workflow. */
export function liveWorkflowExpr(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  // One probe by item and one by PR, each on its index: a single subquery with both would read every live workflow for every item.
  return eb.or([
    eb.exists(t.selectFrom("main.item_workflows as pw").select(one(eb)).where("pw.repo", "=", r).where("pw.number", "=", n).where("pw.state", "in", LIVE_STATES)),
    eb.exists(t.selectFrom("main.implementations as pwi").innerJoin("main.item_workflows as pw", (j) => j.onRef("pw.repo", "=", "pwi.repo").onRef("pw.number", "=", "pwi.number")).select(one(eb))
      .where("pwi.repo", "=", r).where("pwi.pr_number", "=", n).where("pw.entry", "=", "implement").where("pw.state", "in", LIVE_STATES).where((w) => attemptOf(w, "pwi", "pw"))),
  ]);
}

/** `1e15 + weight * 1e12 - id` of the workflow row aliased `w`: what orders started items. */
export const workScore = (eb: any): AliasableExpression<number> => eb(eb(eb.lit(1e15), "+", eb("w.weight", "*", eb.lit(1e12))), "-", eb.ref("w.id"));

/** The work score `s` of every item with a live workflow and of the PR of a live implement workflow, the highest when both apply. */
export function workScores(db: Db): SelectQueryBuilder<any, any, { repo: string; number: number; s: number }> {
  const k = queryDb(db).k as any;
  const own = k.selectFrom("main.item_workflows as w").select((eb: any) => ["w.repo as repo", "w.number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES);
  const viaPr = k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .select((eb: any) => ["i.repo as repo", "i.pr_number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES).where("w.entry", "=", "implement").where("i.pr_number", "is not", null).where((eb: any) => attemptOf(eb, "i", "w"));
  return k.selectFrom(own.unionAll(viaPr).as("ws")).select((eb: any) => ["ws.repo", "ws.number", eb.fn.max("ws.s").as("s")]).groupBy(["ws.repo", "ws.number"]);
}

/**
 * The item is in the pipeline: `liveWorkflowExpr`, or auto-eligible (the repo's pipeline is on and an outside-author hold does not keep it back). Not ended
 * by a person (stopped, backlog, closed).
 */
export function inScopeExpr(_db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
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
    ]),
  ]);
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
        w.and([w("bw.entry", "=", "implement"), w.exists(t.selectFrom("main.implementations as bi").select(one(eb)).where("bi.repo", "=", kx.ref<string>("bw.repo")).where("bi.number", "=", kx.ref<number>("bw.number")).where("bi.pr_number", "=", ref.number).where((x) => attemptOf(x, "bi", "bw")))]),
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

// Key sources of a planner pass, and predicates other modules embed.
import type { Expression, SqlBool, SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { PASS_SOURCES, registerKeySource, resolveKeys, type KeyRow, type KeySource, type Ref } from "../keys.ts";
import { ENDED_STATES } from "../implement/types.ts";

/** A change log longer than this selects nothing: the pass becomes a full pass (core/plan-changes.ts). */
const CHANGES_CAP = 50_000;
/** `due` lists above this many refs make `changedPass` equivalent to a full pass. */
const DUE_MAX = 10_000;
/** The queue states of core/plan.ts (a value import from feature code is not allowed here). */
const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "waiting-premerge", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "declined", "merged", "held-duplicate", "held-backlog",
  "batch-checking", "in-batch", "batch-failed", "ci-approval", "changes-requested", "waiting-main-ci",
] as const;

// S1: the full pass composes the owners' fragments (mirror open items, review take reviews, control tracked repos) once
// their modules are merged; until then it names `items`, `final_reviews` and `tracked_repos` directly.
registerKeySource<undefined>(PASS_SOURCES.full, (db) => {
  const k = queryDb(db).k;
  return k.selectFrom("items as i").select(["i.repo as repo", "i.number as number"])
    .where((eb) => eb.or([
      eb.and([eb("i.kind", "=", "pr"), eb.or([
        eb("i.state", "=", "OPEN"),
        eb.and([eb("i.state", "=", "MERGED"), eb.exists(eb.selectFrom("final_reviews as l").select(eb.lit(1).as("one")).whereRef("l.repo", "=", "i.repo").whereRef("l.number", "=", "i.number").where("l.verdict", "in", ["take", "take-fix"]))]),
        eb.exists(eb.selectFrom("merges as mm").select(eb.lit(1).as("one")).whereRef("mm.repo", "=", "i.repo").whereRef("mm.number", "=", "i.number").where("mm.outcome", "=", "merged")),
        eb.exists(eb.selectFrom("implementations as im").select(eb.lit(1).as("one")).whereRef("im.repo", "=", "i.repo").whereRef("im.pr_number", "=", "i.number").where("im.state", "not in", [...ENDED_STATES])),
      ])]),
      eb.and([eb("i.kind", "=", "issue"), eb("i.state", "=", "OPEN"), eb.exists(eb.selectFrom("tracked_repos as t").select(eb.lit(1).as("one")).whereRef("t.name", "=", "i.repo"))]),
    ])) as SelectQueryBuilder<any, any, KeyRow>;
});

registerKeySource<{ due: Ref[]; seen: number }>(PASS_SOURCES.changed, (db, args) => {
  const k = queryDb(db).k;
  const refs = args.due.map((r): [string, number] => [r.repo, r.number]);
  const logged = k.selectFrom("item_changes as c").select(["c.repo as repo", "c.number as number"])
    .where((eb) => eb(eb.selectFrom("item_changes").select((x) => x.fn.countAll<number>().as("n")), "<=", CHANGES_CAP + args.seen));
  const due = k.selectFrom(kx.refPairs(db, refs, "d")).select(["d.repo as repo", "d.number as number"]);
  return logged.union(due) as SelectQueryBuilder<any, any, KeyRow>;
});

/** The subquery of `keys` named `alias`, for `(repo, number) IN (select repo, number from <alias>)`. */
export const keysOf = <A extends string>(db: Db, keys: KeySource, alias: A) => resolveKeys(db, keys, alias);
export { DUE_MAX };

/** The plan is a PR in a queue state with a queue view. */
export function queuedPlan(db: Db, eb: Eb, alias: string): Expression<SqlBool> {
  return eb.and([eb(`${alias}.kind`, "=", "pr"), eb(`${alias}.state`, "in", [...QUEUE_STATES]), eb(kx.jsonType(db, `${alias}.view`, "$.queue"), "=", "object")]);
}
/** `view.gh` of the plan row aliased `p`. */
export const planGh = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.gh");
/** `view.scope` of the plan row aliased `p`. */
export const planScope = (db: Db, p: string) => kx.jsonBool(db, `${p}.view`, "$.scope");
/** `view.fixup` of the plan row aliased `p`. */
export const planFixup = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.fixup");
/** `view.waitKind` of the plan row aliased `p`. */
export const planWaitKind = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.waitKind");

/** The item has a stored plan. */
export function plannedItem(eb: Eb, alias: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("item_plans as ip").select(w.lit(1).as("one")).where("ip.repo", "=", eb.ref(`${alias}.repo`)).where("ip.number", "=", eb.ref(`${alias}.number`)));
}
/** `item_stage` rows, optionally of one repo, for the Progress funnel. */
export function latestStage(db: Db, repo?: string) {
  return queryDb(db).k.selectFrom("item_stage").selectAll().$if(!!repo, (q) => q.where("repo", "=", repo!));
}
/** The item has a `liveness_items` row with verdict `stuck`. */
export function stuckItem(eb: Eb, alias: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("liveness_items as li").select(w.lit(1).as("one")).where("li.repo", "=", eb.ref(`${alias}.repo`)).where("li.number", "=", eb.ref(`${alias}.number`)).where("li.verdict", "=", "stuck"));
}
/** A `stages` row of that stage exists for the item. */
export function hasStage(eb: Eb, alias: string, stage: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("main.stages as sg").select(w.lit(1).as("one")).where("sg.repo", "=", eb.ref(`${alias}.repo`)).where("sg.number", "=", eb.ref(`${alias}.number`)).where("sg.stage", "=", stage));
}
/** `(repo, number)` of the blocked PRs recorded for the PRs in `keys` (review's blocker loader). */
export function blockerRefsOf(db: Db, keys: KeySource): SelectQueryBuilder<any, any, KeyRow> {
  return queryDb(db).k.selectFrom("review_blockers as rb")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "rb.repo").onRef("kk.number", "=", "rb.number"))
    .select(["rb.b_repo as repo", "rb.b_number as number"]) as SelectQueryBuilder<any, any, KeyRow>;
}

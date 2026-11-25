// Predicates other modules embed, and the resolver of the `merge.keysBatchMembers` key source.
import type { Expression, SqlBool } from "kysely";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { registerKeySource, resolveKeys, type KeySource } from "../keys.ts";

const ACTIVE = ["checking", "open"];

/** The pipeline merged the item (an attempt with outcome `merged`). */
export function mergedByUs(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merges as mg").select(w.lit(1).as("one")).where("mg.repo", "=", eb.ref(repoCol)).where("mg.number", "=", eb.ref(numberCol)).where("mg.outcome", "=", "merged"));
}

/** The pipeline merged the item on a person's approval, not by the merge rule. */
export function mergedOnApproval(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merges as mg").select(w.lit(1).as("one")).where("mg.repo", "=", eb.ref(repoCol)).where("mg.number", "=", eb.ref(numberCol)).where("mg.outcome", "=", "merged").where("mg.path", "<>", "rule"));
}

/** When the pipeline first merged the item. */
export function mergedAt(eb: Eb, repoCol: string, numberCol: string): Expression<string | null> {
  const w = schemaEb(eb);
  return w.selectFrom("merges as mg").select((x) => x.fn.min("mg.at").as("at")).where("mg.repo", "=", eb.ref(repoCol)).where("mg.number", "=", eb.ref(numberCol)).where("mg.outcome", "=", "merged") as unknown as Expression<string | null>;
}

/** The item is a member of a batch that merged. */
export function inMergedBatch(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id").select(w.lit(1).as("one"))
    .where("b.repo", "=", eb.ref(repoCol)).where("bp.number", "=", eb.ref(numberCol)).where("b.state", "=", "merged"));
}

/** The item is not the integration PR of any batch, past or present. */
export function notBatchPr(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.not(w.exists(w.selectFrom("merge_batches as b").select(w.lit(1).as("one")).where("b.repo", "=", eb.ref(repoCol)).where("b.pr_number", "=", eb.ref(numberCol))));
}

/** The item is not one of the integration PRs we opened. */
export function notOwnIntegration(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  return notBatchPr(eb, repoCol, numberCol);
}

/** The item is a member of a checking or open batch. */
export function inActiveBatch(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id").select(w.lit(1).as("one"))
    .where("b.repo", "=", eb.ref(repoCol)).where("bp.number", "=", eb.ref(numberCol)).where("b.state", "in", ACTIVE));
}

/** The item has a verification or a PR build row. */
export function hasVerifyOrBuild(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.or(["verifications", "pr_builds"].map((t) =>
    w.exists(w.selectFrom(`${t} as x` as "verifications as x").select(w.lit(1).as("one")).where("x.repo", "=", eb.ref(repoCol)).where("x.number", "=", eb.ref(numberCol)))));
}

// Members of the batches whose integration PR is in `args.keys`.
registerKeySource<{ keys: KeySource }>("merge.keysBatchMembers", (db, args) =>
  queryDb(db).k.selectFrom("merge_batches as b")
    .innerJoin(resolveKeys(db, args.keys, "kk"), (j) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "b.pr_number"))
    .innerJoin("merge_batch_prs as bp", "bp.batch_id", "b.id")
    .select(["b.repo as repo", "bp.number as number"]));

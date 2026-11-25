// Predicates other modules embed.
import type { Expression, SqlBool } from "kysely";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Db } from "../../db/index.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { HiddenRepos, RunVisibility } from "./types.ts";

/** `agent_runs` row (alias `alias`) visible under `vis`: no filter when nothing is hidden; else it has an item row and none in a hidden repo. */
export function runVisible(vis: { hidden: HiddenRepos }, eb: Eb, alias = "r"): Expression<SqlBool> {
  if (vis.hidden.length === 0) return eb.val(true) as unknown as Expression<SqlBool>;
  const w = schemaEb(eb);
  const items = (q: ReturnType<typeof w.selectFrom<"agent_run_items as ri">>) => q.select(w.lit(1).as("one")).where("ri.run_id", "=", eb.ref(`${alias}.id`));
  return eb.and([
    w.exists(items(w.selectFrom("agent_run_items as ri"))),
    eb.not(w.exists(items(w.selectFrom("agent_run_items as ri")).where("ri.repo", "in", [...vis.hidden]))),
  ]);
}
export type { RunVisibility };

/** `run_id`s of runs that touched the items of `keys`, as a subquery. */
export function runItems(db: Db, keys: KeySource) {
  return queryDb(db).k.selectFrom("agent_run_items as ri")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "ri.repo").onRef("kk.number", "=", "ri.number"))
    .select("ri.run_id as run_id");
}

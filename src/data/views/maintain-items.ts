// reads: mirror.items, planner.item_plans, triage.item_rank, workflow.item_workflows, workflow.workflow_events, intake.outside_holds,
//        planner.liveness_items, triage.item_areas, triage.item_settled, triage.dupe_group_items, security.security_findings, merge.merges,
//        merge.merge_batches, merge.merge_batch_prs
// The Items page: one statement for the filtered rows with their workflow and plan signals, and the facts of the rows a page shows.
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { parseSearch } from "../../db/search.ts";
import { queryDb } from "../../db/query-db.ts";
import * as access from "../access/index.ts";
import { heldExpr } from "../intake/fragments.ts";
import * as intake from "../intake/index.ts";
import { stuckItem } from "../planner/fragments.ts";
import * as planner from "../planner/index.ts";
import { inMergedBatch, mergedAt, mergedByUs, mergedOnApproval } from "../merge/fragments.ts";
import { quietPrExpr } from "../security/fragments.ts";
import { hasNoArea, inAreas, isDuplicateClose, rankJoin, settledJoin } from "../triage/fragments.ts";
import * as triage from "../triage/index.ts";
import { LIVE_STATES, notArchived } from "../workflow/fragments.ts";
import * as workflow from "../workflow/index.ts";
import type { ItemBase, ItemRowFacts, ItemsFilter, Scope } from "./types.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { textHit } from "./items.ts";

/** The SQL of an item's phase: its plan's stored phase, else Merged, Closed or Triage from the item. Needs `i` (items) and `p` (item_plans, left joined). */
export const phaseOf = (db: Db, eb: kx.Eb) => eb.fn.coalesce(
  kx.jsonText(db, "p.view", "$.status.phase"),
  eb.case().when("i.merged_at", "is not", null).then("Merged").when("i.closed_at", "is not", null).then("Closed").else("Triage").end(),
);

const NO_AREA = "none";
const as = (e: Expression<SqlBool>, name: string) => (e as AliasableExpression<SqlBool>).as(name);
/** When GitHub merged the item, or our merge step did while the mirror has not read it. */
const mergeTime = (eb: kx.Eb) => eb.fn.coalesce("i.merged_at", mergedAt(eb, "i.repo", "i.number"));

/**
 * The open items (or one page of closed ones, or of the pull requests AutoCraft merged, newest merge first) of `scope.repos` that pass the filter, with plan, rank and live workflow columns and the kind of
 * the item's latest workflow event. `closedTotal` counts the closed or merged items the filter matches, whatever `limit` cuts.
 */
export async function loadItemsBase(db: Db, scope: Pick<Scope, "repos" | "hidden">, f: ItemsFilter): Promise<{ rows: ItemBase[]; closedTotal: number | null }> {
  if (!scope.repos.length) return { rows: [], closedTotal: null };
  // The settled table of the classification run is built (a write) before the read.
  const run = f.filters.includes("security") ? await triage.currentRunReady(db) : null;
  const q = queryDb(db);
  const fts = f.text ? parseSearch(f.text) : null;
  const merged = f.show === "merged", closed = f.show === "closed" || merged;
  const conds = (eb: kx.AnyEb): Expression<SqlBool>[] => {
    const c: Expression<SqlBool>[] = [kx.inList(db, "i.repo", scope.repos), merged ? eb.and([eb("i.kind", "=", "pr"), eb.or([mergedByUs(eb, "i.repo", "i.number"), inMergedBatch(eb, "i.repo", "i.number")])]) : closed ? eb("i.state", "<>", "OPEN") : eb("i.state", "=", "OPEN")];
    if (f.refs.length) c.push(kx.refIn(db, "i", f.refs.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))] as const)));
    if (fts) c.push(textHit(eb, db, fts));
    for (const x of f.filters) {
      if (x === "outside") c.push(heldExpr(eb, "i.repo", "i.number"));
      if (x === "stuck") c.push(stuckItem(eb, "i"));
      if (x === "duplicates") c.push(isDuplicateClose(eb, "i.repo", "i.number"));
      if (x === "security") c.push(eb.and([
        eb.exists(kx.schemaEb(eb).selectFrom("main.item_settled as s").select(eb.lit(1).as("one")).where((w) => settledJoin(w, run, "s")).where("s.security", "=", 1)),
        eb.not(quietPrExpr(eb, "i.repo", "i.number")),
      ]));
    }
    if (f.areas.length) {
      const named = f.areas.filter((a) => a !== NO_AREA);
      c.push(eb.or([...(named.length ? [inAreas(eb, "i.repo", "i.number", named)] : []), ...(f.areas.includes(NO_AREA) ? [hasNoArea(eb, "i.repo", "i.number")] : [])]));
    }
    c.push(hiddenRepos(db, "i.repo", scope.hidden));
    return c;
  };
  const base = () => rankJoin(q.k.selectFrom("main.items as i")
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number")))
    .leftJoin("main.item_workflows as w", (j: any) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number").on("w.state", "in", LIVE_STATES)
      .on("w.id", "=", (eb: kx.AnyEb) => eb.selectFrom("main.item_workflows as lw").select((e) => e.fn.max<number>("lw.id").as("m"))
        .whereRef("lw.repo", "=", "i.repo").whereRef("lw.number", "=", "i.number").where("lw.state", "in", LIVE_STATES)))
    .leftJoin("main.workflow_events as ev", (j: any) => j.onRef("ev.repo", "=", "i.repo").onRef("ev.number", "=", "i.number").on((eb: kx.AnyEb) => notArchived(eb, "ev.kind"))
      .on("ev.id", "=", (eb: kx.AnyEb) => eb.selectFrom("main.workflow_events as le").select((e) => e.fn.max<number>("le.id").as("m"))
        .whereRef("le.repo", "=", "i.repo").whereRef("le.number", "=", "i.number").where((w) => notArchived(w, "le.kind"))));
  const cols = (b: ReturnType<typeof base>) => b.select((eb: kx.Eb) => [
    "i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.updated_at", "i.merged_at", "i.closed_at", eb.ref("r.score").as("score"),
    "p.state as plan_state", "p.item_state as plan_item_state", phaseOf(db, eb).as("phase"),
    ...(merged ? [mergeTime(eb).as("merge_time"), as(mergedByUs(eb, "i.repo", "i.number"), "own_merge"), as(mergedOnApproval(eb, "i.repo", "i.number"), "approved")] : []),
    "w.weight as weight", "w.state as wf_state", "w.rec as wf_rec", "w.started_by", "w.approved_by", "w.stopped_by", "ev.kind as last_event",
  ]);
  const where = <B extends { where: (...a: any[]) => any }>(b: B): B => b.where((eb: kx.AnyEb) => eb.and(conds(eb))) as B;
  const [rows, total] = await db.together(() => Promise.all([
    closed
      ? q.all(where(cols(base())).orderBy((eb: kx.Eb) => eb.fn.coalesce(merged ? mergeTime(eb) : "i.updated_at", eb.val("")), "desc").orderBy("i.repo").orderBy("i.number", "desc").limit(f.limit))
      : q.all(where(cols(base()))),
    closed ? q.get(where(base().select((eb: kx.Eb) => eb.fn.countAll<number>().as("n")))) : Promise.resolve(null),
  ]));
  return {
    rows: (rows as Record<string, any>[]).map((r): ItemBase => ({
      repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author, state: r.state, updatedAt: r.updated_at ?? "",
      mergedAt: r.merged_at, closedAt: r.closed_at, planState: r.plan_state, itemState: r.plan_item_state, phase: r.phase, score: r.score === null ? null : Number(r.score),
      weight: r.weight === null ? null : Number(r.weight), workflowState: r.wf_state, hasRecommendation: r.wf_rec !== null, startedBy: r.started_by, approvedBy: r.approved_by,
      stoppedBy: r.stopped_by, lastEvent: r.last_event,
      ...(merged && { merged: { at: r.merge_time ?? "", how: !Number(r.own_merge) ? "batch" as const : Number(r.approved) ? "approval" as const : "rule" as const } }),
    })),
    closedTotal: total ? Number((total as { n: number }).n) : null,
  };
}

/** Plan views, holds, stuck marks, duplicate closes, areas and live workflows of the page's refs, in one wave. */
export async function loadItemRowFacts(db: Db, scope: Pick<Scope, "staff" | "login">, refs: { repo: string; number: number }[]): Promise<ItemRowFacts> {
  if (!refs.length) return { plans: new Map(), holds: new Map(), stuck: new Set(), duplicateGroups: new Map(), areas: new Map(), workflows: new Map(), permissions: new Map() };
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  const repos = [...new Set(refs.map((r) => r.repo))];
  const [plans, holds, stuck, dupes, areas, live, perms] = await db.together(() => Promise.all([
    planner.loadPlans(db, refs),
    intake.loadHoldStatus(db, refs),
    scope.staff ? planner.loadStuck(db, keys) : Promise.resolve(new Set<string>()),
    triage.loadDupeSignals(db, refs),
    triage.loadItemAreas(db, refs),
    workflow.listWorkflows(db, { live: true, refs }),
    scope.login ? access.loadPermissionsForRepos(db, scope.login, repos) : Promise.resolve(new Map()),
  ]));
  const wfs = new Map(live.map((w) => [`${w.repo}#${w.number}`, w]));
  const permissions = new Map([...perms].map(([repo, e]) => [repo, (e.permission === "admin" ? "admin" : e.permission === "read" || e.permission === "triage" ? "read" : "write") as "read" | "write" | "admin"]));
  return { plans, holds, stuck, duplicateGroups: dupes, areas, workflows: wfs, permissions };
}

// reads: mirror.items, mirror.pr_checks, mirror.main_ci, workflow.item_workflows, jobs.job_items
// resolvePushes closes or expires outcomes of items that are closed or moved head; addPushOutcomes reads the stored checks of the PR and the
// main CI state before a push; pushesUnsettled reads open items with their stored checks; loadActBlocked embeds the workflow fragment `startedRepo`;
// loadActUsage adds Act job items.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

/** Stored checks (JSON text) of the PRs `refs`, with the head they are for, keyed `repo#number`. */
export async function loadStoredChecks(db: Db, refs: readonly (readonly [string, number])[]): Promise<Map<string, { head: string; checks: string | null }>> {
  const out = new Map<string, { head: string; checks: string | null }>();
  if (!refs.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.pr_checks as c").innerJoin(kx.refPairs(db, refs, "rp"), (j) => j.onRef("rp.repo", "=", "c.repo").onRef("rp.number", "=", "c.number"))
    .select(["c.repo as repo", "c.number as number", "c.head_oid as head", "c.checks as checks"]));
  for (const r of rows) out.set(`${r.repo}#${r.number}`, { head: r.head, checks: r.checks });
  return out;
}

/** Main CI states of the default branch: by commit (`(repo, sha)` pairs), keyed `repo@sha`, and the newest per repo, keyed `repo`. */
export async function loadMainCiStates(db: Db, o: { at: readonly (readonly [string, string])[]; latestOf: readonly string[] }): Promise<{ at: Map<string, string>; latest: Map<string, string> }> {
  const q = queryDb(db);
  // The two reads go out in the same turn, so a caller's `together` fuses them with its other loads.
  const [byAt, latest] = await Promise.all([
    o.at.length ? q.all(q.k.selectFrom("main.main_ci").select(["repo", "head_sha", "state"]).where(kx.tupleIn(db, ["repo", "head_sha"], o.at.map(([r, s]) => [r, s]), ["text", "text"]))) : Promise.resolve([]),
    o.latestOf.length ? q.all(q.k.selectFrom((sub) => sub.selectFrom("main.main_ci").select((eb) => ["repo", "state",
      eb.fn.agg<number>("row_number").over((ob) => ob.partitionBy("repo").orderBy("committed_at", (o2) => o2.desc().nullsLast()).orderBy("first_seen_at", "desc")).as("rn")])
      .where(kx.inList(db, "repo", [...o.latestOf])).as("m")).select(["m.repo", "m.state"]).where("m.rn", "=", 1)) : Promise.resolve([]),
  ]);
  return { at: new Map(byAt.map((r) => [`${r.repo}@${r.head_sha}`, r.state])), latest: new Map(latest.map((r) => [r.repo, r.state])) };
}

/** Open-PR pushes (outcome not set, at or after `since`) whose head is still the pushed commit, with the stored checks of that head. */
export async function loadOpenHeadPushes(db: Db, repos: readonly string[], since: string): Promise<{ repo: string; oid: string; checks: string | null }[]> {
  if (!repos.length) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.push_outcomes as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number").on("i.state", "=", "OPEN").onRef("i.head_oid", "=", "p.to_oid"))
    .leftJoin("main.pr_checks as c", (j) => j.onRef("c.repo", "=", "p.repo").onRef("c.number", "=", "p.number").onRef("c.head_oid", "=", "p.to_oid"))
    .select(["p.repo as repo", "p.to_oid as oid", "c.checks as checks"])
    .where(kx.inList(db, "p.repo", [...repos])).where("p.outcome", "is", null).where("p.number", "is not", null).where("p.at", ">=", since));
}

/** Sets outcome `unknown` on unsettled pushes whose PR is closed or merged, or whose head moved past the pushed commit; returns the rows changed. */
export async function closeMovedPushOutcomes(db: Db, at: string): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.updateTable("main.push_outcomes").set({ outcome: "unknown", resolved_at: at }).where("outcome", "is", null).where("number", "is not", null)
    .where((eb) => eb.exists(eb.selectFrom("main.items as i").select(eb.lit(1).as("one"))
      .whereRef("i.repo", "=", "main.push_outcomes.repo").whereRef("i.number", "=", "main.push_outcomes.number")
      .where((ie) => ie.or([ie("i.state", "<>", "OPEN"), ie.and([
        ie("i.head_oid", "is not", null),
        ie("i.head_oid", "<>", ie.ref("main.push_outcomes.to_oid")),
        ie("i.head_oid", "is distinct from", ie.ref("main.push_outcomes.from_oid")),
      ])])))))).changes;
}

// reads: mirror.items, mirror.repos, control.tracked_repos, planner.item_stage, planner.item_plans, workflow.item_workflows, triage.classifications, security.security_findings, security.security_quiet_prs, review.review_posts, merge.merges, merge.merge_batch_prs, merge.merge_batches
// The read models of src/public/status.ts: what the anonymous views (Discord, the PR status comment) learn about items and counts. Every
// statement filters the security cases the public must not see in SQL unless the caller asks for them (`withHidden`).
import type { Eb } from "../../db/kx.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Db } from "../../db/index.ts";
import { quietPrExpr, findingPrExpr } from "../security/fragments.ts";
import { hasSecurityVerdict } from "../triage/fragments.ts";
import { needsPerson } from "../workflow/fragments.ts";
import { mergedByUs, inMergedBatch } from "../merge/fragments.ts";
import { loadRankScores } from "../triage/index.ts";
import { loadQueuePositions } from "../workflow/index.ts";
import type { PublicStatsFacts, PublicStatusRow, QueueMember } from "./types.ts";

/** Plan states of an open PR that is in line to merge. */
export const PUBLIC_QUEUED = ["in-batch", "batch-checking", "ready", "decision-answered-merge"];
const BATCHED = ["in-batch", "batch-checking"];

/** Names of the tracked repos that are public, sorted. */
export async function loadPublicRepoNames(db: Db): Promise<string[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.tracked_repos as t").innerJoin("main.repos as r", "r.name", "t.name").select("t.name")
    .where((eb) => eb(eb.fn("lower", ["r.visibility"]), "=", "public")).orderBy("t.name"))).map((r) => r.name);
}

/** The security cases an anonymous viewer must not see: a quiet fix PR, any finding's fix PR, an item the classifier flagged or a label marks as security. */
function hidden(db: Db, eb: Eb, repo: string, number: string, labels: string) {
  const array = eb.case().when(kx.jsonValid(db, labels)).then(eb.ref(labels)).else(eb.val("[]")).end();
  const t = kx.schemaEb(eb);
  return eb.or([
    quietPrExpr(eb, repo, number),
    findingPrExpr(eb, repo, number),
    hasSecurityVerdict(db, eb, repo, number),
    eb.exists(t.selectFrom(kx.jsonEach(db, array, "l")).select(eb.lit(1).as("one")).where((e) => kx.like(db, e.fn("lower", ["l.value"]), e.val("%security%")))),
  ]);
}

/** The queue's rows of one repo (or of several): open PRs in a queue plan state, not merge-held and not waiting on a person. */
function queuedPrs(db: Db, repos: string[], withHidden: boolean) {
  const q = queryDb(db);
  return q.k.selectFrom("main.item_plans as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .where(kx.inList(db, "p.repo", repos)).where("p.kind", "=", "pr").where(kx.inList(db, "p.state", PUBLIC_QUEUED))
    .where((eb) => eb(kx.jsonText(db, "p.view", "$.gh"), "=", "OPEN"))
    .where((eb) => eb(eb.fn.coalesce(kx.jsonBool(db, "p.view", "$.queue.held"), eb.lit(0)), "=", 0))
    .where((eb) => eb.not(needsPerson(eb, "p.repo", "p.number")))
    .$if(!withHidden, (b) => b.where((eb) => eb.not(hidden(db, eb, "p.repo", "p.number", "i.labels"))));
}

/**
 * The stored facts the step mapping reads for `numbers` of `repo`, and the repo's queue members (for place and length). The queue
 * is read only when `queue` is true. `withHidden`: the queue counts the security cases too (the PR status comment does).
 */
export async function loadPublicStatusRows(db: Db, repo: string, numbers: number[], o: { withHidden: boolean; queue?: boolean }): Promise<{ rows: PublicStatusRow[]; queue: QueueMember[] }> {
  const q = queryDb(db);
  const wantQueue = o.queue ?? true;
  if (!numbers.length && !wantQueue) return { rows: [], queue: [] };
  const [rows, members, scores, positions] = await db.together(() => Promise.all([
    numbers.length ? q.all(q.k.selectFrom("main.items as i")
      .leftJoin("main.item_stage as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
      .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
      .select((eb) => ["i.repo", "i.number", "i.kind", "i.title", "i.url", "i.state", "s.stage", "s.reviewed", "p.state as plan", "p.view",
        hidden(db, eb, "i.repo", "i.number", "i.labels").as("hidden"), needsPerson(eb, "i.repo", "i.number").as("needs")])
      .where("i.repo", "=", repo).where(kx.inList(db, "i.number", numbers, "bigint"))) : Promise.resolve([]),
    wantQueue ? q.all(queuedPrs(db, [repo], o.withHidden).select(["p.repo", "p.number", "p.state"])) : Promise.resolve([]),
    wantQueue ? loadRankScores(db, { repos: [repo] }) : Promise.resolve(new Map<string, number>()),
    wantQueue ? loadQueuePositions(db, { repos: [repo] }) : Promise.resolve(new Map<string, { weight: number }>()),
  ]));
  return {
    rows: rows.map((r) => ({
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", url: r.url, state: r.state, stage: r.stage, reviewed: !!r.reviewed,
      planState: r.plan, view: r.view, needsPerson: !!r.needs, hidden: !!r.hidden,
    })),
    queue: members.map((m) => ({
      repo: m.repo, number: m.number, held: false, batched: BATCHED.includes(m.state), weight: positions.get(`${m.repo}#${m.number}`)?.weight ?? null, score: scores.get(`${m.repo}#${m.number}`) ?? null,
    })),
  };
}

/** Counts of the public repos `repos`: open items by kind, PRs merged since `since30`, reviews posted since `since7` and queue lengths, security cases left out. */
export async function loadPublicStats(db: Db, repos: string[], o: { since7: string; since30: string }): Promise<PublicStatsFacts> {
  if (!repos.length) return { open: [], merged: [], reviews: [], queues: [] };
  const q = queryDb(db);
  const [open, merged, reviews, queues] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.items as i").select((eb) => ["i.repo", "i.kind", eb.fn.countAll<number>().as("n")])
      .where(kx.inList(db, "i.repo", repos)).where("i.state", "=", "OPEN").where("i.kind", "in", ["issue", "pr"])
      .where((eb) => eb.not(hidden(db, eb, "i.repo", "i.number", "i.labels"))).groupBy(["i.repo", "i.kind"])),
    q.all(q.k.selectFrom("main.items as i")
      .select((eb) => ["i.repo", "i.number", "i.created_at", "i.merged_at", eb.or([mergedByUs(eb, "i.repo", "i.number"), inMergedBatch(eb, "i.repo", "i.number")]).as("ours")])
      .where(kx.inList(db, "i.repo", repos)).where("i.state", "=", "MERGED").where("i.kind", "=", "pr").where("i.merged_at", ">=", o.since30)
      .where((eb) => eb.not(hidden(db, eb, "i.repo", "i.number", "i.labels")))
      .$narrowType<{ merged_at: string }>()),
    q.all(q.k.selectFrom("main.review_posts as rp")
      .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "rp.repo").onRef("i.number", "=", "rp.number"))
      .select((eb) => ["rp.repo", eb.fn.countAll<number>().as("n")])
      .where(kx.inList(db, "rp.repo", repos)).where("rp.posted_at", ">=", o.since7)
      .where((eb) => eb.not(hidden(db, eb, "i.repo", "i.number", "i.labels"))).groupBy("rp.repo")),
    q.all(queuedPrs(db, repos, false).select((eb) => ["p.repo", eb.fn.countAll<number>().as("n")]).groupBy("p.repo")),
  ]));
  return {
    open: open.map((r) => ({ repo: r.repo, kind: r.kind === "pr" ? "pr" : "issue", n: Number(r.n) })),
    merged: merged.map((r) => ({ repo: r.repo, number: r.number, ours: !!r.ours, mergedAt: r.merged_at, openedAt: r.created_at })),
    reviews: reviews.map((r) => ({ repo: r.repo, n: Number(r.n) })),
    queues: queues.map((r) => ({ repo: r.repo, n: Number(r.n) })),
  };
}

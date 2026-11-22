// Tables and pure rules of the merge queue's integration batches (see batch.ts).
import { filtered, hiddenTestExpr, type HiddenRepos } from "../hidden-sql.ts";
import { mergeApprovalOf as mergeApprovalOfSafe } from "./approval.ts";
import { TERMINAL, cancelTask, getTask } from "../build/tasks.ts";
import { setting } from "../settings-read.ts";
import { filterSeq, forEachSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import type { DB } from "../db/types.ts";
import type { SelectQueryBuilder } from "kysely";
import { cols, excluded, inList, like, rowid } from "../db/kx.ts";

export const BATCH_STATES = ["checking", "open", "merged", "failed", "split", "superseded"] as const;
export type BatchState = (typeof BATCH_STATES)[number];
/** States of a batch that is still being worked on. */
export const ACTIVE_BATCH: BatchState[] = ["checking", "open"];

/** Summary of a batch whose PR a person closed: its PRs stay out of batches until they change. */
/** Summary of a batch that failed because a maintainer requested changes on its PR: its members are held like those of a batch a person closed. */
export const BLOCKED_BY_REVIEW = "a maintainer requested changes on the batch PR";
export const CLOSED_BY_PERSON = "the batch PR was closed by a person";
/** Summary of a batch that failed because its branch could not be pushed or its PR opened 5 times: its PRs go back to the queue, not on hold. */
export const PUBLISH_FAILED = "could not open the batch PR";
export const MAX_PUBLISH_FAILURES = 5;
/** Wait before a batch whose push or PR creation failed is tried again: 1, 2, 4, 8 minutes, at most 30. */
export const publishDelayMs = (failures: number): number => (failures === 0 ? 0 : Math.min(60_000 * 2 ** (failures - 1), 30 * 60_000));
/** Wait before a batch's build task is queued again after a build-environment error: none for the first retry, then doubling from 5 minutes up to 30 minutes. */
export const retryDelayMs = (retries: number): number => (retries <= 0 ? 0 : Math.min(5 * 60_000 * 2 ** (retries - 1), 30 * 60_000));
/** Builds a batch's task may take, counting every try, before the batch PR opens without the build. */
export const MAX_BUILD_TRIES = 3;
/** How long a batch waits for its build task before the PR opens anyway. */
export const BUILD_MAX_MS = 3 * 3600_000;
/** Shown on a batch PR whose workflow runs wait for a maintainer's approval. */
export const RUNS_WAIT_NOTE = "batch PR runs wait for a maintainer's approval";

export const MAX_BATCH = 50;
/** A repo's batch size until its batches pass or fail. */
export const START_BATCH = 20;
/** Changed lines (additions plus deletions) a batch may carry, beyond its first PR. */
export const MAX_BATCH_LINES = 10_000;

export type BatchRow = {
  id: number; repo: string; branch: string; state: BatchState; base_sha: string; commit_sha: string; parent_id: number | null;
  task_id: number | null; retries: number; pr_number: number | null; pr_url: string | null; summary: string | null; created_at: string; updated_at: string;
  /** `<owner>/<repo>` the branch was pushed to; null before the push and on rows from before it was stored. */
  fork: string | null;
  /** The batch-build feature's state: null (never queued), pending, passed, failed or skipped. */
  build_state?: "pending" | "passed" | "failed" | "skipped" | null;
  /** Build tasks queued for the batch (the first, flake reruns and environment retries). */
  build_tries?: number;
  /** Merge commit of the batch PR; null until merged and on rows from before it was stored. */
  merge_sha?: string | null;
  /** The batch PR's failed runs were rerun once (no PR was traced); when that was asked for. */
  ci_reruns?: number;
  ci_rerun_at?: string | null;
};
/** Columns of `merge_batches` the table types as text that hold one of a few values. */
type BatchColumns = { state: BatchState; build_state: NonNullable<BatchRow["build_state"]> | null };
export type BatchMember = { number: number; head_oid: string };

const sizeKey = (repo: string) => `batch_size:${repo}`;

/** Most PRs the repo's next batch takes: grows by one after a passing batch, halves after a failed one. */
export async function batchSizeOf(db: Db, repo: string): Promise<number> {
  const v = await setting(db, sizeKey(repo));
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_BATCH ? n : START_BATCH;
}
export async function setBatchSize(db: Db, repo: string, n: number): Promise<number> {
  const size = Math.max(1, Math.min(MAX_BATCH, n));
  await db.run(db.k.insertInto("main.settings").values({ key: sizeKey(repo), value: String(size) })
    .onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  return size;
}
export const growBatchSize = async (db: Db, repo: string): Promise<number> => await setBatchSize(db, repo, await batchSizeOf(db, repo) + 1);
export const shrinkBatchSize = async (db: Db, repo: string): Promise<number> => await setBatchSize(db, repo, Math.floor(await batchSizeOf(db, repo) / 2));

export async function membersOf(db: Db, batchId: number): Promise<BatchMember[]> {
  return await db.all(db.k.selectFrom("main.merge_batch_prs").select(["number", "head_oid"]).where("batch_id", "=", batchId).orderBy("position"));
}

export async function activeBatches(db: Db, repo: string): Promise<BatchRow[]> {
  return await db.all(db.k.selectFrom("main.merge_batches").select(cols("main.merge_batches")).where("repo", "=", repo).where("state", "in", ["checking", "open"]).orderBy("id")
    .$narrowType<BatchColumns>());
}

export async function getBatch(db: Db, id: number): Promise<BatchRow> {
  return (await db.get(db.k.selectFrom("main.merge_batches").select(cols("main.merge_batches")).where("id", "=", id)
    .$narrowType<BatchColumns>()))!;
}

export async function updateBatch(db: Db, id: number, at: string, set: Partial<Pick<BatchRow, "state" | "task_id" | "retries" | "pr_number" | "pr_url" | "summary" | "fork" | "merge_sha" | "build_state" | "build_tries" | "ci_reruns" | "ci_rerun_at">>): Promise<void> {
  await db.run(db.k.updateTable("main.merge_batches").set({ ...set, updated_at: at }).where("id", "=", id));
}

/** Cancels the build task of a batch that is ending before its build was read. */
export async function cancelBuild(db: Db, b: BatchRow, by: string): Promise<void> {
  if (b.build_state !== "pending" || b.task_id === null) return;
  const t = await getTask(db, b.task_id);
  if (t && !TERMINAL.includes(t.state)) await cancelTask(db, t.id, by);
}

/** `integration-<repo>-<yyyymmdd>-<n>`, n counting the repo's batches of that day. */
export async function nextBranch(db: Db, repo: string, now: Date): Promise<string> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `integration-${repo}-${day}-`;
  const n = (await db.get(db.k.selectFrom("main.merge_batches").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", repo)
    .where((eb) => like(db, "branch", eb.val(`${prefix}%`)))))!.n;
  return `${prefix}${n + 1}`;
}

export async function insertBatch(db: Db, b: { repo: string; branch: string; baseSha: string; commitSha: string; parentId: number | null; taskId?: number | null; members: BatchMember[]; at: string }): Promise<number> {
  const r = (await db.get(db.k.insertInto("main.merge_batches")
    .values({ repo: b.repo, branch: b.branch, state: "checking", base_sha: b.baseSha, commit_sha: b.commitSha, parent_id: b.parentId, task_id: b.taskId ?? null, created_at: b.at, updated_at: b.at })
    .returning("id")))!;
  const id = Number(r.id);
  await forEachSeq(b.members, async (m, i) => await db.run(db.k.insertInto("main.merge_batch_prs").values({ batch_id: id, number: m.number, head_oid: m.head_oid, position: i })));
  return id;
}

/** Whether the next candidate may join the PRs taken so far: up to `max` PRs and MAX_BATCH_LINES changed lines; an L-size PR goes alone. */
export function admits(taken: { size: string; lines: number }[], c: { size: string; lines: number }, max: number): boolean {
  if (taken.length === 0) return true;
  if (taken[0]!.size === "L" || taken.length >= max || c.size === "L") return false;
  return taken.reduce((a, t) => a + t.lines, 0) + c.lines <= MAX_BATCH_LINES;
}

/** Queue state each PR head in an active or failed batch is in: `repo#number@head` → batch-checking | in-batch | batch-failed. */
export async function batchStates(db: Db, repo?: string): Promise<Map<string, "batch-checking" | "in-batch" | "batch-failed">> {
  const rows = await db.all(db.k.selectFrom("main.merge_batch_prs as p").innerJoin("main.merge_batches as b", "b.id", "p.batch_id")
    .select((eb) => ["b.repo", "p.number", "p.head_oid", "b.state", "b.summary",
      eb.selectFrom("main.merge_batch_prs as q").select(eb.fn.countAll<number>().as("n")).whereRef("q.batch_id", "=", "b.id").as("n")])
    .where("b.state", "in", ["checking", "open", "failed"])
    .$if(!!repo, (q) => q.where("b.repo", "=", repo!))
    .orderBy("b.id"));
  const out = new Map<string, "batch-checking" | "in-batch" | "batch-failed">();
  for (const r of rows) {
    if (r.state === "failed" && r.summary?.startsWith(PUBLISH_FAILED)) continue;
    if (r.state === "failed" && r.n !== 1 && r.summary !== CLOSED_BY_PERSON && r.summary !== BLOCKED_BY_REVIEW) continue;
    out.set(`${r.repo}#${r.number}@${r.head_oid}`, r.state === "checking" ? "batch-checking" : r.state === "open" ? "in-batch" : "batch-failed");
  }
  return out;
}

/** Repos with a batch that has something to do: a batch PR to watch, or a batch still to be pushed whose retry wait is over. */
export async function batchesDue(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db.all(db.k.selectFrom("main.merge_batches").select(["repo", "state", "pr_number", "retries", "updated_at"]).where("state", "in", ["open", "checking"]));
  const due = new Set(rows.filter((b) => b.state === "open" || now.getTime() - Date.parse(b.updated_at) >= publishDelayMs(b.retries)).map((b) => b.repo));
  return await filterSeq([...due], async (r) => await mergeApprovalOfSafe(db, r));
}

/** One page of batches, newest first (ids below `before`), with their members in order: two queries, whatever the page size. */
export async function pageBatches(db: Db, o: { repo?: string; hidden?: HiddenRepos; before?: number; limit: number }): Promise<{ batches: (BatchRow & { prs: BatchMember[] })[]; total: number; more: boolean }> {
  // A list from the dashboard's `hiddenRepos` allows only its visible repos, so batches of untracked repos stay out too.
  const visible = <QB extends SelectQueryBuilder<DB, "main.merge_batches", any>>(q: QB): QB =>
    q.$if(!!o.repo, (q) => q.where("repo", "=", o.repo!))
      .$if(!!(o.hidden && filtered(o.hidden)), (q) => q.where((eb) => eb.not(hiddenTestExpr(db, "repo", o.hidden!)))) as QB;
  const total = (await db.get(visible(db.k.selectFrom("main.merge_batches")).select((eb) => eb.fn.countAll<number>().as("n"))))!.n;
  const rows = await db.all(visible(db.k.selectFrom("main.merge_batches")).select(cols("main.merge_batches"))
    .$if(o.before !== undefined, (q) => q.where("id", "<", o.before!))
    .orderBy("id", "desc").limit(o.limit + 1)
    .$narrowType<BatchColumns>());
  const page = rows.slice(0, o.limit);
  const members = new Map<number, BatchMember[]>();
  if (page.length) {
    const ms = await db.all(db.k.selectFrom("main.merge_batch_prs").select(["batch_id", "number", "head_oid"])
      .where(inList(db, "batch_id", page.map((b) => b.id), "bigint")).orderBy("batch_id").orderBy("position"));
    for (const m of ms) (members.get(m.batch_id) ?? members.set(m.batch_id, []).get(m.batch_id)!).push({ number: m.number, head_oid: m.head_oid });
  }
  // Rows from before the fork was stored: the push is in the audit log.
  const unknown = page.filter((b) => !b.fork && b.state !== "checking");
  const forks = new Map<string, string>();
  if (unknown.length) {
    const as = await db.all(db.k.selectFrom("main.audit").select(["target", "details"]).where("action", "=", "batch-push")
      .where(inList(db, "target", unknown.map((b) => `${b.repo}:${b.branch}`))).orderBy("at").orderBy(rowid("main.audit")).$narrowType<{ target: string }>());
    for (const a of as) {
      try { const f = (JSON.parse(a.details ?? "{}") as { fork?: unknown }).fork; if (typeof f === "string" && f) forks.set(a.target, f); } catch { /* not JSON */ }
    }
  }
  return {
    batches: page.map((b) => ({ ...b, fork: b.fork ?? forks.get(`${b.repo}:${b.branch}`) ?? null, prs: members.get(b.id) ?? [] })),
    total, more: rows.length > o.limit,
  };
}

// The PR status comment: one comment per PR the pipeline works on, posted at the first step past triage (review, fix-up,
// CI, a decision, the merge queue) and edited in place whenever its status line changes; GitHub sends no notification for
// an edit. The line comes from the public status layer (src/public/status.ts), so it never carries hold reasons or review
// text; a security fix gets the same line as any PR. Places in the queue past QUEUE_EXACT show as one bucket, so a merge
// or a new batch edits only the PRs near the front. Writes go through src/github/write.ts as bulk writes (half the pacing
// budget), under the repo's PR status switch (src/prstatus/approval.ts) and the step's daily limit. No timer: the planner
// queues the step when a PR's line differs from the one posted; a PR whose writes keep failing waits out a backoff.
import { commentStatuses, type PublicStatus, type PublicStep } from "../public/status.ts";
import { guardRepo } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { ghComment, ghEditComment, WritePacedError, type Writer } from "../github/write.ts";
import { appSlug, githubIdentity, ownLoginTest, plainLogin } from "../github/identity.ts";
import { setting } from "../settings-read.ts";
import { leaseItem } from "../runner/leases.ts";
import { exec as realExec, type Exec } from "../fixup/git.ts";
import { Client, type Querier } from "../mirror.ts";
import { ACTIVE_BATCH } from "../merge/batch-store.ts";
import { pilotExpr } from "../pilot.ts";
import { ownerOf } from "../owners.ts";
import { envVar } from "../env.ts";
import { itemPath, shortRepo } from "../../web/src/lib/links.ts";
import { jobItem } from "../runner/job-items.ts";
import type { Db } from "../db/index.ts";

export const ACTOR = "pr-status";
/** Ends every status comment, so the comment is found again on GitHub when the stored row is missing. */
export const MARKER = "<!-- autocraft:pr-status -->";
/** Places up to this one are shown exactly; later ones as "N or more PRs ahead". */
export const QUEUE_EXACT = 10;
const HISTORY_MAX = 8;

/** The comment's words for each public step. */
const WORDS: Record<PublicStep, string> = {
  New: "Waiting for review", Triaged: "Waiting for review", "In review": "In review", "Waiting for CI": "Waiting for CI",
  "Fix-up in progress": "Fix-up in progress", "Needs a maintainer decision": "Waiting for a maintainer decision",
  "In the merge queue": "In the merge queue", Merged: "Merged", Closed: "Closed",
};
/** Steps that do not start a comment: the PR is not past triage yet, or already ended. */
const NO_FIRST_POST = new Set<PublicStep>(["New", "Triaged", "Merged", "Closed"]);

export type StatusFacts = { status: PublicStatus; /** The PR number of the PR's open merge batch, or of the batch it merged with. */ batch?: { pr: number } };

/** The status line: the step, with the place in the merge queue or the merge batch. */
export function statusLine(f: StatusFacts): string {
  const s = f.status, word = WORDS[s.step];
  if (s.step === "Merged") return f.batch ? `${word} with merge batch #${f.batch.pr}` : word;
  if (s.step !== "In the merge queue") return word;
  if (f.batch) return `${word}: checked in merge batch #${f.batch.pr}`;
  if (!s.queue) return word;
  if (s.queue.position === 1) return `${word}, next in line`;
  return s.queue.position <= QUEUE_EXACT ? `${word}, #${s.queue.position} in line` : `${word}, ${QUEUE_EXACT} or more PRs ahead`;
}

export type HistoryStep = { step: string; at: string };

/** The history with `step` added when it differs from the last one, keeping the newest HISTORY_MAX. */
export function withStep(history: HistoryStep[], step: string, at: string): HistoryStep[] {
  const out = history.at(-1)?.step === step ? history : [...history, { step, at }];
  return out.slice(-HISTORY_MAX);
}

const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The comment body (write.ts adds the note line). `base`: the dashboard's address, null when none is configured. */
export function commentBody(repo: string, number: number, line: string, history: HistoryStep[], inQueue: boolean, base: string | null): string {
  const parts = [`**Status:** ${line}`];
  if (history.length > 1) parts.push(`**History:** ${history.map((h) => `${h.step} (${when(h.at)})`).join(" → ")}`);
  if (base) {
    const links = [`[this PR](${base}${itemPath(repo, number)})`];
    if (inQueue) links.push(`[merge queue](${base}/next?repo=${encodeURIComponent(shortRepo(repo))})`);
    parts.push(`Details for maintainers: ${links.join(" · ")}`);
  }
  return `${parts.join("\n\n")}\n\n${MARKER}`;
}


type Stored = { number: number; comment_id: string | null; author: string | null; line: string | null; steps: string; failures: number };
export type Due = { number: number; facts: StatusFacts; line: string; prev: Stored | null };

const parseSteps = (s: string): HistoryStep[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is HistoryStep => !!x && typeof x.step === "string" && typeof x.at === "string") : [];
  } catch {
    return [];
  }
};

/** Failures in a row before a PR waits; the wait starts at RETRY_FIRST_MS and doubles up to RETRY_MAX_MS. */
export const RETRY_AFTER = 3;
const RETRY_FIRST_MS = 3_600_000, RETRY_MAX_MS = 24 * 3_600_000;
const retryAt = (failures: number, now: number): string | null =>
  failures < RETRY_AFTER ? null : new Date(now + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - RETRY_AFTER))).toISOString();

/**
 * The PRs of a repo whose comment is due: an open PR in the pipeline's scope past triage with no comment yet, or a PR
 * whose posted line differs from its line now. Out of scope (the repo's Pipeline off, a pilot) a posted comment still
 * gets its Merged or Closed edit. Batch PRs get none; a PR waiting out a failure backoff is left out; a member of a batch
 * whose PR has not opened yet keeps its line.
 */
export async function statusDue(db: Db, repo: string, now: number = Date.now()): Promise<Due[]> {
  const stored = await db.all(db.k.selectFrom("main.pr_status_comments").select(["number", "comment_id", "author", "line", "steps", "failures", "retry_at"])
    .where("repo", "=", repo).where("final", "=", 0));
  const byNumber = new Map(stored.map((r) => [r.number, r]));
  const inScope = new Set((await db.all(db.k.selectFrom("main.items as i").select("i.number")
    .where("i.repo", "=", repo).where("i.kind", "=", "pr").where("i.state", "=", "OPEN")
    .where((eb) => eb.or([
      eb.exists(eb.selectFrom("main.item_stage as s").select(eb.lit(1).as("one")).whereRef("s.repo", "=", "i.repo").whereRef("s.number", "=", "i.number")),
      eb.exists(eb.selectFrom("main.decisions as d").select(eb.lit(1).as("one")).whereRef("d.repo", "=", "i.repo").whereRef("d.number", "=", "i.number").where("d.answer", "is", null)),
    ]))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.merge_batches as b").select(eb.lit(1).as("one")).whereRef("b.repo", "=", "i.repo").whereRef("b.pr_number", "=", "i.number"))))
    .where((eb) => pilotExpr(db, eb, "i")))).map((r) => r.number));
  const numbers = [...new Set([...inScope, ...stored.map((r) => r.number)])]
    .filter((n) => { const at = byNumber.get(n)?.retry_at; return !at || Date.parse(at) <= now; });
  if (!numbers.length) return [];
  const statuses = await commentStatuses(db, repo, numbers);
  const batches = await batchesOf(db, repo, numbers);
  const out: Due[] = [];
  for (const n of numbers.sort((a, b) => a - b)) {
    const status = statuses.get(n), prev = byNumber.get(n) ?? null;
    if (!status) continue;
    const ended = status.step === "Merged" || status.step === "Closed";
    if (!inScope.has(n) && !ended) continue;
    const open = status.queue ? batches.get(`open:${n}`) : undefined;
    if (open && open.pr === null) continue;
    const merged = status.step === "Merged" ? batches.get(`merged:${n}`) : undefined;
    const pr = (open ?? merged)?.pr;
    const facts: StatusFacts = { status, ...(pr ? { batch: { pr } } : {}) };
    const line = statusLine(facts);
    if (prev?.line != null ? prev.line !== line : !NO_FIRST_POST.has(status.step)) out.push({ number: n, facts, line, prev });
  }
  return out;
}

/** The earliest end of a failure backoff of the repo's comments after `now`, or null. */
export async function statusRetryAt(db: Db, repo: string, now: number = Date.now()): Promise<number | null> {
  const r = await db.get(db.k.selectFrom("main.pr_status_comments").select((eb) => eb.fn.min("retry_at").as("at"))
    .where("repo", "=", repo).where("final", "=", 0).where("retry_at", ">", new Date(now).toISOString()));
  return r?.at ? Date.parse(r.at) : null;
}

/** Backoffs that have ended, for the lane's fingerprint: the planner tries those PRs again once the time has passed. */
export async function statusRetriesDue(db: Db, now: number = Date.now()): Promise<string> {
  const r = await db.get(db.k.selectFrom("main.pr_status_comments").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("final", "=", 0).where("retry_at", "<=", new Date(now).toISOString()));
  return String(r?.n ?? 0);
}

/** Each PR's open merge batch at its current head (`open:N`) and the batch it merged with (`merged:N`): the batch's PR number, null before it opens. */
async function batchesOf(db: Db, repo: string, numbers: number[]): Promise<Map<string, { pr: number | null }>> {
  const rows = await db.all(db.k.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as b", "b.id", "bp.batch_id")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "b.repo").onRef("i.number", "=", "bp.number"))
    .select(["bp.number", "b.state", "b.pr_number", "bp.head_oid", "i.head_oid as head"])
    .where("b.repo", "=", repo).where("bp.number", "in", numbers).where("b.state", "in", [...ACTIVE_BATCH, "merged"]).orderBy("b.id"));
  const out = new Map<string, { pr: number | null }>();
  for (const r of rows) {
    if (r.state === "merged") out.set(`merged:${r.number}`, { pr: r.pr_number });
    else if (r.head_oid === r.head) out.set(`open:${r.number}`, { pr: r.pr_number });
  }
  return out;
}

const FIND_QUERY = `query($owner: String!, $name: String!, $n: Int!, $before: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    comments(last: 100, before: $before) { pageInfo { hasPreviousPage startCursor } nodes { databaseId body author { login } } }
  } }
}`;
const MAX_PAGES = 50;
type GhComment = { databaseId: number; body: string; author: { login: string } | null };
type Found = { id: string; author: string | null };

/**
 * Pages back through the PR's comments from the newest until `pick` matches one. null: the PR was read and has no such
 * comment. Throws when the PR cannot be read or has more comments than MAX_PAGES pages.
 */
async function searchComments(q: Querier, repo: string, number: number, pick: (c: GhComment) => boolean): Promise<Found | null> {
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await q.query(FIND_QUERY, { owner: ownerOf(repo), name: repo, n: number, before }) as { repository?: { pullRequest?: { comments?: { pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }; nodes?: GhComment[] } } | null } };
    const c = r.repository?.pullRequest?.comments;
    if (!c) throw new Error("the pull request could not be read");
    const hit = (c.nodes ?? []).findLast(pick);
    if (hit) return { id: String(hit.databaseId), author: hit.author ? plainLogin(hit.author.login) : null };
    if (!c.pageInfo?.hasPreviousPage || !c.pageInfo.startCursor) return null;
    before = c.pageInfo.startCursor;
  }
  throw new Error(`more than ${MAX_PAGES * 100} comments: not searched to the end`);
}

/** The login our comments are written as now (plainLogin), or null when it is not known. */
async function writerLogin(db: Db): Promise<string | null> {
  const login = await githubIdentity(db) === "box" ? await setting(db, "pipeline_login") : appSlug();
  return login ? plainLogin(login) : null;
}

const commentIdOf = (stdout: string): string | null => /#issuecomment-(\d+)/.exec(stdout)?.[1] ?? null;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const notFound = (r: { stderr: string; stdout: string }): boolean => /404|not found/i.test(`${r.stderr} ${r.stdout}`);

export type PrStatusParams = { repo: string; by: By; runId: string; limit: number; log?: (line: string) => void; querier?: Querier; exec?: Exec; now?: () => Date; base?: string | null };
export type PrStatusResult = { posted: string[]; edited: string[]; gone: string[]; failed: string[]; due: number; paced: boolean };

/**
 * Posts or edits the due status comments of one repo, at most `limit`, under a per-repo lease so two jobs never post on
 * the same PR. One PR failing does not stop the others; a paced write ends the job.
 */
export async function runPrStatus(db: Db, p: PrStatusParams): Promise<PrStatusResult> {
  const log = p.log ?? (() => {});
  const out: PrStatusResult = { posted: [], edited: [], gone: [], failed: [], due: 0, paced: false };
  const now = p.now ?? (() => new Date());
  const due = await statusDue(db, p.repo, now().getTime());
  out.due = due.length;
  if (!due.length) return out;
  const g = await guardRepo(db, p.repo, "status", p.by);
  if ("refused" in g) { log(g.refused); return out; }
  const release = await leaseItem(db, `pr-status:${p.repo}`, log);
  if (!release) return out;
  try {
    const w: Writer = { db, login: ACTOR };
    const q = p.querier ?? new Client(500), run = p.exec ?? realExec;
    const base = (p.base === undefined ? envVar("BASE_URL") ?? null : p.base)?.replace(/\/+$/, "") || null;
    const me = await writerLogin(db), ours = await ownLoginTest(db, p.repo);
    for (const d of due.slice(0, Math.max(0, p.limit))) {
      const ref = `${p.repo}#${d.number}`, at = now().toISOString();
      const history = withStep(d.prev ? parseSteps(d.prev.steps) : [], WORDS[d.facts.status.step], at);
      const body = commentBody(p.repo, d.number, d.line, history, d.facts.status.step === "In the merge queue", base);
      const row = { line: d.line, steps: JSON.stringify(history), final: d.facts.status.step === "Merged" ? 1 : 0, failures: 0, retry_at: null, updated_at: at };
      try {
        let found: Found | null = d.prev?.comment_id ? { id: d.prev.comment_id, author: d.prev.author } : await searchComments(q, p.repo, d.number, (c) => c.body.includes(MARKER) && ours(c.author?.login ?? null));
        // A comment written as another identity (the box account before a switch to the app) cannot be edited: a new one replaces it.
        if (found && me && found.author && found.author !== me) found = null;
        const r = found
          ? await ghEditComment(w, g, run, "pr-status-comment-edit", { repo: p.repo, number: d.number, commentId: found.id }, { by: "fixed" }, body, { run: p.runId, line: d.line })
          : await ghComment(w, g, run, "pr-status-comment", { repo: p.repo, number: d.number, pr: true }, { by: "fixed" }, body, { run: p.runId, line: d.line });
        if (r.code !== 0 && found && notFound(r)) {
          // Deleted on GitHub (the PR reads and the comment is not on it): never posted again on this PR.
          const id = found.id;
          if (await searchComments(q, p.repo, d.number, (c) => String(c.databaseId) === id) === null) {
            await store(db, p.repo, d.number, { ...row, comment_id: id, author: found.author, line: d.prev?.line ?? null, steps: d.prev?.steps ?? "[]", final: 1 });
            out.gone.push(ref);
            await jobItem(db, p.repo, d.number, "status comment deleted on GitHub; not posted again", log);
            continue;
          }
        }
        if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
        await store(db, p.repo, d.number, { ...row, comment_id: found?.id ?? commentIdOf(r.stdout), author: found ? found.author : me });
        (found ? out.edited : out.posted).push(ref);
        await jobItem(db, p.repo, d.number, `status comment ${found ? "edited" : "posted"}: ${d.line}`, log);
      } catch (e) {
        if (e instanceof WritePacedError) { out.paced = true; log(`${p.repo}: ${e.message}`); break; }
        out.failed.push(ref);
        const failures = (d.prev?.failures ?? 0) + 1;
        await store(db, p.repo, d.number, { comment_id: d.prev?.comment_id ?? null, author: d.prev?.author ?? null, line: d.prev?.line ?? null, steps: d.prev?.steps ?? "[]", final: 0, failures, retry_at: retryAt(failures, now().getTime()), updated_at: at });
        await jobItem(db, p.repo, d.number, `status comment failed: ${oneLine(String((e as Error).message ?? e))}`, log);
      }
    }
  } finally {
    await release();
  }
  return out;
}

type RowValues = { comment_id: string | null; author: string | null; line: string | null; steps: string; final: number; failures: number; retry_at: string | null; updated_at: string };
async function store(db: Db, repo: string, number: number, row: RowValues): Promise<void> {
  await db.run(db.k.insertInto("main.pr_status_comments").values({ repo, number, ...row }).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(row)));
}

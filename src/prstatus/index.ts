// The PR status comment: one comment per PR the pipeline works on, posted at the first step past triage (review, fix-up,
// CI, a decision, the merge queue) and edited in place whenever its status line changes; GitHub sends no notification for
// an edit. The line comes from the public status layer (src/public/status.ts), so it never carries hold reasons, review
// text or anything about a security fix. Places in the queue past QUEUE_EXACT show as one bucket, so a merge or a new
// batch edits only the PRs near the front. Writes go through src/github/write.ts as bulk writes (half the pacing budget),
// under the repo's PR status switch (src/prstatus/approval.ts) and the step's daily limit. No timer: the planner queues
// the step when a PR's line differs from the one posted.
import { commentStatuses, type PublicStatus, type PublicStep } from "../public/status.ts";
import { guardRepo } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { ghComment, ghEditComment, WritePacedError, type Writer } from "../github/write.ts";
import { ownLoginTest } from "../github/identity.ts";
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

export type StatusFacts = { status: PublicStatus; /** The PR's open merge batch, or the batch it merged with: its PR number, or null before the batch PR opens. */ batch?: { pr: number | null } };

/** The status line: the step, with the place in the merge queue or the merge batch. */
export function statusLine(f: StatusFacts): string {
  const s = f.status, word = WORDS[s.step];
  if (s.step === "Merged") return f.batch?.pr ? `${word} with merge batch #${f.batch.pr}` : word;
  if (s.step !== "In the merge queue") return word;
  if (f.batch) return f.batch.pr ? `${word}: checked in merge batch #${f.batch.pr}` : `${word}: in a merge batch being checked`;
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

type Stored = { number: number; comment_id: string | null; line: string; steps: string; final: number };
export type Due = { number: number; facts: StatusFacts; line: string; prev: Stored | null };

const parseSteps = (s: string): HistoryStep[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is HistoryStep => !!x && typeof x.step === "string" && typeof x.at === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The PRs of a repo whose comment is due: an open PR in the pipeline's scope past triage with no comment yet, or a PR
 * whose posted line differs from its line now (merged and closed ones get one last edit). Batch PRs get none.
 */
export async function statusDue(db: Db, repo: string): Promise<Due[]> {
  const stored = await db.all(db.k.selectFrom("main.pr_status_comments").select(["number", "comment_id", "line", "steps", "final"]).where("repo", "=", repo));
  const byNumber = new Map(stored.map((r) => [r.number, r]));
  const open = await db.all(db.k.selectFrom("main.items as i").select("i.number")
    .where("i.repo", "=", repo).where("i.kind", "=", "pr").where("i.state", "=", "OPEN")
    .where((eb) => eb.or([
      eb.exists(eb.selectFrom("main.item_stage as s").select(eb.lit(1).as("one")).whereRef("s.repo", "=", "i.repo").whereRef("s.number", "=", "i.number")),
      eb.exists(eb.selectFrom("main.decisions as d").select(eb.lit(1).as("one")).whereRef("d.repo", "=", "i.repo").whereRef("d.number", "=", "i.number").where("d.answer", "is", null)),
    ]))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.merge_batches as b").select(eb.lit(1).as("one")).whereRef("b.repo", "=", "i.repo").whereRef("b.pr_number", "=", "i.number"))))
    .where((eb) => pilotExpr(db, eb, "i")));
  const numbers = [...new Set([...open.map((r) => r.number), ...stored.filter((r) => !r.final).map((r) => r.number)])];
  if (!numbers.length) return [];
  const statuses = await commentStatuses(db, repo, numbers);
  const batches = await batchesOf(db, repo, numbers);
  const out: Due[] = [];
  for (const n of numbers.sort((a, b) => a - b)) {
    const status = statuses.get(n), prev = byNumber.get(n) ?? null;
    if (!status || prev?.final) continue;
    // A security case has no place in the queue and shows the plain step, without its batch.
    const batch = status.step === "Merged" ? batches.get(`merged:${n}`) : status.queue ? batches.get(`open:${n}`) : undefined;
    const facts: StatusFacts = { status, ...(batch && { batch }) };
    const line = statusLine(facts);
    if (prev ? prev.line !== line : !NO_FIRST_POST.has(status.step)) out.push({ number: n, facts, line, prev });
  }
  return out;
}

/** Each PR's open merge batch at its current head (`open:N`) and the batch it merged with (`merged:N`). */
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

const FIND_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) { comments(last: 100) { nodes { databaseId body author { login } } } } }
}`;

/** Our status comment on the PR read from GitHub (its comment id), for a PR with no stored row: a post whose row was lost is edited, not made again. */
async function findOnGitHub(db: Db, q: Querier, repo: string, number: number): Promise<string | null> {
  const ours = await ownLoginTest(db, repo);
  const r = await q.query(FIND_QUERY, { owner: ownerOf(repo), name: repo, n: number }) as { repository?: { pullRequest?: { comments?: { nodes?: { databaseId: number; body: string; author: { login: string } | null }[] } } | null } };
  const hit = (r.repository?.pullRequest?.comments?.nodes ?? []).findLast((c) => c.body.includes(MARKER) && ours(c.author?.login ?? null));
  return hit ? String(hit.databaseId) : null;
}

const commentIdOf = (stdout: string): string | null => /#issuecomment-(\d+)/.exec(stdout)?.[1] ?? null;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export type PrStatusParams = { repo: string; by: By; runId: string; limit: number; log?: (line: string) => void; querier?: Querier; exec?: Exec; now?: () => Date; base?: string | null };
export type PrStatusResult = { posted: string[]; edited: string[]; gone: string[]; failed: string[]; due: number; paced: boolean };

/** Posts or edits the due status comments of one repo, at most `limit`. One PR failing does not stop the others; a paced write ends the job. */
export async function runPrStatus(db: Db, p: PrStatusParams): Promise<PrStatusResult> {
  const log = p.log ?? (() => {});
  const out: PrStatusResult = { posted: [], edited: [], gone: [], failed: [], due: 0, paced: false };
  const due = await statusDue(db, p.repo);
  out.due = due.length;
  if (!due.length) return out;
  const g = await guardRepo(db, p.repo, "status", p.by);
  if ("refused" in g) { log(g.refused); return out; }
  const w: Writer = { db, login: ACTOR };
  const q = p.querier ?? new Client(500), run = p.exec ?? realExec, now = p.now ?? (() => new Date());
  const base = (p.base === undefined ? envVar("BASE_URL") ?? null : p.base)?.replace(/\/+$/, "") || null;
  for (const d of due.slice(0, Math.max(0, p.limit))) {
    const ref = `${p.repo}#${d.number}`, at = now().toISOString();
    const history = withStep(d.prev ? parseSteps(d.prev.steps) : [], WORDS[d.facts.status.step], at);
    const body = commentBody(p.repo, d.number, d.line, history, d.facts.status.step === "In the merge queue", base);
    const final = d.facts.status.step === "Merged" || d.facts.status.step === "Closed" ? 1 : 0;
    try {
      const id = d.prev?.comment_id ?? await findOnGitHub(db, q, p.repo, d.number);
      const r = id
        ? await ghEditComment(w, g, run, "pr-status-comment-edit", { repo: p.repo, number: d.number, commentId: id }, { by: "fixed" }, body, { run: p.runId, line: d.line })
        : await ghComment(w, g, run, "pr-status-comment", { repo: p.repo, number: d.number, pr: true }, { by: "fixed" }, body, { run: p.runId, line: d.line });
      if (r.code !== 0 && id && /404|not found/i.test(`${r.stderr} ${r.stdout}`)) {
        // Someone deleted the comment: it is not posted again on this PR.
        await store(db, p.repo, d.number, id, d.line, history, 1, at);
        out.gone.push(ref);
        await jobItem(db, p.repo, d.number, "status comment deleted on GitHub; not posted again", log);
        continue;
      }
      if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
      await store(db, p.repo, d.number, id ?? commentIdOf(r.stdout), d.line, history, final, at);
      (id ? out.edited : out.posted).push(ref);
      await jobItem(db, p.repo, d.number, `status comment ${id ? "edited" : "posted"}: ${d.line}`, log);
    } catch (e) {
      if (e instanceof WritePacedError) { out.paced = true; log(`${p.repo}: ${e.message}`); break; }
      out.failed.push(ref);
      await jobItem(db, p.repo, d.number, `status comment failed: ${oneLine(String((e as Error).message ?? e))}`, log);
    }
  }
  return out;
}

async function store(db: Db, repo: string, number: number, commentId: string | null, line: string, steps: HistoryStep[], final: number, at: string): Promise<void> {
  const row = { comment_id: commentId, line, steps: JSON.stringify(steps), final, updated_at: at };
  await db.run(db.k.insertInto("main.pr_status_comments").values({ repo, number, ...row }).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(row)));
}

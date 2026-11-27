// The issue review step (`issue-review`): for each issue of the repo whose review a maintainer asked for, one Opus call on the
// requester's Task Runner with a read-only checkout of the default branch head, the review stored on its issue_reviews row and
// posted as one comment on the issue. It also posts a review's question to the reporter once a maintainer said yes to it. What a
// person answers to the review is the workflow's (src/workflow/advance.ts makes the recommendation from the stored row).
import { isHalt } from "../agents/call.ts";
import { runModelStep } from "../agents/step.ts";
import { ISSUE_REVIEW } from "../agents/steps.ts";
import { pool } from "../classify/run.ts";
import { ISSUE_REVIEW_TRIES } from "../core/backoff.ts";
import type { By } from "../core/gates.ts";
import { guardItem } from "../core/guard.ts";
import { plannedItems } from "../core/select-items.ts";
import { loadLatestIssueReview, saveIssueReview, type IssueReviewRow } from "../data/issuereview/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { loadDuplicatesOf } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { ghComment, type Writer } from "../github/write.ts";
import { ownerOf } from "../owners.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { discussionOf } from "../review/discussion.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { issueReviewBody, questionBody } from "./comment.ts";
import { ISSUE_BODY_CHARS, type IssueReview, type IssueReviewInput } from "./prompt.ts";

const PROMPT = CLAUDE_PROMPTS["review.issue"];
/** The audit login of the step's writes. */
const ACTOR = "issue-review";
/** Issues of one job reviewed at once; each call waits for its own requester's Task Runner. */
const AT_ONCE = 4;

export type IssueReviewParams = { repo: string; number?: number; by: By; jobId?: number; onHandled?: (n: number) => void };
export type IssueReviewDeps = {
  /** A read-only checkout of the repo's default branch head: its directory, commit and branch; null when none could be made. */
  checkout: (db: Db, repo: string) => Promise<{ dir: string; sha: string; branch: string } | null>;
  /** The review call; absent: the real model call on the requester's Task Runner. */
  ask?: (input: IssueReviewInput, forLogin: string) => Promise<{ value: IssueReview; model: string } | null>;
  exec?: Exec;
  /** Replaces the installation-token minter of the writes (tests). */
  mint?: Writer["mint"];
};
export type IssueReviewSummary = { runId: string; reviewed: number; asked: number; failed: number; waiting: number };

export function defaultIssueReviewDeps(): IssueReviewDeps {
  return {
    checkout: async (db, repo) => {
      const branch = (await loadRepos(db, { names: [repo], all: true })).get(repo)?.default_branch ?? "main";
      const { mainHeadOf } = await import("../github/fork.ts");
      const sha = await mainHeadOf(repo, branch);
      const dir = sha ? await checkoutForCommit(repo, branch, sha, console.log) : null;
      return dir && sha ? { dir, sha, branch } : null;
    },
  };
}

/** The issue as the prompt shows it: its text, the discussion, and the duplicates and pull requests AutoCraft knows. */
async function inputOf(db: Db, repo: string, number: number, openPr: { number: number; closes: boolean } | null): Promise<IssueReviewInput | null> {
  const ref = `${repo}#${number}`;
  const [items, dupes, discussion] = await Promise.all([loadItems(db, [{ repo, number }], "text"), loadDuplicatesOf(db, [{ repo, number }]), discussionOf(db, repo, number)]);
  const it = items.get(ref);
  if (!it) return null;
  const others = [...(dupes.get(ref) ?? []).map((d) => ({ n: d.other, relation: "duplicate" as const })), ...(openPr ? [{ n: openPr.number, relation: openPr.closes ? "closes" as const : "mentions" as const }] : [])];
  const known = others.length ? await loadItems(db, others.map((o) => ({ repo, number: o.n })), "text") : new Map();
  const labels = (() => { try { const v = JSON.parse(it.labels ?? "[]") as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })();
  return {
    ref, title: it.title ?? "", body: (it.body ?? "").slice(0, ISSUE_BODY_CHARS), author: it.author ?? null, author_association: it.author_association ?? null, labels,
    comments: discussion.entries,
    related: others.flatMap((o) => {
      const x = known.get(`${repo}#${o.n}`);
      return x ? [{ ref: `#${o.n}`, kind: x.kind === "pr" ? "pull request" as const : "issue" as const, state: x.state, title: x.title ?? "", relation: o.relation }] : [];
    }),
  };
}

/** Reviews, or asks the reporter on, every due issue of the repo (or the one named). */
export async function runIssueReviews(db: Db, p: IssueReviewParams, log: (l: string) => void = console.log, deps?: IssueReviewDeps): Promise<IssueReviewSummary> {
  const d = deps ?? defaultIssueReviewDeps();
  const runId = `issue-review-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: IssueReviewSummary = { runId, reviewed: 0, asked: 0, failed: 0, waiting: 0 };
  const due = (await plannedItems(db, "issue-review", { repo: p.repo, by: p.by })).filter((x) => p.number === undefined || x.facts.number === p.number);
  if (!due.length) { log(`issue review ${p.repo}: nothing due`); return s; }
  let checkout: Promise<Awaited<ReturnType<IssueReviewDeps["checkout"]>>> | undefined;
  let handled = 0;
  await pool(due.map((x) => async () => {
    const { repo, number } = x.facts, ref = `${repo}#${number}`;
    const g = await guardItem(db, { repo, number }, { kind: "issue-review" }, p.by);
    if ("refused" in g) { s.waiting++; log(`  ${g.refused}`); return; }
    const row = await loadLatestIssueReview(db, repo, number);
    if (!row) { s.waiting++; return; }
    const w: Writer = { db, login: ACTOR, ...(d.mint && { mint: d.mint }) };
    if (row.state === "ask") {
      const author = (await loadItems(db, [{ repo, number }], "card")).get(ref)?.author ?? null;
      const r = await ghComment(w, g, d.exec ?? defaultExec, "issue-question", { repo, number, pr: false }, { by: "model", kind: "question", model: row.model }, questionBody(row.question ?? "", author, ownerOf(repo)), { review: row.id });
      if (r.code !== 0) { s.failed++; log(`  ${ref}: the question to the reporter was not posted: ${r.stderr.replace(/\s+/g, " ").slice(0, 200)}`); return; }
      await saveIssueReview(db, row.id, { state: "reporter", askedAt: new Date().toISOString() }, ["ask"]);
      s.asked++;
      p.onHandled?.(++handled);
      log(`  ${ref}: question posted to the reporter`);
      return;
    }
    if (row.state !== "queued" && row.state !== "reporter") { s.waiting++; return; }
    const input = await inputOf(db, repo, number, x.facts.openPr);
    if (!input) { s.waiting++; return; }
    const co = d.ask ? null : await (checkout ??= d.checkout(db, repo));
    let got: { value: IssueReview; model: string } | null;
    try {
      if (d.ask) got = await d.ask(input, row.requestedBy);
      else {
        const r = await runModelStep(db, ISSUE_REVIEW, { ...input, ...(co && { repo_dir: REPO_PATH }) }, {
          model: PROMPT.models[0]!, ...(co && { checkout: co.dir }), forLogin: row.requestedBy,
          usage: { run: runId, agent: `issue-review-${repo}-${number}`, stage: "review", items: (ok) => (ok ? 1 : 0) },
        });
        got = r.ok ? { value: r.value, model: r.model || PROMPT.models[0]! } : null;
      }
    } catch (e) {
      if (!isHalt(e)) throw e;
      s.waiting++;
      log(`  ${ref}: ${row.requestedBy}'s Task Runner did not take the review; it waits`);
      return;
    }
    p.onHandled?.(++handled);
    await record(db, row, got, co, d, { log, summary: s, jobId: p.jobId ?? null, g });
  }), Math.min(AT_ONCE, due.length));
  log(`issue review ${p.repo}: ${s.reviewed} reviewed, ${s.asked} questions posted, ${s.failed} failed, ${s.waiting} waiting`);
  return s;
}

/** Stores the call's outcome on the row and posts a valid review on the issue. */
async function record(db: Db, row: IssueReviewRow, got: { value: IssueReview; model: string } | null, co: { sha: string; branch: string } | null, d: IssueReviewDeps,
  o: { log: (l: string) => void; summary: IssueReviewSummary; jobId: number | null; g: Parameters<typeof ghComment>[1] }): Promise<void> {
  const ref = `${row.repo}#${row.number}`, at = new Date().toISOString(), expect = ["queued", "reporter"] as const;
  if (!got) {
    const tries = row.tries + 1, failed = tries >= ISSUE_REVIEW_TRIES;
    await saveIssueReview(db, row.id, { tries, triedAt: at, error: "no valid review", ...(failed && { state: "failed" as const }), jobId: o.jobId }, expect);
    o.summary.failed++;
    o.log(`  ${ref}: no valid review (call ${tries} of ${ISSUE_REVIEW_TRIES})${failed ? "; the maintainer is asked whether to try again" : ""}`);
    return;
  }
  const r = await ghComment({ db, login: ACTOR, ...(d.mint && { mint: d.mint }) }, o.g, d.exec ?? defaultExec, "issue-review-comment", { repo: row.repo, number: row.number, pr: false }, { by: "model", kind: "review", model: got.model },
    issueReviewBody(got.value, { owner: ownerOf(row.repo), head: co?.sha ?? null, branch: co?.branch ?? null }), { review: row.id, recommendation: got.value.recommendation });
  const url = r.code === 0 ? /https:\/\/\S+#issuecomment-\d+/.exec(r.stdout)?.[0] ?? null : null;
  if (r.code !== 0) o.log(`  ${ref}: the review comment was not posted: ${r.stderr.replace(/\s+/g, " ").slice(0, 200)}`);
  await saveIssueReview(db, row.id, {
    state: "done", review: got.value, model: got.model, commitSha: co?.sha ?? null, reviewedAt: at, tries: 0, error: r.code === 0 ? null : "the review comment was not posted", commentUrl: url, jobId: o.jobId,
  }, expect);
  o.summary.reviewed++;
  o.log(`  ${ref}: reviewed, recommends ${got.value.recommendation}`);
}

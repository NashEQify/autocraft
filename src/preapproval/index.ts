// Pipeline steps of a resolution card (review again, fix-up, fix-up then merge) and the pre-approved merge they can start.
//
// A pre-approved merge is the merge leg of a person's workflow: the merge they approved, worked through a fix-up, its review, CI
// and the pre-merge review. States (see Preapproval in web/src/api/types.ts):
//   fixup   -> the fix-up step works the operator's instructions (source 'operator' in its fixups rows)
//   review  -> the fix-up pushed; waiting for the Opus review of the pushed head. A row with no fix-up (a Merge answer carried across a
//              base merge, or "Queue items") starts here at its head.
//   ci      -> that review says take (sure or unsure, not stale); waiting for CI of the pushed head, then for a clean pre-merge review of it.
//              A take-fix review keeps the row in review while the pipeline's fix-up of its fixes runs; that push is reviewed again.
//   queued  -> CI is green and the pre-merge review is clean: the merge queue merges it as the person who approved the workflow
//              (src/core/may.ts mayMerge), with every check it always makes (safe-merge included)
//   merged / cancelled / failed end it. A stop ends the leg failed; the workflow then stops at a blocker with its recommendation.
// Every transition is a pure reaction to rows other steps write (fixups, opus_reviews, pr_checks, items, merges), evaluated by
// advancePreapprovals on each runner tick: no timer and no wait of its own; the one time comparison (the start of the mirror's last sync against the push) is made when the tick runs anyway. Merging itself is never called from here.
import { settleMemo, settlesNow } from "../settlers.ts";
import type { Preapproval } from "../../web/src/api/types.ts";
import type { Step } from "../conversations/cards.ts";
import { systemBlock } from "../conversations/store.ts";
import { cifixBucket, decidePr, fixupOf, ownImplementation, reviseOf } from "../core/decide.ts";
import { loadPrFact, loadPrFacts } from "../core/facts.ts";
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";
import { mayMerge, mayPush, type WorkflowGate } from "../core/may.ts";
import { ensureAuthorWrites } from "../fixup/author-permission.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { repoHasNoCi } from "../merge/no-ci.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { releaseMerge, removeFromBatch } from "../merge/controls.ts";
import type { Exec } from "../fixup/git.ts";
import { markReviewsStale, staleReviews } from "../review/discussion.ts";
import { reviewHold } from "../review/gate.ts";
import type { PrFacts } from "../core/plan.ts";
import { operatorTriesLeft, queuedOperatorFix } from "./state.ts";
import { refreshSettlers, type RefreshDeps } from "./permissions.ts";
import { addAudit, listAudit, listPushOutcomes, loadAuditActions, loadStepApprovals, withConfig, type StepApproval } from "../data/control/index.ts";
import { loadChecks, loadItems, loadRepos, type PrChecksView } from "../data/mirror/index.ts";
import { getBatch, loadBatchByBranch, loadBatchMembership, loadMergeFacts, type MergeFacts } from "../data/merge/index.ts";
import { loadOperatorFixResults, loadPushEdges, ownPushKind, type PushEdge } from "../data/changes/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import { isRunning } from "../data/jobs/index.ts";
import { addTurns } from "../data/conversations/index.ts";
import {
  addFixupRequests, addLegs, adoptLegs, endFixupRequests, loadFixupRequests, loadHolds, loadLegPass, loadLegs, loadRepins, loadWorkflowFacts, moveLegs,
  type LegContext, type LegMove, type LegRow, type LegState, type WorkflowFact,
} from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { readSeqs } from "../live.ts";
import { INPUT_TOPICS } from "../runner/autopilot.ts";

export type PipelineStep = Extract<Step, { kind: "review" | "fixup" }>;

const ACTOR = "pipeline";
export const INSTRUCTIONS_MAX = 1500;
const ACTIVE: readonly LegState[] = ["fixup", "review", "ci", "queued"];
/** Plan states in which the PR gets no review, so a pre-approved merge cannot go on. A label never stops one: a live pre-approval lifts the label gate (src/core/decide.ts). */
const NOT_REVIEWABLE = ["out-of-scope", "integration", "backlog", "duplicate", "draft", "scope"];
const iso = () => new Date().toISOString();
const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);
const refOf = (repo: string, n: number) => `${repo}#${n}`;

type Row = LegRow;
type PrRow = { state: string; head_oid: string | null; kind: string; head_repo: string | null; head_ref: string | null };

const prRow = async (db: Db, repo: string, n: number): Promise<PrRow | undefined> =>
  (await loadItems(db, [{ repo, number: n }], "pr")).get(refOf(repo, n));

/** The PR's plan state as it would be with a live pre-approved merge, which lifts the label gate: what a new pre-approval can count on. */
function preapprovedState(f: PrFacts | null): string | null {
  return f ? decidePr({ ...f, operator: { fix: null, hold: false, premerge: false, ...f.operator, preapproved: true } }).state : null;
}

const toView = (r: Row): Preapproval => ({ id: r.id, by: r.by, at: r.at, instructions: r.instructions, state: r.state, fromHead: r.from_head, head: r.head, reason: r.reason, updatedAt: r.updated_at });

/** The newest pre-approved merge of the PR, or null. */
export async function preapprovalOf(db: Db, repo: string, n: number): Promise<Preapproval | null> {
  const r = (await loadLegs(db, [{ repo, number: n }], { latestOnly: true })).get(refOf(repo, n))?.at(-1);
  return r ? toView(r) : null;
}

/** Every pre-approved merge of the PR, oldest first. */
export async function preapprovalsOf(db: Db, repo: string, n: number): Promise<Preapproval[]> {
  return ((await loadLegs(db, [{ repo, number: n }])).get(refOf(repo, n)) ?? []).map(toView);
}

/** The system lines of the items' threads (items with no conversation are skipped). Not inside a transaction: the thread writes its own. */
async function sayAll(db: Db, lines: { repo: string; number: number; text: string }[]): Promise<void> {
  if (!lines.length) return;
  await addTurns(db, lines.map((l) => ({ ref: refOf(l.repo, l.number), kind: "system", login: "system", body: l.text, block: systemBlock(l.text), onlyIfThread: true })));
}
const say = async (db: Db, repo: string, n: number, text: string): Promise<void> => await sayAll(db, [{ repo, number: n, text }]);

/** Moves the row to `to` when it is still in its state; the module audits the transition (the trace shows it). Joins a caller's transaction. */
async function moveRaw(db: Db, p: Row, to: LegState, o: { head?: string | null; reason?: string | null; by?: string; via?: string }): Promise<boolean> {
  const m: LegMove = { id: p.id, from: p.state, to, ...(o.head != null ? { head: o.head } : {}), reason: o.reason ?? null, ...(o.by ? { by: o.by } : {}), ...(o.via ? { via: o.via } : {}) };
  return (await moveLegs(db, [m])).length === 1;
}

/** `moveRaw`, then says it in the thread. Not inside a transaction: the thread writes its own. */
async function move(db: Db, p: Row, to: LegState, o: { head?: string | null; reason?: string | null; by?: string; line: string }): Promise<boolean> {
  if (!await moveRaw(db, p, to, o)) return false;
  await say(db, p.repo, p.number, o.line);
  return true;
}

/**
 * An operator, or a maintainer who still settles on the repo (src/settlers.ts): their approval counts. `held` is the pass's
 * `refreshSettlers` result: a maintainer's write permission the pipeline is reading again still counts until GitHub answers.
 */
const isOperator = async (db: Db, login: string | null, repo: string, held?: ReadonlySet<string>): Promise<boolean> => await settlesNow(db, login, [repo], { ...settleMemo(), held });

/** The PR's newest merge attempt at `head` merged it. */
const mergedAt = (m: MergeFacts, repo: string, n: number, head: string | null): boolean => !!head && m.attempts.get(`${refOf(repo, n)}@${head}`)?.outcome === "merged";

/**
 * Whether the merge leg may merge at `head` (mayMerge, src/core/may.ts): with a live workflow, as the person who approved it; a leg is
 * itself that person's approval (the merge command and the approval start it before the workflow row records the approval), so
 * `by` stands in until the row has it. With no live workflow, the repo's merge approval. The leg's own head rules decide which heads it
 * may merge (a push that is not ours cancels it), and the workflow stops its leg at a blocker, so the gate takes `head` as the base
 * and no blocker.
 */
function mergeGate(approval: StepApproval | null, wf: WorkflowFact | null, head: string, by: string): { ok: true } | { ok: false; why: string } {
  const workflow: WorkflowGate | null = wf ? {
    live: true, entry: wf.entry as WorkflowGate["entry"], state: wf.state, startedBy: wf.startedBy, approvedBy: wf.approvedBy ?? by, approvedAt: null,
    blocker: null, baseHead: head, fixupAsked: false,
  } : null;
  const r = mayMerge({ repoApproval: approval, workflow, head, ownHeads: new Set([head]) });
  return r.ok ? { ok: true } : { ok: false, why: r.why };
}

/** The live workflow of the PR, or of the issue it implements, and the repo's merge approval. */
async function gateFacts(db: Db, repo: string, n: number): Promise<{ wf: WorkflowFact | null; approval: StepApproval | null }> {
  const [facts, approvals] = await db.together(() => Promise.all([loadWorkflowFacts(db, [{ repo, number: n }]), loadStepApprovals(db, [repo], ["merge"])]));
  return { wf: facts.live.get(refOf(repo, n)) ?? facts.ofPr.get(refOf(repo, n)) ?? null, approval: approvals.get(repo)?.merge ?? null };
}

/** Cancels the row in one transaction, whatever state the caller read. False when the row had ended meanwhile. */
async function cancelRow(db: Db, leg: { id: number; repo: string; number: number }, by: string, reason: string, line: string, guard = false, via?: string): Promise<boolean> {
  // Nothing is written before an early return, so committing leaves the database as a rollback would.
  const p = await db.write(async () => {
    const p = (await loadLegs(db, [{ repo: leg.repo, number: leg.number }], { activeOnly: true })).get(refOf(leg.repo, leg.number))?.find((r) => r.id === leg.id);
    if (!p || !ACTIVE.includes(p.state)) return null;
    // Past the guard of the merge queue, a cancel cannot stop the merge: a batch holds the PR, or it is merged.
    if (guard && p.state === "queued") {
      if (await inActiveBatch(db, p.repo, p.number)) throw new Error("the PR is still in an integration batch");
      if (await mergeRunning(db, p.repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
      if (mergedAt(await loadMergeFacts(db, [{ repo: p.repo, number: p.number }]), p.repo, p.number, p.head)) throw new Error("the PR is already merged");
    }
    return await moveRaw(db, p, "cancelled", { by, reason, via }) ? p : null;
  });
  if (!p) return false;
  await say(db, p.repo, p.number, line);
  return true;
}

// ---- starting a step ----------------------------------------------------------------------------------------------------

/** Queues a card's pipeline step for the PR; `label` is the done line the card shows. Throws when the step cannot start. */
/** `preapproval`: the id of the pre-approved merge a fix-up that merges started. */
export async function runPipelineStep(db: Db, o: { repo: string; number: number; step: PipelineStep; by: string }): Promise<{ label: string; preapproval?: number }> {
  const { repo, number, step, by } = o;
  const ref = `${repo}#${number}`;
  const it = await prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new Error(`${ref} is not a pull request`);
  if (it.state !== "OPEN") throw new Error(`${ref} is not open`);
  if (step.kind === "review") {
    await markReviewsStale(db, by, repo, number);
    return { label: "Queued a new review of the current head" };
  }
  // The fix-up step and the review of its push only see PRs the planner works: out of scope, integration and unreviewable PRs would wait for ever.
  const fact = await loadPrFact(db, repo, number);
  const planState = step.merge === true ? preapprovedState(fact) : fact ? decidePr(fact).state : null;
  if (!planState || planState === "out-of-scope" || planState === "integration") throw new Error(`${ref} is outside the pipeline's scope: no fix-up runs on it`);
  if (step.merge === true && NOT_REVIEWABLE.filter((x) => x !== "scope").includes(planState)) throw new Error(`${ref} cannot be reviewed (${planState}): a merge after the fix-up could not follow`);
  const instructions = step.instructions.trim();
  if (!instructions) throw new Error("the fix-up needs instructions");
  if (instructions.length > INSTRUCTIONS_MAX) throw new Error(`the instructions are over ${INSTRUCTIONS_MAX} characters`);
  const head = it.head_oid;
  if (!head) throw new Error(`${ref} has no head commit in the mirror yet`);
  const checks = (await loadChecks(db, [{ repo, number }])).get(refOf(repo, number)) as PrChecksView | undefined;
  if (checks?.mergeable === "CONFLICTING") throw new Error(`${ref} conflicts with its base branch: the conflict merge comes first`);
  // A person's fix-up runs as that person (mayPush, src/core/may.ts); the repo's push approval is for pushes nobody asked for.
  const may = mayPush({ kind: "fixup", repoApproval: null, workflow: null, operatorFix: true, by });
  if (!may.ok) throw new Error(may.why);
  const writes = await ensureAuthorWrites(db, repo, number, it.head_repo);
  if (writes === "unknown") throw new Error("the author's permission on the repository could not be read yet; try again");
  if (!pushable(it.head_repo, repo, checks?.head_oid === head ? checks.maintainer_can_modify : null, it.head_ref, await longLivedOf(db, repo), false, writes === "yes")) throw new Error("can't push to the contributor's branch");
  if (!await operatorTriesLeft(db, repo, number)) throw new Error("the fix-up tries for this PR are used up");
  if (await queuedOperatorFix(db, repo, number, head)) throw new Error(`a fix-up of ${ref} is already queued`);
  const merge = step.merge === true;
  const activeCheck = async () => {
    if ((await loadLegs(db, [{ repo, number }], { activeOnly: true })).has(ref)) throw new Error(`${ref} already has a pre-approved merge in progress`);
  };
  let workflowId: number | undefined;
  if (merge) {
    const g = await gateFacts(db, repo, number);
    const ok = mergeGate(g.approval, g.wf, head, by);
    if (!ok.ok) throw new Error(g.wf ? ok.why : `merging is not approved for ${repo}`);
    workflowId = g.wf?.id;
    await activeCheck();
  }
  // The insert of a merge request refuses a second active leg itself (the partial unique index): it throws and writes nothing.
  const made = (await addFixupRequests(db, [{ repo, number, fromHead: head, instructions, by, merge, ...(workflowId !== undefined ? { workflowId } : {}) }])).get(ref);
  const id = made?.legId ?? null;
  await say(db, repo, number, merge
    ? `${by} approved a merge after a fix-up: a fix-up of ${short(head)} is queued; if its review says take and CI is green, the PR goes to the merge queue.`
    : `${by} queued a fix-up of ${short(head)}.`);
  return { label: merge ? "Queued the fix-up; the PR merges if its review says take and CI is green" : "Queued the fix-up", ...(id !== null ? { preapproval: id } : {}) };
}

/** Why a PR in a NOT_REVIEWABLE plan state gets no code review, in words a commenter can act on. */
function notReviewableWhy(state: string, scopeAnswer: string | null): string {
  switch (state) {
    case "backlog": return "it is in the backlog";
    case "duplicate": return "it is held as a duplicate";
    case "draft": return "it is a draft";
    case "scope": return scopeAnswer === null ? "its scope question is still open" : `its scope answer (${scopeAnswer}) keeps it out of core`;
    default: return state;
  }
}

/** Why a pre-approval pinned to a head (a comment's) was refused: the PR has another head now. */
export const HEAD_CHANGED = "the PR changed after your comment; comment again";

/** preapproveMerge's refusal by rule (the PR, its state or the repo's approval); other errors may pass on a later try. `active`: one is in progress already. */
export class PreapprovalRefused extends Error {
  readonly active: boolean;
  constructor(message: string, active = false) { super(message); this.active = active; }
}

/**
 * "Queue items" (a PR line): an operator's Merge answer given ahead, with no fix-up. A row starts in `review` at the current head,
 * the way a carried answer does, so the PR merges only after a take review, a clean pre-merge review and green CI there. The approval
 * says the change is wanted, so an unsure review does not stop it, and a take-fix review's fixes are made by the pipeline's fix-up,
 * whose push is reviewed again; a pre-merge defect, a red head the CI fix cannot repair or a fix-up that cannot run asks the
 * Merge? question instead. Throws when it cannot start.
 *
 * The PR's label does not matter (the pre-approval lifts the label gate); a draft, the backlog, a duplicate hold or a scope question still refuse it.
 * `head`, when given, is the only head it may pre-approve: the head the person saw (a command's comment-time head).
 */
export async function preapproveMerge(db: Db, o: { repo: string; number: number; by: string; via?: string; head?: string; workflowId?: number }): Promise<{ label: string }> {
  const { repo, number, by, via } = o;
  const ref = `${repo}#${number}`;
  const it = await prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new PreapprovalRefused(`${ref} is not a pull request`);
  if (it.state !== "OPEN") throw new PreapprovalRefused(`${ref} is not open`);
  const fact = await loadPrFact(db, repo, number);
  const planState = preapprovedState(fact);
  if (!planState || planState === "out-of-scope" || planState === "integration") throw new PreapprovalRefused(`${ref} is outside the pipeline's scope`);
  if (NOT_REVIEWABLE.includes(planState)) throw new PreapprovalRefused(`${ref} cannot be reviewed yet: ${notReviewableWhy(planState, fact?.scopeAnswer ?? null)}`);
  const head = it.head_oid;
  if (!head) throw new Error(`${ref} has no head commit in the mirror yet`);
  if (o.head !== undefined && head !== o.head) throw new Error(HEAD_CHANGED);
  const g = await gateFacts(db, repo, number);
  const wf = o.workflowId !== undefined && g.wf?.id !== o.workflowId ? null : g.wf;
  const ok = mergeGate(g.approval, wf, head, by);
  if (!ok.ok) throw new PreapprovalRefused(wf ? ok.why : `merging is not approved for ${repo}`);
  const busy = () => new PreapprovalRefused(`${ref} already has a pre-approved merge in progress`, true);
  if ((await loadLegs(db, [{ repo, number }], { activeOnly: true })).has(ref)) throw busy();
  // `workflowId`: the workflow whose merge leg this is, written with the row so no pass sees it unowned. The insert refuses a second active leg.
  const made = (await addLegs(db, [{ repo, number, by, workflowId: (o.workflowId ?? wf?.id ?? null) as number, head, state: "review", ...(via ? { via } : {}) }])).get(ref);
  if (made === "active") throw busy();
  await say(db, repo, number, `${by} added the PR to the merge queue at ${short(head)}: it merges once the review there says take, the pre-merge review is clean and CI is green.`);
  return { label: "Added to the merge queue; it merges once the review says take and CI is green" };
}

// ---- the state machine ---------------------------------------------------------------------------------------------------

/**
 * What the thread calls the row's head: the fix-up's push; for a row without a fix-up, the pipeline's push it went on with (a base merge,
 * an autorepin or the fix-up of a review's fixes) or, for one added to the merge queue and not pushed to since, the PR's own head.
 */
function headName(p: Row): string {
  return p.fix_id !== null ? "the pushed head" : p.head !== p.from_head ? "the new head" : "the PR's head";
}

/** What one advance pass reads of the legs' PRs, loaded in one wave for every active leg. */
type PassFacts = {
  items: Map<string, PrRow>;
  checks: Map<string, PrChecksView>;
  syncedAt: Map<string, string | null>;
  merge: MergeFacts;
  fixResults: Map<number, { state: string; toHead: string | null; reason: string | null }>;
  edges: Map<string, PushEdge[]>;
  /** `ref` -> from -> to of the implementation session's revisions. */
  implPushes: Map<string, Map<string, string>>;
  /** `ref` -> autorepins that are waiting, locking or pushed. */
  repins: Map<string, { head: string | null; to_head: string | null }[]>;
  approvals: Map<string, StepApproval | null>;
  workflows: Map<number, WorkflowFact>;
  reviews: Map<string, { verdict: string; sure: boolean; reason: string; at: string }>;
};

async function loadPassFacts(db: Db, rows: Row[]): Promise<PassFacts> {
  const refs = [...new Map(rows.map((r) => [refOf(r.repo, r.number), { repo: r.repo, number: r.number }])).values()];
  const repos = [...new Set(rows.map((r) => r.repo))];
  const heads = rows.flatMap((r) => (r.head ? [{ repo: r.repo, number: r.number, head: r.head }] : []));
  const fixIds = rows.flatMap((r) => (r.fix_id !== null ? [r.fix_id] : []));
  const [items, checks, repoRows, merge, fixResults, edges, outcomes, repins, approvals, wfFacts, reviews] = await db.together(() => Promise.all([
    loadItems(db, refs, "pr"), loadChecks(db, refs), loadRepos(db, { names: repos }), loadMergeFacts(db, refs), loadOperatorFixResults(db, fixIds),
    loadPushEdges(db, refs), listPushOutcomes(db, { refs: refs.map((r) => refOf(r.repo, r.number)) }), loadRepins(db, refs, { states: ["waiting", "locking", "pushed"] }),
    loadStepApprovals(db, repos, ["merge"]), loadWorkflowFacts(db, refs), loadReviewsAt(db, heads),
  ]));
  const implPushes = new Map<string, Map<string, string>>();
  for (const o of outcomes) {
    if (o.action !== "implement-push" || o.number === null || !o.from_oid) continue;
    const k = refOf(o.repo, o.number);
    (implPushes.get(k) ?? implPushes.set(k, new Map()).get(k)!).set(o.from_oid, o.to_oid);
  }
  const workflows = new Map<number, WorkflowFact>();
  for (const f of [...wfFacts.live.values(), ...wfFacts.ofPr.values()]) workflows.set(f.id, f);
  return {
    items, checks, merge, fixResults, edges, implPushes, workflows,
    syncedAt: new Map(repos.map((r) => [r, repoRows.get(r)?.synced_at ?? null])),
    repins: new Map([...repins].map(([k, v]) => [k, v.map((x) => ({ head: x.head, to_head: x.to_head }))])),
    approvals: new Map(repos.map((r) => [r, approvals.get(r)?.merge ?? null])),
    reviews: new Map([...reviews].map(([k, v]) => [k, { verdict: v.verdict, sure: v.sure, reason: v.reason, at: v.at }])),
  };
}

type Hand = { done: true } | { gone: true } | { wait: true } | { stop: string };

/** Moves the row from ci to queued: the merge queue merges it as the workflow's approver from here. Idempotent. */
async function handOver(db: Db, p: Row, head: string, held: ReadonlySet<string>, pf: PassFacts, unsure = false): Promise<Hand> {
  if (!await isOperator(db, p.by, p.repo, held)) return { stop: `${p.by} no longer settles decisions on ${p.repo}` };
  // A hand-over waits for a running verification and never goes on over a failed one.
  const v = pf.merge.verifications.get(`${refOf(p.repo, p.number)}@${head}`);
  if (v && (v.state === "planned" || v.state === "running")) return { wait: true };
  if (v && (v.state === "failed" || v.state === "error")) return { stop: `verification failed at ${headName(p)}` };
  if (!await moveRaw(db, p, "queued", { head })) return { gone: true };
  await say(db, p.repo, p.number, unsure
    ? "CI is green and the pre-merge review found no defect, though it could not verify every claim of the description: the merge was approved, so the PR is in the merge queue, which checks it as for any approved merge."
    : "CI is green and the pre-merge review is clean: the PR is in the merge queue, which checks it as for any approved merge.");
  return { done: true };
}

type ReviewRead = { kind: "none" | "stale" | "take" | "takefix" | "bad"; why: string; unsure: boolean; at?: string };

/**
 * The Opus review at `head`. A take or take-fix that is not stale goes on, sure or unsure: the merge approval says the change is wanted,
 * so a take-fix is the pipeline's own fix-up to make and the pre-approval goes on with its push. Any other verdict stops it.
 */
async function reviewAt(db: Db, p: Row, head: string, pf: PassFacts, wake?: Wake): Promise<ReviewRead> {
  const r = pf.reviews.get(`${refOf(p.repo, p.number)}@${head}`);
  if (!r) return { kind: "none", why: "", unsure: false };
  const ref = refOf(p.repo, p.number);
  if ((await staleReviews(db, p.repo, false, { refresh: (r, at) => (r === ref ? wake?.(at) : undefined) })).has(`${ref}@${head}`)) return { kind: "stale", why: "", unsure: false };
  const unsure = !r.sure;
  if (r.verdict === "take") return { kind: "take", why: "", unsure, at: r.at };
  if (r.verdict === "take-fix") return { kind: "takefix", why: r.reason ? oneLine(r.reason, 160) : "", unsure, at: r.at };
  return { kind: "bad", why: `the review says ${r.verdict}${unsure ? " (unsure)" : ""}${r.reason ? `: ${oneLine(r.reason, 160)}` : ""}`, unsure, at: r.at };
}

/** Why an unsure review or a take-fix does not stop the row, for its thread line. */
const approvedAhead = (p: Row) => (p.fix_id !== null ? "the merge was approved with a fix-up" : "the PR was queued to merge");

/** Says `line` in the thread once per row, head and note (the audit entry is the memory): for a wait that moves the row nowhere. */
async function noteOnce(db: Db, p: Row, head: string, note: string, line: string): Promise<void> {
  const ref = refOf(p.repo, p.number);
  const seen = ((await loadAuditActions(db, [ref], ["preapproval"])).get(ref) ?? [])
    .some((a) => a.details?.id === p.id && a.details?.note === note && a.details?.head === head);
  if (seen) return;
  await addAudit(db, [{ login: ACTOR, action: "preapproval", target: ref, details: { id: p.id, head, note } }]);
  await say(db, p.repo, p.number, line);
}

/**
 * "base merge", "autorepin", "fix-up for the review's fixes" or the implementation session's revision when the pipeline itself pushed `cur` on top of the row's head, else null.
 * The review's fix-up counts for every row: the merge approval says the change is wanted, and the fix-up's push gets a fresh review.
 */
function ownPush(p: Row, cur: string, pf: PassFacts): string | null {
  const ref = refOf(p.repo, p.number);
  // Only a base merge that left the PR's own diff unchanged continues an approval; a CI fix or a resolved conflict is model-written code nobody saw.
  const kind = p.head ? ownPushKind(pf.edges.get(ref) ?? [], p.head, cur) : null;
  if (kind) return kind;
  // A revision of our implementation PR by the session that wrote it: the PR is the queuer's implementation, and the push gets a fresh review.
  if (p.head && pf.implPushes.get(ref)?.get(p.head) === cur) return "implementation session's revision";
  // An autorepin (src/repin) is no model's code either: the revs of a dependency moved to a merge commit on its default branch, as someone who may queue the PR asked.
  if ((pf.repins.get(ref) ?? []).some((a) => a.head === p.head && a.to_head === cur)) return "autorepin";
  return null;
}

/** Our implementation PR whose revision by its session is planned or running: the review's fixes and red CI are its to repair. */
const revisesNow = (f: PrFacts): boolean => !!reviseOf(f) || ownImplementation(f)?.state === "revising";

/** Why the planner does not list the operator's fix-up for the PR now; null when it does. */
async function whyNotPlanned(db: Db, f: PrFacts): Promise<string | null> {
  if (decidePr(f).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator")) return null;
  if (f.draft) return "the PR is a draft";
  if (f.heldBacklog) return "the PR is held in the backlog";
  if (f.mergeable === "CONFLICTING") return "the PR conflicts with its base branch";
  if (!f.pushable) return "the PR's branch cannot be pushed to";
  if (!f.repoFacts.pushApproved) return "pushing is not approved for the repo";
  if (!await operatorTriesLeft(db, f.repo, f.number)) return "the fix-up tries are used up";
  return "the pipeline does not plan the fix-up";
}

/** Whether the CI fix or conflict step is working the PR now or the planner lists it: a wait for it ends. A step the planner does not list (not approved, held, merge blocked) and that has no task in flight never moves the PR on. */
function stepRuns(f: PrFacts, step: "cifix" | "conflict"): boolean {
  const acts = decidePr(f).actions;
  if (step === "conflict") return f.conflict?.bucket === "linting" || acts.some((a) => a.kind === "conflict" && a.params?.bucket === "merge");
  const b = cifixBucket(f);
  return (b !== null && ["formatting", "linting", "rerun-wait"].includes(b)) || acts.some((a) => a.kind === "cifix" && !["capped", "ask"].includes(String(a.params?.bucket)));
}

const FAILED_FIXUP = ["failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];

/**
 * One merge leg: reads what the other steps recorded and makes at most one transition. A stop ends the leg failed: the workflow stops at a
 * blocker and gives its recommendation (src/workflow/advance.ts). A merge-queue entry has no Opus review to wait for, and a review the
 * person answered after (a yes past a major finding) counts as a take.
 */
async function advance(db: Db, p: Row, ctx: LegContext | "ended", held: ReadonlySet<string>, pf: PassFacts, factOf: () => Promise<PrFacts | null>, wake: Wake): Promise<void> {
  const ref = refOf(p.repo, p.number);
  const it = pf.items.get(ref);
  const cancel = async (reason: string) => void await cancelRow(db, p, ACTOR, reason, `The pre-approved merge was cancelled: ${reason}.`);
  const cur = it?.head_oid ?? null;
  const mergedByQueue = mergedAt(pf.merge, p.repo, p.number, p.head);
  if (p.state === "queued" && (it?.state === "MERGED" || mergedByQueue)) return void await move(db, p, "merged", { line: "The pre-approved merge went through: the PR is merged." });
  if (ctx === "ended") {
    // The workflow of a merged PR ends before this pass sees the merge: a queued leg whose merge is under way is left for merge detection,
    // so its history shows the merge and not a cancel.
    if (p.state === "queued" && it?.state === "OPEN" && await mergeRunning(db, p.repo)) return;
    if (it?.state !== "MERGED") return cancel("its workflow ended");
  }
  const leg = ctx === "ended" ? null : ctx;
  const stop = async (why: string) => void await move(db, p, "failed", { reason: why, line: `The pre-approved merge stopped: ${why}.` });
  // A review the person had seen when they last answered: they chose to go on.
  const accepted = (r: ReviewRead): ReviewRead => (leg && r.kind === "bad" && r.at !== undefined && r.at <= leg.since ? { ...r, kind: "take" } : r);
  if (!it) return cancel("the PR is gone");
  if (it.state === "MERGED") return cancel(p.fix_id !== null ? "the PR was merged before the fix-up finished" : "the PR was merged before the pre-approved merge reached the merge queue");
  if (it.state !== "OPEN") return cancel("the PR was closed");

  // The fix-up and the review that follows run on the maker's authority; the queued state re-checks the approval below.
  if (p.state !== "queued" && !await isOperator(db, p.by, p.repo, held)) return cancel(`${p.by} no longer settles decisions on ${p.repo}`);

  if (p.state === "fixup") {
    const fx = p.fix_id !== null ? pf.fixResults.get(p.fix_id) : undefined;
    if (fx?.state === "pushed" && fx.toHead) return void await move(db, p, "review", { head: fx.toHead, line: `The fix-up pushed ${short(fx.toHead)}; Opus reviews it next.` });
    if (fx && FAILED_FIXUP.includes(fx.state)) return await stop(`the fix-up ${fx.state}${fx.reason ? `: ${oneLine(fx.reason, 120)}` : ""}`);
    // A push written before it ran: when the head is its commit, it landed.
    if (fx?.state === "pushing" && fx.toHead && cur === fx.toHead) return void await move(db, p, "review", { head: fx.toHead, line: `The fix-up pushed ${short(fx.toHead)}; Opus reviews it next.` });
    // Whatever the fix-up row says (none yet, linting, pushing), a head that is neither its start nor its push is someone else's.
    if (cur !== null && cur !== p.from_head && cur !== fx?.toHead) return cancel(`another push moved the head to ${short(cur)}`);
    // No try yet and the planner would not work the request (not pushable, conflicting, a draft, ...): it would wait for ever.
    if (!fx) {
      const f = await factOf();
      const why = f ? await whyNotPlanned(db, f) : null;
      if (why) await stop(`the fix-up cannot run: ${why}`);
    }
    return;
  }

  // Every later state: the head is the fix-up's push (or, with no fix-up, the row's starting head). Until a review exists at it, the mirror may still show the head the push started from, for a short time.
  const head = p.head!;
  if (cur !== null && cur !== head) {
    // The mirror row shows the old head until a sync that started after the push has finished (synced_at is the sync's start; the row's state entry follows the push); a review at the pushed head also shows the mirror saw it.
    const synced = pf.syncedAt.get(p.repo) ?? null;
    const lag = p.state === "review" && cur === p.from_head && (synced === null || synced <= p.updated_at) && !pf.reviews.has(`${ref}@${head}`);
    if (!lag && p.state !== "queued") {
      // The pipeline's own CI fix or conflict merge on the pushed head carries the pre-approval on: the new head needs the whole chain again.
      const own = ownPush(p, cur, pf);
      if (own) return void await move(db, p, "review", { head: cur, line: `The ${own} pushed ${short(cur)}; it needs a fresh review, a clean pre-merge review and green CI before the PR goes to the merge queue.` });
    }
    if (!lag) return cancel(cur === p.from_head ? `the head went back to ${short(cur)}` : `another push moved the head to ${short(cur)}`);
  }

  if (p.state === "review" && leg?.entry === "merge") {
    return void await move(db, p, "ci", { line: `In the merge queue at ${short(head)} with no review; waiting for CI and a clean pre-merge review.` });
  }
  if (p.state === "review") {
    const r = accepted(await reviewAt(db, p, head, pf, wake));
    if (r.kind === "stale") return;
    if (r.kind === "none") {
      // No review is coming for a PR the planner does not review (an open scope question, a draft, a hold).
      const f = cur === head ? await factOf() : null;
      const state = f ? decidePr(f).state : null;
      if (state && NOT_REVIEWABLE.includes(state)) return await stop(`${headName(p)} cannot be reviewed (${state})`);
      // The gate lifts every hold for a pre-approved head except a review that failed for good, which only a new request or push ends.
      const hold = cur === head ? await reviewHold(db, p.repo, p.number, head) : null;
      if (hold?.kind === "failed" && hold.until === undefined) return await stop(`the review of ${headName(p)} waits on ${hold.wait}`);
      return;
    }
    const name = p.fix_id !== null ? "the fix-up" : headName(p);
    if (r.kind === "take") {
      return void await move(db, p, "ci", { line: r.unsure ? `The review of ${name} says take but is unsure; ${approvedAhead(p)}, so it goes on: waiting for CI.` : `The review of ${name} says take; waiting for CI.` });
    }
    if (r.kind === "takefix") {
      // The planner's fix-up of the review's fixes runs next, sure or unsure (fixupOf). Its push is our own (ownPush), so the row stays and the new head is reviewed; when no fix-up can run, a person decides.
      const f = cur === head ? await factOf() : null;
      const fx = f ? fixupOf(f) : null;
      // Our implementation PR goes back to the session that wrote it instead; its push is our own as well.
      if (f && revisesNow(f)) return await noteOnce(db, p, head, "review-revise", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the implementation session makes them.`);
      if (fx && ((fx.bucket === "fix" && !fx.done) || fx.bucket === "hold")) {
        return await noteOnce(db, p, head, "review-fixup", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the fix-up runs.`);
      }
      return await stop(`the review of ${name} asks for fixes and its fix-up cannot run${fx ? ` (${fx.bucket})` : ""}`);
    }
    return await stop(r.why);
  }

  const gate = mergeGate(pf.approvals.get(p.repo) ?? null, leg ? pf.workflows.get(leg.workflowId) ?? null : null, head, leg?.approvedBy ?? p.by);
  if (!gate.ok) return p.state === "queued" ? cancel("merging is no longer approved") : await stop("merging is no longer approved");

  if (p.state === "ci") {
    // A re-review since the move to ci counts: the hand-over needs a take at this head now. A merge-queue entry has no review.
    const r: ReviewRead = leg?.entry === "merge" ? { kind: "take", why: "", unsure: false } : accepted(await reviewAt(db, p, head, pf, wake));
    if (r.kind === "none" || r.kind === "stale") return void await move(db, p, "review", { line: `The review of ${headName(p)} is out of date; Opus reviews it again.` });
    if (r.kind === "takefix") return void await move(db, p, "review", { line: `The review of ${headName(p)} now asks for fixes; the pipeline's fix-up comes first.` });
    if (r.kind === "bad") return await stop(r.why);
    const c = pf.checks.get(ref);
    if (!c || c.head_oid !== head || c.overall === "pending") return;
    if (c.overall === "failure") {
      // The CI fix step works the red head as it would for any PR; its push is a head nobody saw, so the leg ends. A person decides when the step has given up.
      const f = await factOf();
      if (f && revisesNow(f)) return;
      const bucket = f ? cifixBucket(f) : null;
      if (bucket !== null && ["work", "formatting", "linting", "collect", "rerun", "rerun-wait"].includes(bucket) && stepRuns(f!, "cifix")) return;
      return await stop(`CI failed at ${headName(p)} and the CI fix did not repair it`);
    }
    if (c.overall === "none" && !await repoHasNoCi(db, p.repo)) return;
    if (c.mergeable === "CONFLICTING") {
      // The conflict step merges the base into the PR when it can; its push is a new head that continues this pre-approval.
      const f = await factOf();
      if (f?.conflict?.baseOk && ["merge", "linting"].includes(f.conflict.bucket) && stepRuns(f, "conflict")) return;
      return await stop("the PR conflicts with its base branch");
    }
    // The pre-merge review of this head must be clean; the planner runs it (src/core/decide.ts) and retries a failed one.
    const pm = await premergeAt(db, p.repo, p.number, head);
    if (!pm || (pm.findings === null && pm.tries < PREMERGE_MAX_TRIES)) return;
    if (pm.findings === null) return await stop(`the pre-merge review of ${headName(p)} failed`);
    const defects = findingsOf(pm).filter((x) => x.severity === "defect").length;
    if (defects) return await stop(`the pre-merge review found ${defects} defect${defects === 1 ? "" : "s"}`);
    // The merge approval says the change is wanted: an unsure pre-merge review (a claim of the description it could not verify) with
    // no defect goes on to the merge queue; only a defect, or another blocker, brings the item back.
    const h = await handOver(db, p, head, held, pf, pm.unsure === 1);
    if ("stop" in h) await stop(h.stop);
    return;
  }

  // queued: the merge queue owns it now; only an approver who may no longer act ends it here.
  const by = leg?.approvedBy ?? p.by;
  if (!await isOperator(db, by, p.repo, held)) await cancel(`${by} no longer settles decisions on ${p.repo}, so the approval no longer counts`);
}

/** Ends fix-up requests the planner can no longer work (the PR's head moved, it closed, the push is not possible), with the reason in the thread. Requests of a pre-approved merge end with it. */
async function endStaleRequests(db: Db, wake: Wake): Promise<void> {
  const now = Date.now();
  // A request whose maker may no longer act on the repo (a demotion, a write permission gone) is dropped before the planner can push it.
  const [all, live] = await db.together(() => Promise.all([loadFixupRequests(db, { anyMaker: true, nowMs: now }), loadFixupRequests(db, { nowMs: now })]));
  const liveIds = new Set(live.map((o) => o.id));
  const gone = all.filter((o) => o.preapproval_id === null && !liveIds.has(o.id));
  const ended = new Set(await endFixupRequests(db, gone.map((o) => ({ id: o.id, reason: "the requester no longer settles here" }))));
  await sayAll(db, gone.filter((o) => ended.has(o.id)).map((o) => ({ repo: o.repo, number: o.number, text: `The queued fix-up of ${short(o.from_head)} was dropped: ${o.by} no longer settles decisions on ${o.repo}.` })));
  const ends: { id: number; reason: string; repo: string; number: number; head: string }[] = [];
  const results = await loadOperatorFixResults(db, live.map((o) => o.id));
  for (const o of live) {
    if (o.preapproval_id !== null) continue;
    const f = await loadPrFact(db, o.repo, o.number);
    if (f?.refreshAt !== undefined) wake(f.refreshAt);
    const why = !f ? "the PR is no longer open" : f.head !== o.from_head ? `the head moved to ${short(f.head)}` : results.has(o.id) ? null : await whyNotPlanned(db, f);
    if (why) ends.push({ id: o.id, reason: why, repo: o.repo, number: o.number, head: o.from_head });
  }
  const done = new Set(await endFixupRequests(db, ends.map((e) => ({ id: e.id, reason: e.reason }))));
  await sayAll(db, ends.filter((e) => done.has(e.id)).map((e) => ({ repo: e.repo, number: e.number, text: `The queued fix-up of ${short(e.head)} was dropped: ${e.reason}.` })));
}

/** A cancel that came too late for a merge already past its guard: the merge row that appears at the head turns the row into merged. */
async function settleCancelled(db: Db): Promise<void> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const targets = [...new Set((await listAudit(db, { actions: ["preapproval"], since, where: { state: "cancelled" } })).flatMap((a) => (a.target ? [a.target] : [])))];
  const refs = targets.flatMap((t) => { const m = /^(.+)#(\d+)$/.exec(t); return m ? [{ repo: m[1]!, number: Number(m[2]) }] : []; });
  if (!refs.length) return;
  const [legs, merges] = await db.together(() => Promise.all([loadLegs(db, refs, { latestOnly: true }), loadMergeFacts(db, refs)]));
  for (const p of [...legs.values()].flat()) {
    if (p.state !== "cancelled" || !p.head || p.updated_at <= since) continue;
    const a = merges.attempts.get(`${refOf(p.repo, p.number)}@${p.head}`);
    if (a?.outcome === "merged" && a.at >= p.at) await move(db, p, "merged", { line: "The merge went through before the cancel took effect: the PR is merged." });
  }
}

/** Told each time at which a pass's answer changes with the clock alone. */
export type Wake = (at: number) => void;

/**
 * What advancePreapprovals reads, as change markers: the planner's input topics (the PR facts and most rows the pass reads) and `access`
 * (roles, and the audit table: the GitHub writes that follow a base merge's own-diff mark, which no other topic watches). A pass whose
 * markers are the ones it read before and whose wake time (`Wake`) has not come would move nothing.
 */
export async function preapprovalInputs(db: Db): Promise<string> {
  const seqs = await readSeqs(db);
  return [...INPUT_TOPICS, "access"].map((t) => seqs[t] ?? 0).join(",");
}

/**
 * Moves each merge leg that other steps' rows have carried to a new state; the runner tick runs it when its inputs changed
 * (preapprovalInputs) or a time `wake` was told has come. Writes nothing when nothing moved, except the maintainers' write permissions it
 * reads again first (refreshSettlers). A failure tells `wake` the pass's own time, so the next tick runs it again.
 */
export async function advancePreapprovals(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: Wake = () => {}): Promise<number> {
  const t = Date.now();
  let n = 0;
  let held: Set<string>;
  try {
    held = await refreshSettlers(db, log, deps, wake);
  } catch (e) {
    // Without the permission reads a stale row would end a maintainer's pre-approval: nothing moves this pass.
    log(`preapproval permissions: ${(e as Error).message}`);
    wake(t);
    return 0;
  }
  try {
    await endStaleRequests(db, wake);
    await settleCancelled(db);
  } catch (e) {
    log(`preapproval requests: ${(e as Error).message}`);
    wake(t);
  }
  const pass = await loadLegPass(db);
  // A leg written before its workflow's row is linked to the live workflow of its PR.
  const adopt = pass.rows.flatMap((r) => { const c = pass.context.get(r.id); return r.workflow_id === null && c && c !== "ended" ? [{ id: r.id, workflowId: c.workflowId }] : []; });
  if (adopt.length) await adoptLegs(db, adopt);
  if (!pass.rows.length) return 0;
  const pf = await loadPassFacts(db, pass.rows);
  // The facts of the legs' PRs, loaded together when a leg first needs its PR's, with the settings read once for the load as in a planner pass.
  let facts: Map<string, PrFacts> | null = null;
  const refs = pass.rows.map((r) => refOf(r.repo, r.number));
  for (const p of pass.rows) {
    const factOf = async (): Promise<PrFacts | null> => {
      if (!facts) {
        const loaded = await withConfig(db, () => loadPrFacts(db, { refs }));
        for (const f of loaded) if (f.refreshAt !== undefined) wake(f.refreshAt);
        facts = new Map(loaded.map((f) => [refOf(f.repo, f.number), f]));
      }
      return facts.get(refOf(p.repo, p.number)) ?? null;
    };
    try {
      const before = p.state;
      await advance(db, p, pass.context.get(p.id) ?? "ended", held, pf, factOf, wake);
      const now = (await loadLegs(db, [{ repo: p.repo, number: p.number }], { ids: [p.id] })).get(refOf(p.repo, p.number))?.[0]?.state;
      if (now !== before) n++;
    } catch (e) {
      wake(t);
      const msg = oneLine(String((e as Error).message ?? e), 300);
      const ref = refOf(p.repo, p.number);
      log(`preapproval ${ref}: ${msg}`);
      // Runs every tick: the item's trace gets the error once, not once per tick.
      try {
        const last = ((await loadAuditActions(db, [ref], ["preapproval-error"])).get(ref) ?? []).reduce<{ rowid: number; details: Record<string, unknown> | null } | null>((a, b) => (!a || b.rowid > a.rowid ? b : a), null);
        if (!last || last.details?.error !== msg) await addAudit(db, [{ login: ACTOR, action: "preapproval-error", target: ref, details: { id: p.id, state: p.state, error: msg } }]);
      } catch { /* the log line above stands */ }
    }
  }
  return n;
}

export const mergeRunning = async (db: Db, repo: string): Promise<boolean> => (await isRunning(db, [{ step: "merge", repo }])).size > 0;
export const inActiveBatch = async (db: Db, repo: string, n: number): Promise<boolean> => (await loadBatchMembership(db, [{ repo, number: n }])).has(refOf(repo, n));

/**
 * A person cancels the PR's pre-approved merge before the merge queue has merged it. A queued PR in an integration batch is first
 * removed from the batch (the operator control: the batch PR is closed; the hold it sets is released) unless the merge is running.
 * Throws when there is none or the queue is past stopping it.
 */
export async function cancelPreapproval(db: Db, by: string, repo: string, n: number, run?: Exec, via?: string): Promise<Preapproval> {
  const p = (await loadLegs(db, [{ repo, number: n }], { activeOnly: true })).get(refOf(repo, n))?.at(-1);
  if (!p) throw new Error(`${repo}#${n} has no pre-approved merge in progress`);
  const finish = async () => {
    if (!await cancelRow(db, p, by, `cancelled by ${by}`, `${by} cancelled the pre-approved merge.`, true, via)) throw new Error("the pre-approved merge changed a moment ago");
  };
  if (p.state === "queued" && await inActiveBatch(db, repo, n)) {
    if (await mergeRunning(db, repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
    // The removal holds the PR's merge; a hold that was there before stays, the one the removal set is released again after the row
    // is cancelled (so the queue never sees an unheld PR with a live approval), also when the removal or the cancel fails.
    const heldBefore = (await loadHolds(db, { refs: [{ repo, number: n }] })).has(refOf(repo, n));
    try {
      const r = await removeFromBatch(db, by, repo, n, run);
      const id = await loadBatchByBranch(db, repo, r.batch);
      if (id !== undefined && (await getBatch(db, id))?.state === "merged") throw new Error("the PR is already merged: its batch merged");
      await finish();
    } finally {
      if (!heldBefore) await releaseMerge(db, by, repo, n);
    }
  } else await finish();
  return (await preapprovalOf(db, repo, n))!;
}

/**
 * Queues the PR's failed pre-approved merge again with the same instructions at the PR's current head, as a new pre-approval (the
 * same path as the first press: the audit entry and the thread line are the ones of any pre-approval). Throws when the latest
 * pre-approval did not fail.
 */
export async function retryPreapproval(db: Db, by: string, repo: string, n: number): Promise<Preapproval> {
  const p = (await loadLegs(db, [{ repo, number: n }], { latestOnly: true })).get(refOf(repo, n))?.at(-1);
  if (!p || p.state !== "failed") throw new Error(`${repo}#${n} has no failed pre-approved merge`);
  if (!await isOperator(db, by, repo)) throw new Error(`${by} does not settle decisions on ${repo}`);
  await runPipelineStep(db, { repo, number: n, step: { kind: "fixup", instructions: p.instructions, merge: true }, by });
  return (await preapprovalOf(db, repo, n))!;
}

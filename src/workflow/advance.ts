// Moves each live maintainer workflow on from what the pipeline recorded: its numbered plan from the latest review, a blocker that
// stops an approved item, the one recommendation an unapproved item comes back with when its steps are done, the merge leg of an
// approved PR (the pre-approved merge in src/preapproval, owned through preapprovals.workflow_id, which merges as the approver), and
// the end once the PR merged or closed. An implementation's open question, and a stuck implementation, come back as the issue's
// recommendation (question.ts). The runner runs it on each tick its inputs changed, before the pre-approval pass.
//
// A person answers the recommendation with a command (apply.ts), and nothing here writes to GitHub. The
// pass loads every workflow's facts at once and writes what changed in one write at its end. A workflow a person changed
// meanwhile (stopped, answered, approved) keeps what they did: the pass's write leaves it out and the next pass looks at it again.
import { loadPushOutcomeEdges, withConfig } from "../data/control/index.ts";
import { loadLatestFixPushes, loadPatchFacts, type PatchFacts } from "../data/changes/index.ts";
import { loadImplementFacts, type ImplementFacts } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadPremerge, loadReviewRows, type ReviewRow } from "../data/review/index.ts";
import { adoptLegs, listWorkflows, loadGoOnAt, loadLegs, loadRepins, moveWorkflows, recordEvents, type Preapproval, type WorkflowEvent, type WorkflowPatch } from "../data/workflow/index.ts";
import { isFenced } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { recheckDelayMs } from "../core/backoff.ts";
import { decidePr, fixedAfterMerge, MAINTAINER_ANSWER_WAIT, unapprovedStop } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import { chainsOwn, type OwnPush } from "../core/may.ts";
import type { PrFacts } from "../core/plan.ts";
import type { PlanReply } from "../implement/types.ts";
import { cancelPreapproval, inActiveBatch, PreapprovalRefused, preapproveMerge } from "../preapproval/index.ts";
import { findingsOf } from "../premerge/store.ts";
import { t } from "../i18n/index.ts";
import { detectBlocker, PREMERGE_STOP, type BlockerFacts, type Found } from "./blockers.ts";
import { afterSteps, atBlocker, onConflict, planOf, type ReviewView } from "./recommend.ts";
import { blockerThresholds } from "./settings.ts";
import { askedBy, isOpenQuestion, openQuestionOf, viewOf } from "./question.ts";
import { listText, stepsFor, type StepName } from "./status.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "./types.ts";
import { candidatePr, workOf } from "./work.ts";

const ACTOR = "pipeline";
const ACTIVE_LEG = ["fixup", "review", "ci", "queued"];
const ENDED_LEG = ["asked", "cancelled", "failed"];
/** Fix-up and CI fix tries that failed (src/fixup, src/cifix). */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];

/** What changed in a pass, for the Discord alerts and the log. */
export type Moved = { id: number; repo: string; number: number; to: ItemWorkflow["state"] };

/**
 * A live workflow whose check, or the write of what it found, failed each time since the pass last got it through: how often, the
 * latest error, and the row's version then. It is tried again at `until`, or when a person's command changed the row.
 */
export type FailedCheck = { ref: string; times: number; error: unknown; until: number; version: string };

/** Lockfiles a fix-up may touch as a side effect of its change: never "beyond what was agreed". */
const LOCKFILE = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/;

/** What the pass loaded for every live workflow, keyed `repo#number` (of the item, or of its PR). */
type Pass = {
  items: Map<string, { state: string; head_oid: string | null; closed_at: string | null }>;
  implement: ImplementFacts;
  goOn: Map<number, string>;
  legs: Map<string, Preapproval[]>;
  reviews: Map<string, ReviewRow[]>;
  patches: Map<string, PatchFacts>;
  fixes: Map<string, { fromHead: string; createdAt: string; lines: number; files: string[] }>;
  /** Our own pushes per PR: fix-ups, CI fixes, base merges, implementation revisions, autorepins. */
  moves: Map<string, OwnPush[]>;
  facts: Map<string, PrFacts>;
  thresholds: BlockerFacts["thresholds"];
};
/** The writes the pass collects, written once at its end; `was`: the row as the pass read it. */
type Writes = { workflows: { id: number; patch: WorkflowPatch; at: string; was: { state: ItemWorkflow["state"]; updatedAt: string } }[]; events: (WorkflowEvent & { workflowId: number })[]; adopt: { id: number; workflowId: number }[] };

const key = (repo: string, n: number): string => `${repo}#${n}`;

/** Whether our own pushes lead from `from` to `to`: the merge rule's own check (src/core/may.ts). */
const ownChain = (pass: Pass, ref: string, from: string, to: string): boolean => chainsOwn(pass.moves.get(ref) ?? [], from, to);

type Review = { at: string; verdict: string; sure: boolean; fixes: ReviewRow["fixes"]; workflow: ReviewRow["workflow"] };
const reviewAt = (pass: Pass, ref: string, head: string): Review | null => pass.reviews.get(ref)?.find((r) => r.head === head) ?? null;

/** Tries of a step on the PR that failed after `since`. */
function failures(pass: Pass, ref: string, since: string): { step: string; count: number }[] {
  const f = pass.patches.get(ref);
  const count = (rows: { state: string; createdAt: string }[]): number => rows.filter((r) => FAILED_TRY.includes(r.state) && r.createdAt > since).length;
  return [{ step: "fix-up", count: count(f?.fixups ?? []) }, { step: "CI fix", count: count(f?.cifixes ?? []) }];
}

/**
 * Our latest pushed fix-up of the PR's review findings (the review's own, or one a person asked for) after `since`: its changed lines,
 * its files, and the files the plan of the review it fixed names (that review is at the head it started from).
 */
function latestFix(pass: Pass, w: ItemWorkflow, ref: string, since: string): { fix: BlockerFacts["fix"]; plannedFiles: string[] } {
  const r = pass.fixes.get(ref);
  if (!r || r.createdAt <= since) return { fix: null, plannedFiles: [] };
  const fixed = reviewAt(pass, ref, r.fromHead);
  const plannedFiles = fixed ? planOf(fixed.fixes, w.plan).filter((p) => p.state !== "dropped" && p.file).map((p) => p.file!) : [];
  return { fix: { lines: r.lines, files: r.files.filter((f) => !LOCKFILE.test(f)) }, plannedFiles };
}

/** The pre-merge review's findings at the head, as plan parts numbered after `plan`'s. */
async function premergeParts(db: Db, repo: string, number: number, head: string, plan: readonly PlanPart[]): Promise<PlanPart[]> {
  const row = (await loadPremerge(db, [{ repo, number, head }])).get(`${key(repo, number)}@${head}`) ?? null;
  const fs = findingsOf(row).filter((f) => f.fix);
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  return fs.map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(f.severity === "defect" ? { major: true } : {}), state: "planned" as const }));
}

/** The merge leg of the workflow that ended after `since` (and none active), with its reason. */
function endedLeg(pass: Pass, w: ItemWorkflow, since: string): { reason: string } | null {
  const r = [...pass.legs.values()].flat().filter((l) => l.workflow_id === w.id).sort((a, b) => b.id - a.id)[0];
  if (!r || !ENDED_LEG.includes(r.state) || r.updated_at <= since) return null;
  return { reason: r.reason ?? r.state };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the PR's plan stops for a maintainer's answer: its steps are done, or a review verdict needs a person. */
const waitsForAnswer = (f: PrFacts): boolean => {
  const p = decidePr(f);
  return p.wait === MAINTAINER_ANSWER_WAIT || p.state === "opus-hold" || p.state === "opus-close";
};

/** Starts or adopts the approved PR's merge leg; a refusal is returned as the reason it cannot go on. */
async function ensureLeg(db: Db, pass: Pass, writes: Writes, w: ItemWorkflow, repo: string, pr: number, head: string): Promise<string | null> {
  const legs = pass.legs.get(key(repo, pr)) ?? [];
  const active = legs.filter((l) => ACTIVE_LEG.includes(l.state)).at(-1);
  if (!active) {
    // The queue merged the leg and the mirror does not show it yet: no new leg on a merged PR.
    if (legs.at(-1)?.state === "merged") return null;
    try {
      await preapproveMerge(db, { repo, number: pr, by: w.approvedBy!, via: "workflow", head, workflowId: w.id });
    } catch (e) {
      // A refusal by rule (not reviewable, merging not approved) needs a person; anything else is tried again on the next pass.
      // A leg that became active meanwhile is adopted, or waited for, on the next pass.
      if (e instanceof PreapprovalRefused) return e.active ? null : e.message;
      throw e;
    }
  } else if (active.workflow_id === null) writes.adopt.push({ id: active.id, workflowId: w.id });
  return null;
}

/**
 * Whether the head of an issue's implementation PR is one the workflow may go on with: a commit of ours on the branch we opened, or
 * our own pushes on top of a head a person was shown (`base_head`) or a merge leg was at (a leg starts at one of these or where a
 * person answered, and follows our own pushes only). "later": its facts are at another head, as for a moment after a push.
 */
function implHead(pass: Pass, w: ItemWorkflow, ref: string, head: string): "ours" | "theirs" | "later" | "unread" {
  const f = pass.facts.get(ref);
  const bases = [w.baseHead, ...(pass.legs.get(ref) ?? []).filter((l) => l.workflow_id === w.id).flatMap((l) => [l.from_head, l.head])];
  if (bases.some((b) => b !== null && ownChain(pass, ref, b, head))) return "ours";
  if (!f) return "unread";
  return f.head !== head ? "later" : f.may.ownHead ? "ours" : "theirs";
}

/**
 * One pass over the live workflows. Writes only what changed, in one write at the end, or each workflow by itself when that
 * write fails; returns the workflows that moved to another state. `failed`, kept between passes, holds by id the workflows the pass
 * could not check or store (their merge legs must not move), each tried again after a failure backoff; `wake` is told when.
 */
export async function advanceWorkflows(db: Db, log: (line: string) => void = () => {}, wake: (at: number) => void = () => {}, failed: Map<number, FailedCheck> = new Map()): Promise<Moved[]> {
  return await withConfig(db, async () => {
    const live = await listWorkflows(db, { live: true });
    const ids = new Set(live.map((w) => w.id));
    for (const id of failed.keys()) if (!ids.has(id)) failed.delete(id);
    if (!live.length) return [];
    const version = (w: ItemWorkflow): string => `${w.state} ${w.updatedAt}`;
    const now = Date.now();
    const due = live.filter((w) => { const f = failed.get(w.id); return !f || now >= f.until || f.version !== version(w); });
    for (const w of live) if (!due.includes(w)) wake(failed.get(w.id)!.until);
    const errors = new Map<number, unknown>();
    const issues = live.filter((w) => w.kind === "issue").map((w) => ({ repo: w.repo, number: w.number }));
    const [implement, goOn, thresholds] = await db.together(() => Promise.all([
      loadImplementFacts(db, issues, { withPlans: true }), loadGoOnAt(db, live), blockerThresholds(db),
    ]));
    const prRefs = [...new Map(live.flatMap((w) => {
      const number = w.kind === "pr" ? w.number : candidatePr(implement.byIssue.get(key(w.repo, w.number)), w);
      return number === null ? [] : [[key(w.repo, number), { repo: w.repo, number }] as const];
    })).values()];
    const itemRefs = [...new Map([...live.map((w) => ({ repo: w.repo, number: w.number })), ...prRefs].map((r) => [key(r.repo, r.number), r])).values()];
    const [items, legs, reviews, patches, fixes, outcomes, repins] = await db.together(() => Promise.all([
      loadItems(db, itemRefs, "pr"), loadLegs(db, prRefs), loadReviewRows(db, prRefs), loadPatchFacts(db, prRefs), loadLatestFixPushes(db, prRefs),
      loadPushOutcomeEdges(db, prRefs),
      loadRepins(db, prRefs, { states: ["pushed"] }),
    ]));
    const facts = new Map((prRefs.length ? await loadPrFacts(db, { refs: prRefs.map((r) => key(r.repo, r.number)) }) : []).map((f) => [key(f.repo, f.number), f]));
    const pass: Pass = {
      items, implement, goOn, legs, reviews, patches, fixes, facts, thresholds: { largeFix: thresholds.largeFixLines, outsideMin: thresholds.outsidePurposeMin },
      moves: new Map(prRefs.map((r) => key(r.repo, r.number)).map((k) => [k, [
        ...(patches.get(k)?.pushes ?? []), ...(outcomes.get(k) ?? []),
        ...(repins.get(k) ?? []).flatMap((r) => (r.head && r.to_head ? [{ from: r.head, to: r.to_head }] : [])),
      ]])),
    };
    const writes: Writes = { workflows: [], events: [], adopt: [] };
    const moved: Moved[] = [];
    for (const w of due) {
      try {
        const to = await advanceOne(db, pass, writes, w);
        if (to) moved.push({ id: w.id, repo: w.repo, number: w.number, to });
      } catch (e) {
        if (isFenced(e)) throw e;
        errors.set(w.id, e);
      }
    }
    const written = writes.workflows.length || writes.adopt.length ? await storeWrites(db, writes, due, log, errors) : new Set<number>();
    for (const w of due) {
      if (!errors.has(w.id)) { failed.delete(w.id); continue; }
      const error = errors.get(w.id), times = (failed.get(w.id)?.times ?? 0) + 1, until = Date.now() + recheckDelayMs(times);
      failed.set(w.id, { ref: key(w.repo, w.number), times, error, until, version: version(w) });
      log(`workflow ${w.repo}#${w.number}: ${(error as Error).message}`);
      wake(until);
    }
    return moved.filter((m) => written.has(m.id));
  });
}

/** Stores the pass's writes in one transaction; when it fails, each workflow's in its own, and those that fail go into `errors`. A fenced write is thrown. Returns the workflows stored. */
async function storeWrites(db: Db, writes: Writes, due: ItemWorkflow[], log: (line: string) => void, errors: Map<number, unknown>): Promise<Set<number>> {
  const store = (o: Writes): Promise<Set<number>> => db.write(async () => {
    const ids = await moveWorkflows(db, o.workflows);
    await recordEvents(db, o.events.filter((e) => ids.has(e.workflowId)));
    await adoptLegs(db, o.adopt);
    return ids;
  });
  try {
    return await store(writes);
  } catch (e) {
    if (isFenced(e)) throw e;
    const changed = due.filter((w) => writes.workflows.some((r) => r.id === w.id) || writes.adopt.some((r) => r.workflowId === w.id));
    log(`workflows: ${changed.length} changes not stored together, now one by one: ${(e as Error).message}`);
    const written = new Set<number>();
    for (const w of changed) {
      try {
        const ids = await store({
          workflows: writes.workflows.filter((r) => r.id === w.id), events: writes.events.filter((r) => r.workflowId === w.id), adopt: writes.adopt.filter((r) => r.workflowId === w.id),
        });
        for (const id of ids) written.add(id);
      } catch (err) {
        if (isFenced(err)) throw err;
        errors.set(w.id, err);
      }
    }
    return written;
  }
}

/** A ready plan's numbered parts; a part a person dropped before (same title) stays dropped. Null when the plan gave none. */
function implementParts(before: readonly PlanPart[], reply: PlanReply | null): PlanPart[] | null {
  const parts = reply?.ready ? reply.workflow?.parts ?? [] : [];
  if (!parts.length) return null;
  const dropped = new Set(before.filter((p) => p.source === "implement" && p.state === "dropped").map((p) => p.title.toLowerCase()));
  return parts.map((p, i) => ({ n: i + 1, title: p.title, source: "implement" as const, ...(p.files[0] ? { file: p.files[0] } : {}), files: p.files, state: dropped.has(p.title.toLowerCase()) ? "dropped" as const : "planned" as const }));
}

/** The files of a diff stat (src/build/workspaces.ts diffStat): one ` path | +a -d` line per file, at most its first 40. */
const statFiles = (stat: string | null): string[] =>
  (stat ?? "").split("\n").flatMap((l) => { const m = / (.+) \| (?:binary|\+\d+ -\d+)$/.exec(l); return m ? [m[1]!.trim()] : []; });

/**
 * The files the implementation itself changed (its own diff when its PR opened, not our later fix-ups or revisions) that no
 * planned part of the plan it was built from names; null when the plan named no files or the attempt recorded no diff.
 */
function implementationBeyond(pass: Pass, w: ItemWorkflow, pr: number): string[] | null {
  const opened = pass.implement.byIssue.get(key(w.repo, w.number))?.prAttempts.find((p) => p.prNumber === pr);
  const parts = implementParts([], opened?.plan ?? null) ?? [];
  const plannedFiles = new Set(parts.flatMap((p) => p.files ?? []));
  const files = statFiles(opened?.diffStat ?? null).filter((f) => !LOCKFILE.test(f));
  if (!plannedFiles.size || !files.length) return null;
  return files.filter((f) => !plannedFiles.has(f));
}

/** The first of `names` the workflow's steps have, else its first step. */
const stepIn = (w: ItemWorkflow, ...names: StepName[]): StepName => {
  const steps = stepsFor(w.entry, w.approvedBy !== null);
  return names.find((n) => steps.includes(n)) ?? steps[0]!;
};

async function advanceOne(db: Db, pass: Pass, writes: Writes, w0: ItemWorkflow): Promise<ItemWorkflow["state"] | null> {
  const at = new Date().toISOString();
  // The PR the workflow works on: its own item, or an implement workflow's implementation PR; null while an issue has none.
  const attempts = w0.kind === "issue" ? pass.implement.byIssue.get(key(w0.repo, w0.number)) : undefined;
  const candidate = candidatePr(attempts, w0);
  const work = workOf(attempts, w0, candidate === null ? null : pass.items.get(key(w0.repo, candidate)));
  const attempt = work.attempt;
  const target = w0.kind === "pr" ? w0.number : work.pr;
  let w = w0;
  /** The step the pass found the workflow at; written with the pass's other changes, or alone when only it changed. */
  let step: StepName | null = null;
  /** The step to record: an item back with its end recommendation is at "recommend"; one back with a question waits at its step. */
  const stepTo = (patch: WorkflowPatch): StepName | null => {
    const rec = patch.rec !== undefined ? patch.rec : w.rec;
    return (patch.state ?? w.state) === "recommending" && !rec?.question ? stepIn(w, "recommend", "merge") : step;
  };
  const write = (patch: WorkflowPatch, event?: "blocked"): ItemWorkflow["state"] | null => {
    const next = patch.state ?? w.state;
    const s = stepTo(patch);
    writes.workflows.push({ id: w.id, patch: { ...patch, ...(s !== null && s !== w0.step ? { step: s } : {}) }, at, was: { state: w0.state, updatedAt: w0.updatedAt } });
    if (event) writes.events.push({ workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: event, line: patch.rec?.text ?? null, at });
    return next !== w0.state ? next : null;
  };
  /** Ends the pass: writes what changed (the step included). */
  const settle = (patch: WorkflowPatch): ItemWorkflow["state"] | null => {
    const s = stepTo(patch);
    return Object.keys(patch).length || (s !== null && s !== w0.step) ? write(patch) : null;
  };
  const self = pass.items.get(key(w.repo, w.number));
  const base: WorkflowPatch = {};
  // A recommendation that stands for an implementation's question goes once the question is answered or set aside elsewhere (a
  // comment on the issue, an edited issue, a later round): the workflow runs on.
  const asks = askedBy(w.rec);
  if ((w.state === "blocked" || w.state === "recommending") && asks && !isOpenQuestion(attempt, asks)) {
    const on = { state: "running", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null } as const satisfies WorkflowPatch;
    Object.assign(base, on);
    w = { ...w, ...on };
  }
  /** The attempt's open question, as the issue's recommendation; a stuck attempt of an approved issue is a step that failed twice. */
  const comeBack = (patch: WorkflowPatch, head: string | null): { to: ItemWorkflow["state"] | null } | null => {
    const q = openQuestionOf(attempt);
    if (!attempt || !q) return null;
    const { plan, rec } = viewOf(attempt, q, patch.plan ?? w.plan, w.approvedBy !== null);
    const asked: WorkflowPatch = { ...patch, plan, rec, recAt: at, recHead: head };
    return { to: attempt.attempt.state === "stuck" && w.approvedBy !== null
      ? write({ ...asked, state: "blocked", blocker: "failed-twice", blockerParams: { step: "implement" } }, "blocked")
      : write({ ...asked, state: "recommending", blocker: null, blockerParams: null }) };
  };
  if (target === null) {
    // An issue with no PR yet: it ends when the issue closes, comes back with its implementation's question, and shows a ready plan's parts.
    if (self && self.state !== "OPEN") return write({ state: "closed", rec: null, blocker: null, blockerParams: null });
    step = stepIn(w, "implement");
    if (w.state === "blocked" || w.state === "recommending") return settle(base);
    if (!attempt) return settle(base);
    const asked = comeBack(base, null);
    if (asked) return asked.to;
    // A ready plan's parts; an answered question's options are no plan any more.
    const parts = implementParts(w.plan, (attempt.planned?.plan ?? null) as PlanReply | null) ?? (w.plan.some((p) => p.option !== undefined) ? [] : null);
    return settle({ ...base, ...(parts && !sameJson(parts, w.plan) ? { plan: parts } : {}) });
  }
  const ref = key(w.repo, target);
  const pr = pass.items.get(ref);
  if (!pr) return settle(base);
  if (pr.state === "MERGED") return write({ state: "done", rec: null, blocker: null, blockerParams: null });
  if (pr.state !== "OPEN") return write({ state: "closed", rec: null, blocker: null, blockerParams: null });
  // Waiting for a person: nothing moves until they answer.
  if (w.state === "blocked" || w.state === "recommending") return settle(base);
  const head = pr.head_oid;
  if (!head) return settle(base);
  const since = pass.goOn.get(w.id) ?? w.startedAt;
  const patch: WorkflowPatch = { ...base };

  // The head the workflow accepted moves along our own pushes; any other push is the author's.
  let authorPush: BlockerFacts["authorPush"] = null;
  const baseHead = w.kind === "pr" ? w.baseHead : null;
  if (!baseHead || w.kind !== "pr") {
    if (w.kind === "pr") patch.baseHead = head;
  } else if (baseHead !== head) {
    if (ownChain(pass, ref, baseHead, head)) patch.baseHead = head;
    else authorPush = { from: baseHead, to: head };
  }

  const impl = w.kind === "issue" ? implHead(pass, w, ref, head) : null;
  if (impl === "theirs") authorPush = { from: w.baseHead ?? (pass.legs.get(ref) ?? []).filter((l) => l.workflow_id === w.id).at(-1)?.head ?? "", to: head };

  // The numbered plan follows the latest review at the head; a merge-queue entry has no review.
  const review = w.entry === "merge" ? null : reviewAt(pass, ref, head);
  const plan: PlanPart[] = review ? planOf(review.fixes, w.plan) : w.plan;
  if (!sameJson(plan, w.plan)) patch.plan = plan;
  const view: ReviewView | null = review ? { verdict: review.verdict, sure: review.sure, rec: review.workflow?.recommendation ?? null } : null;

  // The step: the merge leg's state for the merge part, else where the review and its fixes are.
  const leg = (pass.legs.get(ref) ?? []).filter((l) => ACTIVE_LEG.includes(l.state)).at(-1)?.state ?? null;
  if (leg === "fixup") step = stepIn(w, "fix-up", "update from main");
  else if (leg === "review") step = stepIn(w, "review again", "update from main");
  else if (leg === "ci") step = stepIn(w, "fix CI and conflicts", "merge");
  else if (leg === "queued") step = stepIn(w, "batch", "merge");
  else if (w.entry === "merge") step = stepIn(w, "update from main");
  else if (!review) step = (pass.reviews.get(ref) ?? []).some((r) => r.head !== head) ? stepIn(w, "review again", "review") : stepIn(w, "review");
  else if (review.verdict === "take-fix" && plan.some((p) => p.state === "planned") && (w.entry !== "review" || w.approvedBy !== null)) step = stepIn(w, "fix-up", "merge", "recommend");
  else step = stepIn(w, "merge", "recommend");

  // A stuck revision of the implementation PR comes back before anything else the PR needs.
  const asked = w.kind === "issue" ? comeBack(patch, head) : null;
  if (asked) return asked.to;
  // An implementation's files beyond its plan are shown once: base_head of an implement issue is the implementation PR head the
  // workflow showed them at, and it follows our own pushes; a new attempt's PR, or someone else's push, is shown again.
  let beyond: string[] | null = null;
  if (w.kind === "issue") {
    const shown = w.baseHead !== null && (w.baseHead === head || ownChain(pass, ref, w.baseHead, head));
    if (shown) { if (w.baseHead !== head) patch.baseHead = head; }
    else beyond = implementationBeyond(pass, w, target);
  }
  const approved = w.approvedBy !== null;
  const fresh = review && review.at > since ? review : null;
  const fixed = latestFix(pass, w, ref, since);
  const f = pass.facts.get(ref);
  const conflict = f?.head === head && f.mergeable === "CONFLICTING" ? { fixedAfter: fixedAfterMerge(f) } : null;
  const blockerRec = (x: Found, parts: readonly PlanPart[]): Recommendation => onConflict(atBlocker(x, view, parts), conflict);
  const found = detectBlocker({
    entry: w.entry, approved, authorPush,
    review: fresh ? { verdict: fresh.verdict, sure: fresh.sure, majors: plan.filter((p) => p.major && p.state === "planned").map((p) => p.n), outsideLines: fresh.workflow?.outside_purpose?.lines ?? 0 } : null,
    failures: failures(pass, ref, since),
    fix: fixed.fix,
    plannedFiles: fixed.plannedFiles,
    ...(beyond?.length ? { implementationBeyond: beyond } : {}),
    leg: approved ? endedLeg(pass, w, since) : null,
    thresholds: pass.thresholds,
  });
  if (found) {
    // The merge leg stops before it can merge. One an integration batch holds goes through (cancelling it would undo the batch
    // under its running CI); a queued leg outside a batch is cancelled like any other.
    if (leg === "queued" && await inActiveBatch(db, w.repo, target)) return settle(patch);
    if (leg) {
      // A person who changed the workflow meanwhile decides about the leg (a start after a stop has a new one).
      const now = (await listWorkflows(db, { ids: [w0.id] }))[0];
      if (now?.state !== w0.state || now.updatedAt !== w0.updatedAt) return null;
      try {
        await cancelPreapproval(db, ACTOR, w.repo, target, undefined, "workflow");
      } catch {
        // A merge of the repo is running, or the leg changed a moment ago: the next pass looks again.
        return settle(patch);
      }
    }
    // A pre-merge review's findings become plan parts the recommendation fixes; nothing merges past them as they are.
    let blockPlan = plan;
    if (typeof found.params.reason === "string" && PREMERGE_STOP.test(found.params.reason)) {
      const extra = await premergeParts(db, w.repo, target, head, plan);
      blockPlan = [...plan, ...extra];
      found.params.premerge = extra.map((p) => p.n);
    }
    if ((found.blocker === "beyond-agreed" && beyond?.length) || impl === "theirs") patch.baseHead = head;
    return write({ ...patch, ...(blockPlan !== plan ? { plan: blockPlan } : {}), state: "blocked", blocker: found.blocker, blockerParams: found.params, rec: blockerRec(found, blockPlan), recAt: at, recHead: head }, "blocked");
  }

  if (!approved) {
    if (f && f.head === head && waitsForAnswer(f)) {
      let rec: Recommendation = afterSteps(view, plan, unapprovedStop(f), conflict);
      // The end recommendation also says which files the implementation changed beyond its plan; they count as shown.
      if (beyond?.length) {
        rec = { ...rec, text: t("{text} The implementation also changes {files}, which no part of its plan names.", { text: rec.text, files: listText(beyond.slice(0, 10)) }) };
        patch.baseHead = head;
      }
      return write({ ...patch, state: "recommending", rec, recAt: at, recHead: head });
    }
  } else if (impl !== "later") {
    const refused = await ensureLeg(db, pass, writes, w, w.repo, target, head);
    if (refused) {
      const stop: Found = { blocker: "other", params: { reason: refused } };
      return write({ ...patch, state: "blocked", blocker: stop.blocker, blockerParams: stop.params, rec: blockerRec(stop, plan), recAt: at, recHead: head }, "blocked");
    }
  }
  return settle(patch);
}

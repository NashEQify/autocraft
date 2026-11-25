// Moves each live maintainer workflow on from what the pipeline recorded: its numbered plan from the latest review, a blocker that
// stops an approved item, the one recommendation an unapproved item comes back with when its steps are done, the merge leg of an
// approved PR (the pre-approved merge in src/preapproval, owned through preapprovals.workflow_id, which merges as the approver), and
// the end once the PR merged or closed. An implementation's open question, and a stuck implementation, come back as the issue's
// recommendation (question.ts). The runner runs it on each tick its inputs changed, before the pre-approval pass.
//
// A person answers the recommendation with a command (apply.ts), and nothing here writes to GitHub. The
// pass loads every workflow's facts at once and writes what changed in one write at its end.
import { withConfig } from "../data/control/index.ts";
import { loadLatestFixPushes, loadPatchFacts, type PatchFacts } from "../data/changes/index.ts";
import { loadImplementFacts, type ImplementFacts } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadPremerge, loadReviewRows, type ReviewRow } from "../data/review/index.ts";
import { adoptLegs, listWorkflows, loadGoOnAt, loadLegs, loadRepins, recordEvents, saveWorkflows, type Preapproval, type WorkflowEvent, type WorkflowPatch } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { decidePr, MAINTAINER_ANSWER_WAIT } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import type { PrFacts } from "../core/plan.ts";
import type { PlanReply } from "../implement/types.ts";
import { cancelPreapproval, inActiveBatch, PreapprovalRefused, preapproveMerge } from "../preapproval/index.ts";
import { findingsOf } from "../premerge/store.ts";
import { t } from "../i18n/index.ts";
import { detectBlocker, PREMERGE_STOP, type BlockerFacts, type Found } from "./blockers.ts";
import { afterSteps, atBlocker, planOf, type ReviewView } from "./recommend.ts";
import { blockerThresholds } from "./settings.ts";
import { askedBy, isOpenQuestion, openQuestionOf, viewOf } from "./question.ts";
import { listText, stepsFor, type StepName } from "./status.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "./types.ts";

const ACTOR = "pipeline";
const ACTIVE_LEG = ["fixup", "review", "ci", "queued"];
const ENDED_LEG = ["asked", "cancelled", "failed"];
/** Fix-up and CI fix tries that failed (src/fixup, src/cifix). */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];

/** What changed in a pass, for the Discord alerts and the log. */
export type Moved = { id: number; repo: string; number: number; to: ItemWorkflow["state"] };

/** Lockfiles a fix-up may touch as a side effect of its change: never "beyond what was agreed". */
const LOCKFILE = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/;

type Target = { number: number };
/** What the pass loaded for every live workflow, keyed `repo#number` (of the item, or of its PR). */
type Pass = {
  items: Map<string, { state: string; head_oid: string | null }>;
  implement: ImplementFacts;
  goOn: Map<number, string>;
  legs: Map<string, Preapproval[]>;
  reviews: Map<string, ReviewRow[]>;
  patches: Map<string, PatchFacts>;
  fixes: Map<string, { fromHead: string; createdAt: string; lines: number; files: string[] }>;
  /** Autorepin pushes per PR, `from` head to `to` head. */
  repins: Map<string, { from: string; to: string }[]>;
  facts: Map<string, PrFacts>;
  thresholds: BlockerFacts["thresholds"];
};
/** The writes the pass collects, written once at its end. */
type Writes = { workflows: { id: number; patch: WorkflowPatch; at: string }[]; events: WorkflowEvent[]; adopt: { id: number; workflowId: number }[] };

const key = (repo: string, n: number): string => `${repo}#${n}`;

/** Whether our own pushes (fix-up, CI fix, base merge, implementation revision, autorepin) lead from `from` to `to`. */
function ownChain(pass: Pass, ref: string, from: string, to: string): boolean {
  const edges = [...(pass.patches.get(ref)?.pushes ?? []), ...(pass.repins.get(ref) ?? [])];
  let cur = from;
  for (let i = 0; i < 20 && cur !== to; i++) {
    const next = edges.find((e) => e.from === cur)?.to ?? null;
    if (!next || next === cur) return false;
    cur = next;
  }
  return cur === to;
}

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
      if (e instanceof PreapprovalRefused) return e.message;
      throw e;
    }
  } else if (active.workflow_id === null) writes.adopt.push({ id: active.id, workflowId: w.id });
  return null;
}

/** The PR a workflow works on: its own item, or an implement workflow's implementation PR; null while an issue has none. */
function prOf(pass: Pass, w: ItemWorkflow): Target | null {
  if (w.kind === "pr") return { number: w.number };
  const a = pass.implement.byIssue.get(key(w.repo, w.number));
  if (a?.attempt.prNumber != null) return { number: a.attempt.prNumber };
  // The attempt may have ended with its PR: the latest one of this workflow that opened a PR.
  const ended = a?.prAttempts.find((p) => p.createdAt >= w.startedAt);
  return ended ? { number: ended.prNumber } : null;
}

/**
 * One pass over the live workflows. Writes only what changed, in one write at the end; returns the workflows that moved to
 * another state.
 */
export async function advanceWorkflows(db: Db, log: (line: string) => void = () => {}): Promise<Moved[]> {
  return await withConfig(db, async () => {
    const live = await listWorkflows(db, { live: true });
    if (!live.length) return [];
    const issues = live.filter((w) => w.kind === "issue").map((w) => ({ repo: w.repo, number: w.number }));
    const [implement, goOn, thresholds] = await db.together(() => Promise.all([
      loadImplementFacts(db, issues, { withPlans: true }), loadGoOnAt(db, live), blockerThresholds(db),
    ]));
    const pre: Pick<Pass, "implement"> = { implement };
    const targets = new Map(live.map((w) => [w.id, prOf(pre as Pass, w)]));
    const prRefs = [...new Map(live.flatMap((w) => { const t = targets.get(w.id); return t ? [[key(w.repo, t.number), { repo: w.repo, number: t.number }] as const] : []; })).values()];
    const itemRefs = [...new Map([...live.map((w) => ({ repo: w.repo, number: w.number })), ...prRefs].map((r) => [key(r.repo, r.number), r])).values()];
    const [items, legs, reviews, patches, fixes, repins] = await db.together(() => Promise.all([
      loadItems(db, itemRefs, "pr"), loadLegs(db, prRefs), loadReviewRows(db, prRefs), loadPatchFacts(db, prRefs), loadLatestFixPushes(db, prRefs),
      loadRepins(db, prRefs, { states: ["pushed"] }),
    ]));
    const facts = new Map((prRefs.length ? await loadPrFacts(db, { refs: prRefs.map((r) => key(r.repo, r.number)) }) : []).map((f) => [key(f.repo, f.number), f]));
    const pass: Pass = {
      items, implement, goOn, legs, reviews, patches, fixes, facts, thresholds: { largeFix: thresholds.largeFixLines, outsideMin: thresholds.outsidePurposeMin },
      repins: new Map([...repins].map(([k, rows]) => [k, rows.flatMap((r) => (r.head && r.to_head ? [{ from: r.head, to: r.to_head }] : []))])),
    };
    const writes: Writes = { workflows: [], events: [], adopt: [] };
    const moved: Moved[] = [];
    for (const w of live) {
      try {
        const to = await advanceOne(db, pass, writes, w, targets.get(w.id) ?? null);
        if (to) moved.push({ id: w.id, repo: w.repo, number: w.number, to });
      } catch (e) {
        log(`workflow ${w.repo}#${w.number}: ${(e as Error).message}`);
      }
    }
    if (writes.workflows.length || writes.events.length || writes.adopt.length) {
      await db.write(async () => {
        await saveWorkflows(db, writes.workflows);
        await recordEvents(db, writes.events);
        await adoptLegs(db, writes.adopt);
      });
    }
    return moved;
  });
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
  const a = pass.implement.byIssue.get(key(w.repo, w.number));
  const opened = pass.implement.byPr.get(key(w.repo, pr));
  const parts = implementParts([], (opened?.planned?.plan ?? null) as PlanReply | null) ?? [];
  const plannedFiles = new Set(parts.flatMap((p) => p.files ?? []));
  const files = statFiles(a?.prAttempts.find((p) => p.id === opened?.attemptId)?.diffStat ?? null).filter((f) => !LOCKFILE.test(f));
  if (!plannedFiles.size || !files.length) return null;
  return files.filter((f) => !plannedFiles.has(f));
}

/** The first of `names` the workflow's steps have, else its first step. */
const stepIn = (w: ItemWorkflow, ...names: StepName[]): StepName => {
  const steps = stepsFor(w.entry, w.approvedBy !== null);
  return names.find((n) => steps.includes(n)) ?? steps[0]!;
};

async function advanceOne(db: Db, pass: Pass, writes: Writes, w0: ItemWorkflow, target: Target | null): Promise<ItemWorkflow["state"] | null> {
  const at = new Date().toISOString();
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
    writes.workflows.push({ id: w.id, patch: { ...patch, ...(s !== null && s !== w0.step ? { step: s } : {}) }, at });
    if (event) writes.events.push({ workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: event, line: patch.rec?.text ?? null, at });
    return next !== w0.state ? next : null;
  };
  /** Ends the pass: writes what changed (the step included). */
  const settle = (patch: WorkflowPatch): ItemWorkflow["state"] | null => {
    const s = stepTo(patch);
    return Object.keys(patch).length || (s !== null && s !== w0.step) ? write(patch) : null;
  };
  const self = pass.items.get(key(w.repo, w.number));
  const attempt = w.kind === "issue" ? pass.implement.byIssue.get(key(w.repo, w.number)) : undefined;
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
  if (!target) {
    // An issue with no PR yet: it ends when the issue closes, comes back with its implementation's question, and shows a ready plan's parts.
    if (self && self.state !== "OPEN") return write({ state: "closed", rec: null, blocker: null, blockerParams: null });
    step = stepIn(w, "implement");
    if (w.state === "blocked" || w.state === "recommending") return settle(base);
    const a = attempt;
    if (!a) return settle(base);
    const asked = comeBack(base, null);
    if (asked) return asked.to;
    // A ready plan's parts; an answered question's options are no plan any more.
    const parts = implementParts(w.plan, (a.planned?.plan ?? null) as PlanReply | null) ?? (w.plan.some((p) => p.option !== undefined) ? [] : null);
    return settle({ ...base, ...(parts && !sameJson(parts, w.plan) ? { plan: parts } : {}) });
  }
  const ref = key(w.repo, target.number);
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
    else beyond = implementationBeyond(pass, w, target.number);
  }
  const approved = w.approvedBy !== null;
  const fresh = review && review.at > since ? review : null;
  const fixed = latestFix(pass, w, ref, since);
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
    if (leg === "queued" && await inActiveBatch(db, w.repo, target.number)) return settle(patch);
    if (leg) {
      try {
        await cancelPreapproval(db, ACTOR, w.repo, target.number, undefined, "workflow");
      } catch {
        // A merge of the repo is running, or the leg changed a moment ago: the next pass looks again.
        return settle(patch);
      }
    }
    // A pre-merge review's findings become plan parts the recommendation fixes; nothing merges past them as they are.
    let blockPlan = plan;
    if (typeof found.params.reason === "string" && PREMERGE_STOP.test(found.params.reason)) {
      const extra = await premergeParts(db, w.repo, target.number, head, plan);
      blockPlan = [...plan, ...extra];
      found.params.premerge = extra.map((p) => p.n);
    }
    if (found.blocker === "beyond-agreed" && beyond?.length) patch.baseHead = head;
    return write({ ...patch, ...(blockPlan !== plan ? { plan: blockPlan } : {}), state: "blocked", blocker: found.blocker, blockerParams: found.params, rec: atBlocker(found, view, blockPlan), recAt: at, recHead: head }, "blocked");
  }

  const f = pass.facts.get(ref);
  if (!approved) {
    if (f && f.head === head && waitsForAnswer(f)) {
      let rec: Recommendation = afterSteps(view, plan);
      // The end recommendation also says which files the implementation changed beyond its plan; they count as shown.
      if (beyond?.length) {
        rec = { ...rec, text: t("{text} The implementation also changes {files}, which no part of its plan names.", { text: rec.text, files: listText(beyond.slice(0, 10)) }) };
        patch.baseHead = head;
      }
      return write({ ...patch, state: "recommending", rec, recAt: at, recHead: head });
    }
  } else {
    const refused = await ensureLeg(db, pass, writes, w, w.repo, target.number, head);
    if (refused) {
      const stop: Found = { blocker: "other", params: { reason: refused } };
      return write({ ...patch, state: "blocked", blocker: stop.blocker, blockerParams: stop.params, rec: atBlocker(stop, view, plan), recAt: at, recHead: head }, "blocked");
    }
  }
  return settle(patch);
}

import type { StepApproval } from "../data/control/types.ts";
import type { ActionState, EndedWorkflow, Preapproval, WorkflowAction } from "../data/workflow/types.ts";
import type { ItemWorkflow } from "../workflow/types.ts";
import { chainsOwn, type OwnPush } from "./evidence.ts";

export type WorkflowGate = {
  live: boolean;
  entry: "review" | "fix-up" | "implement" | "merge";
  state: string;
  startedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  blocker: string | null;
  baseHead: string | null;
  fixupAsked: boolean;
  /** Its merge leg on the PR while the leg is active; null before it starts and once it ended (cancelled, failed). */
  leg: { state: string; head: string | null } | null;
};

/**
 * What `mayMerge` and `mayPush` read of a live workflow row; null without a live one. `legs`: the PR's active merge legs, newest last.
 * An issue's workflow has no head of its own to accept (its base_head only says which implementation head its files were shown at),
 * so its implementation PR's base is the head its leg is at: the leg starts at a head of ours or one a person answered at, and
 * follows our own pushes only.
 */
export function workflowGate(w: ItemWorkflow | null | undefined, o: { fixupAsked?: boolean; legs?: readonly Pick<Preapproval, "workflow_id" | "state" | "head">[] } = {}): WorkflowGate | null {
  if (!w) return null;
  const leg = o.legs?.findLast((l) => l.workflow_id === w.id);
  return {
    live: true, entry: w.entry === "fixup" ? "fix-up" : w.entry, state: w.state, startedBy: w.startedBy, approvedBy: w.approvedBy, approvedAt: w.approvedAt,
    blocker: w.blocker, baseHead: w.kind === "issue" ? leg?.head ?? null : w.baseHead, fixupAsked: o.fixupAsked ?? false,
    leg: leg ? { state: leg.state, head: leg.head } : null,
  };
}

export type MayResult = { ok: true; as: "person" | "repo"; by: string } | { ok: false; why: string };

const person = (by: string): MayResult => ({ ok: true, as: "person", by });
const refuse = (why: string): MayResult => ({ ok: false, why });
const REPO_OFF = "An operator, or a maintainer of the repo, turns it on on the Repos page.";
const ENDS_WITH_RECOMMENDATION = "Nobody approved this yet; the workflow ends with a recommendation.";

/** Workflow ends by which a person took the item out of the pipeline: nothing merges it until someone starts it again. */
const ENDED_WHY: Partial<Record<EndedWorkflow, string>> = {
  stopped: "Someone stopped the work on this; it merges once someone starts it again.",
  backlog: "Someone sent this to the backlog; it merges once someone starts it again.",
  closed: "The work on this ended with a close; it merges once someone starts it again.",
  done: "The work on this ended with an answer that did not merge it; it merges once someone starts it again.",
};

export type MergeInputs = {
  repoApproval: StepApproval | null;
  workflow: WorkflowGate | null;
  /** Without a live workflow: how the latest one of the PR, or of the issue it implements, ended. */
  ended: EndedWorkflow | null;
  head: string;
  /** The open or merged PRs it duplicates, as "repo#number": without a live workflow it merges only once a person picks it. */
  duplicates?: readonly string[] | undefined;
  /** Every push we made to the PR (src/core/evidence.ts ownPushes). */
  pushes: readonly OwnPush[];
};

/** Whether the merge of the PR at `head` is approved, by a person or by the repo. A started PR merges only once handed over (`mayMerge`). */
export function mergeApproved(f: MergeInputs): MayResult {
  const w = f.workflow;
  if (w?.live) {
    if (w.blocker) return refuse(`The workflow asks again: ${w.blocker}`);
    if (w.baseHead === null || !chainsOwn(f.pushes, w.baseHead, f.head)) return refuse("The author pushed commits after the workflow started; the workflow asks again before merging.");
    if (w.approvedBy === null && w.entry !== "merge") return refuse(ENDS_WITH_RECOMMENDATION);
    return person(w.approvedBy ?? w.startedBy);
  }
  const ended = f.ended && ENDED_WHY[f.ended];
  if (ended) return refuse(ended);
  if (f.duplicates?.length) return refuse(`It duplicates ${f.duplicates.join(", ")}; it merges once a maintainer starts it.`);
  return f.repoApproval ? { ok: true, as: "repo", by: f.repoApproval.by } : refuse(REPO_OFF);
}

/**
 * Whether the PR may be merged at `head`. A live workflow's merge is made only through its leg, once the leg handed the PR over at
 * that head: while the leg works, before it starts, and after it ended until the workflow moves on, nothing merges.
 */
export function mayMerge(f: MergeInputs): MayResult {
  const r = mergeApproved(f);
  const w = f.workflow;
  if (!r.ok || !w?.live) return r;
  if (w.leg?.state === "queued" && w.leg.head === f.head) return r;
  return refuse(w.leg ? "The merge waits for the workflow's steps to hand it over." : "The workflow's merge is not under way; it merges once the workflow hands it over.");
}

export function mayPush(f: {
  kind: "fixup" | "cifix" | "conflict" | "implement-revision";
  repoApproval: StepApproval | null;
  workflow: WorkflowGate | null;
  operatorFix: boolean;
  by?: string;
}): MayResult {
  const w = f.workflow;
  if (f.operatorFix) {
    const by = f.by ?? w?.approvedBy ?? w?.startedBy;
    return by ? person(by) : refuse("The fix-up command does not name who asked for it.");
  }
  if (w?.live) {
    if (f.kind === "implement-revision") return w.entry === "implement" ? person(w.startedBy) : refuse("Only an implement workflow revises its own pull request.");
    if (f.kind === "fixup") {
      if (w.entry !== "review" || w.fixupAsked) return person(w.startedBy);
      return w.approvedBy !== null ? person(w.approvedBy) : refuse(ENDS_WITH_RECOMMENDATION);
    }
    return w.entry !== "review" || w.approvedBy !== null ? person(w.approvedBy ?? w.startedBy) : refuse(ENDS_WITH_RECOMMENDATION);
  }
  return f.repoApproval ? { ok: true, as: "repo", by: f.repoApproval.by } : refuse(REPO_OFF);
}

/** States of a person action that waits for its person's sign-in or access. */
export const ACTION_WAITS: readonly ActionState[] = ["waiting-token", "waiting-permission"];

/**
 * The PR's merge waits for its approver's sign-in or access: it was tried at `head` for this approval, so it stays put until the
 * row goes back to pending, the head or the approver changes, or the approval is given again.
 */
export function mergeWaits(actions: readonly WorkflowAction[] | undefined, wf: Pick<ItemWorkflow, "id" | "startedBy" | "approvedBy" | "approvedAt"> | undefined, head: string): boolean {
  if (!wf) return false;
  const by = (wf.approvedBy ?? wf.startedBy).toLowerCase();
  return (actions ?? []).some((a) => a.kind === "merge" && a.workflow_id === wf.id && a.head === head && ACTION_WAITS.includes(a.state)
    && a.by.toLowerCase() === by && (!wf.approvedAt || a.updated_at >= wf.approvedAt));
}

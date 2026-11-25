import type { StepApproval } from "../data/control/types.ts";
import type { ActionState, WorkflowAction } from "../data/workflow/types.ts";
import type { ItemWorkflow } from "../workflow/types.ts";

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
};

export type MayResult = { ok: true; as: "person" | "repo"; by: string } | { ok: false; why: string };

const person = (by: string): MayResult => ({ ok: true, as: "person", by });
const refuse = (why: string): MayResult => ({ ok: false, why });
const REPO_OFF = "An operator, or a maintainer of the repo, turns it on on the Repos page.";
const ENDS_WITH_RECOMMENDATION = "Nobody approved this yet; the workflow ends with a recommendation.";

export function mayMerge(f: { repoApproval: StepApproval | null; workflow: WorkflowGate | null; head: string; ownHeads: ReadonlySet<string> }): MayResult {
  const w = f.workflow;
  if (w?.live) {
    if (w.blocker) return refuse(`The workflow asks again: ${w.blocker}`);
    if (w.baseHead === null || (f.head !== w.baseHead && !f.ownHeads.has(f.head))) return refuse("The author pushed commits after the workflow started; the workflow asks again before merging.");
    if (w.approvedBy === null && w.entry !== "merge") return refuse(ENDS_WITH_RECOMMENDATION);
    return person(w.approvedBy ?? w.startedBy);
  }
  return f.repoApproval ? { ok: true, as: "repo", by: f.repoApproval.by } : refuse(REPO_OFF);
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

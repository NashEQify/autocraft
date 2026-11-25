import type { StepApproval } from "../data/control/types.ts";

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

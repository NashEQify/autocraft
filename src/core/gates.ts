// The gates on writes: the repo approvals each action needs and the global pipeline switch. Pure. The planner and the
// guard (guard.ts) both use it; decide() does not (it shows what would run, approved or not).
import { refusalWho, type Params, type RefusalCode } from "./codes.ts";
import { ownImplementation } from "./implementation.ts";
import type { ActionKind, ItemFacts, Permission, PrFacts } from "./plan.ts";
import { mayMerge, mayPush, mergeApproved, type MayResult, type MergeInputs } from "./may.ts";
import { tripStageOf } from "./push-outcome.ts";

/** Who asks for a write: the pipeline itself (the autopilot), or an operator (a job they requested, or a command they ran). */
export type By = "pipeline" | { operator: string };

/** An action as the gates and the guard see it: its kind, and the bucket where the kind has several (fix-up: fix | ask, ...). */
export type Want<K extends ActionKind = ActionKind> = { kind: K; bucket?: string; /** Fix-up: the plan action's source (`operator`: a person's fix-up request). */ source?: string };

/** The repo approvals a write can need. */
export type Approval = "merge" | "push" | "comment" | "ci" | "labels" | "fix-issue" | "main-fix" | "status";

const WHAT: Record<Approval, string> = { merge: "Merges", push: "Pushes", comment: "Comments", ci: "CI run approvals", labels: "Labels", "fix-issue": "Issue implementations", "main-fix": "Main CI fixes", status: "PR status comments" };

/** A repo's approvals and the global switch, as the repo-level guard loads them. */
export type RepoApprovals = Record<Approval, boolean> & { pipelineOn: boolean };

/** Why a write needing `need` is refused, or null. A write with no approval need (`need` null) is gated by the switch only. */
/** What a repo-level write needs: a repo approval, `security` for a security fix's writes (approved per finding, no repo approval), or null for none. */
export type RepoNeed = Approval | "security" | null;

export function gateRepo(a: RepoApprovals, need: RepoNeed, by: By, repo: string): string | null {
  if (by === "pipeline" && !a.pipelineOn) return "The pipeline is off";
  return need === null || need === "security" || a[need] ? null : `${WHAT[need]} in ${repo} are not approved`;
}

/** The approval an action's GitHub write needs, or null for an action that writes nothing there. */
export function approvalOf(f: { pushable?: boolean }, a: Want): Approval | null {
  switch (a.kind) {
    // Item actions, for work nobody commanded (commandedBy). Closing and commenting need the comment approval: a close comments first.
    case "label": return "labels";
    case "act": return "comment";
    case "implement": return "fix-issue";
    case "merge": return "merge";
    case "post-review": return "comment";
    case "approve-ci": return "ci";
    case "fixup":
    case "conflict":
      return a.bucket === "fix" || a.bucket === "merge" ? "push" : a.bucket === "ask" ? "comment" : null;
    case "cifix":
      if (a.bucket === "rerun") return "ci";
      // A closed branch gets the patch as a comment instead of a push.
      if (a.bucket === "ask") return "comment";
      return a.bucket === "work" || a.bucket === "collect" ? (f.pushable ? "push" : "comment") : null;
    // The collect step of a stored model patch: its push (bucket fixup or cifix), or the patch as a comment where the branch is closed to us.
    case "lint": return a.bucket === "cifix" && !f.pushable ? "comment" : "push";
    default: return null;
  }
}

/** The item's implement work is the end of an attempt whose PR merged or closed (decidePr, implementStep). */
const endsAttempt = (f: PrFacts | ItemFacts): boolean =>
  "ghState" in f ? f.ghState !== "OPEN" : f.implement.row?.state === "pr-opened" && !f.implement.row.prOpen;

/** Who the implementation (and with it its PR's revisions) runs for, or who commanded the close; null for other work. Their command is the approval, in any repo. */
function commandedBy(f: PrFacts | ItemFacts, a: Want): string | null {
  if (a.kind === "implement") return ("ghState" in f ? ownImplementation(f)?.queuedBy : f.implement.queuedBy) ?? null;
  return a.kind === "act" && !("ghState" in f) ? f.close?.by ?? null : null;
}

const refuse = (code: RefusalCode, text: string, params?: Params): Permission => ({ ok: false, why: { code, who: refusalWho(code), ...(params ? { params } : {}), text } });

/** Whether the write may be made, on whose say and as whom: a merge a person approved is made as them, every other write as the app. */
export function gatePermission(f: PrFacts | ItemFacts, a: Want, by: By): Permission {
  if (by === "pipeline" && !f.pipelineOn) return refuse("pipeline-off", "The pipeline is off");
  // An implement action of a live attempt whose PR merged or closed only ends the attempt and its workspace: no write, no breaker.
  if (a.kind === "implement" && endsAttempt(f)) return { ok: true, as: "app", by: null };
  // A stage that stopped itself on the item's repo (circuit breaker) writes nothing there until it is resumed, whoever asks.
  const stage = tripStageOf(a);
  const tripped = stage && f.tripped?.[stage];
  if (tripped) return refuse("breaker", `${stage[0]!.toUpperCase()}${stage.slice(1)} is paused: ${tripped}`, { stage, reason: tripped });
  const need = approvalOf(f as { pushable?: boolean }, a);
  if (!need) return { ok: true, as: "app", by: null };
  const commander = commandedBy(f, a);
  if (commander !== null) return { ok: true, as: "app", by: { kind: "person", login: commander } };
  if ("may" in f && (need === "merge" || need === "push")) {
    const may = need === "merge" ? mergeMay(f) : pushMay(f, a);
    if (!may.ok) return refuse(may.code, `${WHAT[need]} in ${f.repo} are not approved: ${may.why}`, { need, repo: f.repo });
    return { ok: true, as: need === "merge" && may.as === "person" ? `user:${may.by}` : "app", by: { kind: may.as, login: may.by } };
  }
  const r = f.repoFacts as Partial<Record<"commentApproved" | "ciApproved" | "labelsApproved" | "fixIssueApproved", boolean>>;
  // An item (no PR facts) has no merge and no push of its own.
  const ok = { merge: undefined, push: undefined, comment: r.commentApproved, ci: r.ciApproved, labels: r.labelsApproved, "fix-issue": r.fixIssueApproved, "main-fix": undefined, status: undefined }[need];
  return ok ? { ok: true, as: "app", by: null } : refuse("repo-approval", `${WHAT[need]} in ${f.repo} are not approved`, { need, repo: f.repo });
}

/** Why the write is refused, or null. */
export function gates(f: PrFacts | ItemFacts, a: Want, by: By): string | null {
  const p = gatePermission(f, a, by);
  return p.ok ? null : p.why.text;
}

const mergeInputs = (f: PrFacts): MergeInputs =>
  ({ repoApproval: f.may.repoMerge, workflow: f.may.workflow, ended: f.may.ended, duplicates: f.duplicates?.of.map((n) => `${f.repo}#${n}`), head: f.head ?? "", pushes: f.may.pushes });

/** Whether the PR may be merged at its head (src/core/may.ts). */
export const mergeMay = (f: PrFacts): MayResult => mayMerge(mergeInputs(f));

/** Whether the merge of the PR at its head is approved, handed over or not, on whose say (`mergeApproved`, src/core/may.ts). */
export const mergeApproval = (f: PrFacts): MayResult => mergeApproved(mergeInputs(f));

/** `mergeMay` as a yes or no. */
export const mayMergeNow = (f: PrFacts): boolean => mergeMay(f).ok;

/** `mergeApproval` as a yes or no. */
export const mergeAllowed = (f: PrFacts): boolean => mergeApproval(f).ok;

export type PushKind = "fixup" | "cifix" | "conflict";

/** The push kind `mayPush` judges for an action that pushes. */
function pushKind(a: Want): PushKind {
  if (a.kind === "cifix" || (a.kind === "lint" && a.bucket === "cifix")) return "cifix";
  if (a.kind === "conflict" || (a.kind === "lint" && a.bucket === "conflict")) return "conflict";
  return "fixup";
}

/** Whether a push of `kind` is approved (src/core/may.ts). `operatorFix`: a person's fix-up request. */
export const pushMayOf = (f: PrFacts, kind: PushKind, operatorFix: boolean): MayResult =>
  mayPush({ kind, repoApproval: f.may.repoPush, workflow: f.may.workflow, operatorFix, ...(operatorFix && f.may.fixupBy ? { by: f.may.fixupBy } : {}) });
const pushMay = (f: PrFacts, a: Want): MayResult => pushMayOf(f, pushKind(a), a.source === "operator");

/** Why a push of `kind` is not approved; null when it is. */
export function pushRefusal(f: PrFacts, kind: PushKind, operatorFix = false): string | null {
  const m = pushMayOf(f, kind, operatorFix);
  return m.ok ? null : m.why;
}

/** The push approval as a yes or no. */
export const pushAllowed = (f: PrFacts, kind: PushKind, operatorFix = false): boolean => pushRefusal(f, kind, operatorFix) === null;

/** Writes from the command line are an operator's. */
export const CLI_BY: By = { operator: "cli" };

/** The writer behind a job: the autopilot's own jobs are the pipeline's, every other requester is an operator. */
export const byOfJob = (requestedBy: string): By => (requestedBy === "pipeline" ? "pipeline" : { operator: requestedBy });

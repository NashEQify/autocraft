// The gates on writes: the repo approvals each action needs and the global pipeline switch. Pure. The planner and the
// guard (guard.ts) both use it; decide() does not (it shows what would run, approved or not).
import type { ActionKind, ItemFacts, PrFacts } from "./plan.ts";
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
    // Item actions. Closing and commenting need the comment approval: a person's close always comments first.
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

/** Why the write is refused, or null. */
export function gates(f: PrFacts | ItemFacts, a: Want, by: By): string | null {
  if (by === "pipeline" && !f.pipelineOn) return "The pipeline is off";
  // An implement action of a live attempt whose PR merged or closed only ends the attempt and its workspace: no write, no breaker.
  if (a.kind === "implement" && endsAttempt(f)) return null;
  // A stage that stopped itself on the item's repo (circuit breaker) writes nothing there until it is resumed, whoever asks.
  const stage = tripStageOf(a);
  const tripped = stage && f.tripped?.[stage];
  if (tripped) return `${stage[0]!.toUpperCase()}${stage.slice(1)} is paused: ${tripped}`;
  const need = approvalOf(f as { pushable?: boolean }, a);
  if (!need) return null;
  const may = "may" in f && f.may && (need === "merge" || need === "push") ? (need === "merge" ? mergeMay(f as PrFacts) : pushMay(f as PrFacts, a)) : null;
  if (may) return may.ok ? null : `${WHAT[need]} in ${f.repo} are not approved: ${may.why}`;
  const r = f.repoFacts as Partial<Record<"mergeApproved" | "pushApproved" | "commentApproved" | "ciApproved" | "labelsApproved" | "fixIssueApproved", boolean>>;
  const ok = { merge: r.mergeApproved, push: r.pushApproved, comment: r.commentApproved, ci: r.ciApproved, labels: r.labelsApproved, "fix-issue": r.fixIssueApproved, "main-fix": undefined, status: undefined }[need];
  return ok ? null : `${WHAT[need]} in ${f.repo} are not approved`;
}

const mergeInputs = (f: PrFacts): MergeInputs | null =>
  f.may ? { repoApproval: f.may.repoMerge, workflow: f.may.workflow, ended: f.may.ended, duplicates: f.duplicates?.of.map((n) => `${f.repo}#${n}`), head: f.head ?? "", pushes: f.may.pushes } : null;

/** Whether the PR may be merged at its head (src/core/may.ts); null on facts built without the approval inputs. */
export function mergeMay(f: PrFacts): MayResult | null {
  const m = mergeInputs(f);
  return m && mayMerge(m);
}

/** Whether the merge of the PR at its head is approved, handed over or not (`mergeApproved`, src/core/may.ts); the repo's merge approval on facts without its inputs. */
export function mergeAllowed(f: PrFacts): boolean {
  const m = mergeInputs(f);
  return m ? mergeApproved(m).ok : f.repoFacts.mergeApproved;
}

type PushKind = "fixup" | "cifix" | "conflict";

/** The push kind `mayPush` judges for an action that pushes. */
function pushKind(a: Want): PushKind {
  if (a.kind === "cifix" || (a.kind === "lint" && a.bucket === "cifix")) return "cifix";
  if (a.kind === "conflict" || (a.kind === "lint" && a.bucket === "conflict")) return "conflict";
  return "fixup";
}

/** Whether a push of `kind` is approved (src/core/may.ts); null on facts built without the approval inputs. `operatorFix`: a person's fix-up request. */
function pushMayOf(f: PrFacts, kind: PushKind, operatorFix: boolean): MayResult | null {
  if (!f.may) return null;
  return mayPush({ kind, repoApproval: f.may.repoPush, workflow: f.may.workflow, operatorFix, ...(operatorFix && f.may.fixupBy ? { by: f.may.fixupBy } : {}) });
}
const pushMay = (f: PrFacts, a: Want): MayResult | null => pushMayOf(f, pushKind(a), a.source === "operator");

/** Why a push of `kind` is not approved; null when it is. */
export function pushRefusal(f: PrFacts, kind: PushKind, operatorFix = false): string | null {
  const m = pushMayOf(f, kind, operatorFix);
  if (m) return m.ok ? null : m.why;
  return f.repoFacts.pushApproved ? null : "Pushing is not approved for the repo.";
}

/** The push approval as a yes or no: `mayPush` where the facts carry its inputs, else the repo's push approval. */
export const pushAllowed = (f: PrFacts, kind: PushKind, operatorFix = false): boolean => pushRefusal(f, kind, operatorFix) === null;

/** Writes from the command line are an operator's. */
export const CLI_BY: By = { operator: "cli" };

/** The writer behind a job: the autopilot's own jobs are the pipeline's, every other requester is an operator. */
export const byOfJob = (requestedBy: string): By => (requestedBy === "pipeline" ? "pipeline" : { operator: requestedBy });

// decidePr: the review-to-merge rules for one open PR, in one place. Pure: no database, no clock (facts carry `now`).
import {
  BATCHABLE, MAIN_RED_HELD, autoEligible, PREMERGE_DEFECT_REASON, PREMERGE_UNSURE_REASON, PREMERGE_FAILED_REASON, PREMERGE_MAX_TRIES, RETRY_AFTER_MS,
  RULE_LABELS, RULE_SIZES, RULE_TIERS, UNSURE_REASON, VERIFY_UNAVAILABLE, ciAllows, conflictNote, verifyAllows, verifyOk,
  FIXUP_MAX_ATTEMPTS, CIFIX_FINAL_STATES, CIFIX_MAX_PUSHES_PER_PR, CIFIX_MAX_TRIES, CIFIX_MAX_TRIES_PER_PR, STATE_REFUSAL, TRANSIENT_REFUSAL,
} from "./rules.ts";
import { UNCHECKED_REASON } from "./sensitive.ts";
import { inFlightNow, unassignActions } from "./assignment.ts";
import { permitted } from "./authority.ts";
import { waitCodeOf } from "./codes.ts";
import { mergeAllowed, pushAllowed } from "./gates.ts";
import { liveAttempt, ownImplementation } from "./implementation.ts";
import type { Action, MergePath, PassFacts, Plan, PlanState, PrFacts, QueueState, UnsentAsk, WaitKind, WorkflowFact } from "./plan.ts";

/** The start of a statement for a reason line: one line, at most 80 characters. */
const excerpt = (t: string): string => { const s = t.replace(/\s+/g, " ").trim(); return s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s; };

type PremergeState = "none" | "clean" | "fix" | "defect" | "unsure" | "failed" | "retry";
export type Entry = { state: QueueState; path: MergePath; reasons: string[]; note: string | null; conflictNote: string | null; premerge: PremergeState | null; premergeDefects: number; handed: boolean; noCi: boolean; refusedReason: string | null };

const verifyState = (f: PrFacts): QueueState | null => {
  const s = f.verification?.state;
  if (verifyOk(s) || s === VERIFY_UNAVAILABLE) return null;
  return s === "failed" ? "verify-failed" : s === "error" ? "verify-error" : "waiting-verify";
};

// ---- the maintainer workflow (src/workflow)

/** The PR's live maintainer workflow, or null. */
export const workflowOf = (f: Pick<PrFacts, "workflow">): WorkflowFact | null => f.workflow ?? null;
/**
 * An unstarted PR that the workflow takes up by itself: a small or medium bug fix on the merge rule's criteria.
 * Not once its workflow (an implementation PR's: its issue's) ended: stopped, sent to the backlog, closed or done with an answer that
 * runs nothing, it means hands off until someone starts it.
 */
export const onAutoPath = (f: PrFacts): boolean => !workflowOf(f) && !f.endedWorkflow && autoEligible(f);
/** A draft: no work and no merge until it is marked ready for review. */
export const isDraft = (f: Pick<PrFacts, "draft" | "gone">): boolean => f.draft && !f.gone;
/** The head has no review that stands, so one is due once nothing holds it: a person who started the PR chose it, and the auto path chose by label and flags; a merge entry is never reviewed. */
const reviewDue = (f: PrFacts): boolean => !f.draft && !!f.head && !mergeEntry(f) && !f.carriable && !(f.review && f.review.head === f.head && !f.review.staleActionable);
/** An auto-path PR whose diff keeps it outside the merge rule before a review read it: the review could merge nothing, so it is not made. Our own push that broke CI is repaired first. */
const ruledOut = (f: PrFacts): boolean => !!f.ruledOut?.length && !f.brokeByUs && onAutoPath(f) && reviewDue(f);
/** An open PR that nobody started and that is not on the auto path: it gets no model work. */
export const notStarted = (f: PrFacts): boolean => !workflowOf(f) && (!onAutoPath(f) || ruledOut(f));
/**
 * The merge entry: the PR goes to the merge queue with no Opus review; the pre-merge review, Verify, CI and GitHub's gates still apply. Once a
 * push of ours owes a review, the PR goes the way of a reviewed one.
 */
export const mergeEntry = (f: PrFacts): boolean => workflowOf(f)?.entry === "merge" && !f.reviewOwed;
/** A started PR not approved for merge stops when its steps are done, for a person's answer to the recommendation. */
export const NOT_APPROVED_REASON = "not approved for merge";
/** The review's own fix-up runs on the auto path, for the fix-up and implement entries and once merge is approved; a review-entry PR that is not approved waits for its recommendation instead. */
export const fixAllowed = (f: PrFacts): boolean => {
  const w = workflowOf(f);
  return w ? w.entry === "fixup" || w.entry === "implement" || w.approved : onAutoPath(f);
};

/**
 * Where the one fix-up round of a pre-merge review's defects is at the head: it can be made, it is under way, it is used up, or there is
 * none to make (no defect, a defect no fix-up may apply, a PR already handed over, a branch or approval that takes no push).
 */
export function premergeFix(f: PrFacts): "fix" | "running" | "used" | "none" {
  const row = f.premerge;
  // A PR already handed over gets no fix-up.
  return row?.hasFindings && row.defects > 0 && !f.handOver && row.defectsAllFixable && row.fixesSafe && !f.premergeFixUsed && pushAllowed(f, "fixup") && f.pushable ? "fix" : "none";
}

/** The queue entry of a PR that has a take or take-fix review at its head (or merged at the reviewed head), or of a merge-entry PR (no review needed). */
export function queueEntry(f: PrFacts, merged: boolean, open: boolean): Entry {
  const mx = mergeEntry(f);
  const r = mx ? null : f.review!;
  const noCi = f.ci === "none" && f.repoFacts.noCi;
  const reasons: string[] = [];
  if (r && r.verdict !== "take") reasons.push("review asks for fixes");
  if (r?.unsure) reasons.push(UNSURE_REASON);
  const w = workflowOf(f);
  if (w && !w.approved && !mx) reasons.push(NOT_APPROVED_REASON);
  // Merging a stacked PR lands it in the other PR's branch, not in the default branch: a person decides.
  if (open && f.stackedOn !== null) reasons.push(`targets the branch of open #${f.stackedOn}`);
  if (r?.mode === "skipped") reasons.push("the review was skipped");
  if (!RULE_SIZES.includes(f.size)) reasons.push(`size ${f.size}`);
  if (!f.label || !RULE_LABELS.includes(f.label)) reasons.push(f.label ? `label ${f.label}` : "no settled label");
  else if (f.labelUnsure) reasons.push("label settled by an unsure referee");
  if (!RULE_TIERS.includes(f.tier)) reasons.push(f.author ? "author not on the whitelist" : "author unknown");
  reasons.push(...(f.sensitive ?? []));
  for (const c of f.statementConflicts) reasons.push(`conflicts with ${c.where}: "${excerpt(c.text)}" (${c.reason})`);
  if (f.verification?.state === VERIFY_UNAVAILABLE) reasons.push(`not verified: ${f.verification.summary ?? "Verify cannot build this repo"}`);
  if (f.ci === "none" && f.repoFacts.noCi) reasons.push("the repo has no CI checks");
  if (open && (f.verification?.state === "failed" || f.verification?.state === "error")) reasons.push(`verification ${f.verification.state === "failed" ? "failed" : "errored"}: ${excerpt(f.verification.summary ?? f.verification.note ?? "no detail")}`);
  // A merge refused for a reason other than the state of CI or mergeable waits for nothing that changes by itself: a person is asked.
  if (open && refusalStuck(f)) reasons.push(`the merge was refused: ${excerpt(f.lastMerge!.reason!)}`);
  const stuckUnknown = open ? unknownStuck(f) : null;
  if (stuckUnknown) reasons.push(stuckUnknown);
  // The leg of a PR approved for merge handed it to the merge queue at this head (handOver names the approval). The approval says the change is wanted, so an unsure review does not undo it, not even one made after the hand-over.
  const handed = f.handOver;

  // The pre-merge review gates what the rule would merge, and every merge-entry PR; its blocking reasons count before the path is decided.
  let premerge: PremergeState | null = null;
  let defects = 0;
  if (open && (!reasons.length || mx)) {
    const row = f.premerge;
    defects = row?.defects ?? 0;
    if (!row) premerge = "none";
    else if (!row.hasFindings) premerge = row.tries >= PREMERGE_MAX_TRIES ? "failed" : "retry";
    else if (!row.defects) premerge = row.unsure ? "unsure" : "clean";
    else premerge = premergeFix(f) === "fix" ? "fix" : "defect";
    if (premerge === "defect") reasons.push(PREMERGE_DEFECT_REASON);
    else if (premerge === "unsure") reasons.push(PREMERGE_UNSURE_REASON);
    else if (premerge === "failed") reasons.push(PREMERGE_FAILED_REASON);
    // The pre-merge review caches the diff, so a diff still unchecked after it is a reason; before it the PR waits for it.
    else if (premerge === "clean" && f.sensitive === null) reasons.push(UNCHECKED_REASON);
  }
  const e: Entry = { state: "needs-decision", path: null, reasons, note: null, conflictNote: null, premerge, premergeDefects: defects, handed, noCi, refusedReason: null };

  if (open && f.gateFailureNote) e.note = f.gateFailureNote;
  // A maintainer's formal block comes before everything else.
  if (open && f.changesRequested) { e.state = "changes-requested"; e.note = f.changesRequested.why; return e; }

  e.state = stateOf(f, e, merged, open && f.heldBacklog);
  if (open && f.mergeable === "CONFLICTING" && f.conflict) e.conflictNote = conflictNote(f.conflict.bucket, f.conflict.base);
  // A rule-path PR without a clean pre-merge review keeps its own state: a batch must not land it.
  if (f.batch && BATCHABLE.includes(e.state) && (e.path !== "rule" || e.premerge === "clean")) e.state = f.batch;
  // A red main fails every PR's CI: ready PRs wait for it, except the PRs AutoCraft opened to fix it.
  else if (open && f.repoFacts.mainRed && MAIN_RED_HELD.includes(e.state) && !f.mainFix) e.state = "waiting-main-ci";
  return e;
}

function stateOf(f: PrFacts, e: Entry, merged: boolean, held: boolean): QueueState {
  if (merged) return "merged";
  if (held) return "held-backlog";
  const mx = mergeEntry(f);
  if (!mx && f.review!.verdict === "take-fix") return "needs-fix-up";
  // A started PR merges on its approval, as its approver once the merge is handed over: the rule merges only what nobody started.
  // A merge entry's blocking pre-merge review stops it.
  if (mx) e.path = e.handed ? "operator" : e.premerge === "defect" || e.premerge === "unsure" || e.premerge === "failed" ? null : "maintainer";
  else if (!e.reasons.length) e.path = workflowOf(f) && !e.handed ? "maintainer" : "rule";
  else if (e.handed) e.path = "operator";
  if (f.mergeable === "CONFLICTING") return "conflict";
  if (f.ci === "failure") return "ci-failed";
  if ((f.runs?.waiting ?? 0) > 0) return "ci-approval";
  // A maintainer sees the verification result before the item's blocker is shown.
  if (!e.path) { const v = verifyState(f); return v === "verify-failed" || v === "verify-error" ? "needs-decision" : v ?? "needs-decision"; }
  if (!ciAllows(e.path, f.ci, e.noCi) || f.mergeable !== "MERGEABLE") return "waiting-ci";
  const v = verifyState(f);
  if (v && !(e.path === "operator" && f.verifyOverride && (v === "verify-failed" || v === "verify-error"))) return v;
  if ((e.path === "rule" || e.path === "maintainer") && e.premerge) {
    if (e.premerge === "none" || e.premerge === "retry") return "waiting-premerge";
    if (e.premerge === "fix") {
      const n = e.premergeDefects;
      e.note = `pre-merge review: ${n} defect${n === 1 ? "" : "s"} to fix`;
      return "needs-fix-up";
    }
  }
  if (f.lastMerge?.outcome === "refused") {
    e.refusedReason = f.lastMerge.reason;
    return "refused";
  }
  return e.path === "operator" ? "decision-answered-merge" : "ready";
}

/**
 * True when the PR may be merged now (ready, approved, or retried after a refusal). Not while its implementation session
 * revises it: the merge (or a batch) waits for the revision's push and the review of the new head. Not on the maintainer
 * path, whose merge is handed to its approver first (it then takes the operator path). Not a PR the checks say is closed (`draft`).
 */
const eligible = (f: PrFacts, e: Entry): boolean =>
  !f.mergeHeld && !f.draft && ownImplementation(f)?.state !== "revising" && e.path !== null && e.path !== "maintainer" && verifyAllows(e.path, f.verification?.state, f.verifyOverride) && ciAllows(e.path, f.ci, e.noCi) && f.mergeable === "MERGEABLE"
  && (e.state === "ready" || e.state === "decision-answered-merge" || e.state === "refused");

/** A PR refused at its current head waits until its CI or mergeable state differs from what GitHub reported at the refusal. */
const refusedAsBefore = (f: PrFacts, e: Entry): boolean => {
  const m = f.lastMerge;
  if (e.state !== "refused" || m?.outcome !== "refused") return false;
  if (f.runsApprovedAfterMerge || transientRetry(f)) return false;
  return m.ci === null || m.mergeable === null || (m.ci === f.ci && m.mergeable === f.mergeable);
};

const rereadDue = (f: PrFacts, pass: PassFacts): boolean => pass.rereadPaceAt <= f.now && (f.diffPending?.lastRead == null || f.now - f.diffPending.lastRead >= RETRY_AFTER_MS);

const premergeRetryDue = (f: PrFacts): boolean => {
  const row = f.premerge;
  if (!row) return true;
  if (row.hasFindings) return false;
  return row.tries < PREMERGE_MAX_TRIES && f.now - Date.parse(row.at) >= RETRY_AFTER_MS;
};

const WAITS: Partial<Record<QueueState, string>> = {
  "waiting-ci": "CI or GitHub's mergeable state", "waiting-premerge": "the pre-merge review", "waiting-verify": "verification",
  "needs-decision": "a maintainer's answer", "ci-approval": "approval of CI runs", "waiting-main-ci": "a green main", "in-batch": "its batch",
  "batch-checking": "its batch", "batch-failed": "its batch", "verify-failed": "a person: verification failed", "verify-error": "a person: verification errored", "changes-requested": "the maintainer's review", refused: "a change in CI or mergeable state",
};

/** Queue states whose WAITS text waits on a person. */
const PERSON_WAITS: ReadonlySet<string> = new Set(["needs-decision", "ci-approval", "changes-requested", "verify-failed", "verify-error"]);


type Wait = { text: string; kind: WaitKind };
const person = (text: string): Wait => ({ text, kind: "person" });
const contributor = (text: string): Wait => ({ text, kind: "contributor" });
const system = (text: string): Wait => ({ text, kind: "system" });

/** The wait of started work while GitHub writes go out as the box account: nobody's started work counts then (data/access standing). */
export const BOX_IDENTITY_WAIT = "an operator to switch AutoCraft to its GitHub App: started work runs as the person who started it only through the app";

/** What an implementation waits on while the person it runs for does not count on the repo; null when they do. */
export function standingWait(im: Pick<NonNullable<PrFacts["implementation"]>, "queuedBy" | "standing" | "boxIdentity">, repo: string): Wait | null {
  if (im.standing === "yes") return null;
  if (im.standing === "no") return person(`a maintainer of ${repo} to answer, approve or start it again: ${im.queuedBy}, whom it runs for, does not settle there`);
  return im.boxIdentity ? person(BOX_IDENTITY_WAIT) : system(`GitHub's answer on ${im.queuedBy}'s access to ${repo}`);
}

/** The wait of an implementation (its issue, or its PR) whose next step needs the repo's Implement feature while it is off. A switch a maintainer flips: a system wait, live. */
export const implementOffWait = (repo: string): string => `Implement is off for ${repo}`;

/** Red CI at the PR's current head: at the reviewed head, our own push that broke it, or the review gate's red CI at a new head. */
const redAtHead = (f: PrFacts): boolean =>
  (!!f.review && f.review.head === f.head && f.ci === "failure") || !!f.brokeByUs || !!f.gateRed || (f.reviewHold?.kind === "ci" && f.reviewHold.red === true);

/**
 * What an implementation PR's head needs from its session: the review's fixes (a take-fix at the head), red CI, or both; null
 * when no revision is due. One revision per head: a head a revision started from waits for the revision's push, a new
 * review or a person.
 */
export function reviseOf(f: PrFacts): { review: boolean; ci: boolean } | null {
  const im = ownImplementation(f), r = f.review;
  if (!im || im.state !== "pr-opened" || f.ghState !== "OPEN" || !f.head || im.revisedHeads.includes(f.head)) return null;
  if (f.draft || !notHeld(f) || f.mergeHeld || f.changesRequested || f.mergeable === "CONFLICTING") return null;
  const atHead = !!r && r.head === f.head && !r.stale;
  // A hold or close review at the head is a person's to settle.
  if (atHead && (r.verdict === "hold" || r.verdict === "close")) return null;
  const review = atHead && r.verdict === "take-fix" && r.fixes > 0;
  const ci = redAtHead(f);
  return review || ci ? { review, ci } : null;
}

/** ask-retry: the ask comment never reached GitHub and is due again after a backoff (fixup.unsent). */
export type FixupBucket = "fix" | "unapproved" | "cannot-push" | "ask" | "ask-retry" | "asked" | "hold";
const notHeld = (f: PrFacts): boolean => f.inScope && !f.integration && !f.heldBacklog;

/** Where a take-fix review at the current head stands with the fix-up: the bucket and whether the step has recorded a final row for the head. */
export function fixupOf(f: PrFacts): { bucket: FixupBucket; done: boolean } | null {
  const r = f.review, x = f.fixup;
  if (!fixAllowed(f) || mergeEntry(f)) return null;
  if (ownImplementation(f) || !r || !x || r.verdict !== "take-fix" || r.head !== f.head || r.stale || f.draft || !notHeld(f) || f.ghState !== "OPEN" || f.mergeHeld) return null;
  // A maintainer's changes-requested review is the person's to resolve first.
  if (f.mergeable === "CONFLICTING" || x.fixes === 0 || f.changesRequested) return null;
  const has = (s: string) => x.recorded.includes(s);
  const commenting = f.repoFacts.commentApproved;
  // Heads held before the repo got comment approval are asked once it has it.
  const ask = (held: boolean): { bucket: FixupBucket; done: boolean } => (f.quiet ? { bucket: "cannot-push", done: true } : commenting ? { bucket: x.unsent ? "ask-retry" : "ask", done: false } : { bucket: "cannot-push", done: held });
  if (has("asked") && !f.pushable) return { bucket: "asked", done: true };
  if (has("comment-failed") || x.unsent === "final") return { bucket: "cannot-push", done: true };
  // A stored patch waits for its lint task: no new try, no ask.
  if (has("pushed") || has("push-denied") || has("linting")) return { bucket: "hold", done: true };
  if (has("cannot-push") && !f.pushable) return ask(true);
  // A fix-up we cannot make (too large, or the tries are used) goes to the contributor as the review's fix list, once per head.
  const askOnce = (held: boolean): { bucket: FixupBucket; done: boolean } => (has("asked") ? { bucket: "asked", done: true } : ask(held));
  if (has("too-large")) return askOnce(true);
  if (!f.pushable) return ask(false);
  if (x.attempts + 1 > FIXUP_MAX_ATTEMPTS) return commenting ? askOnce(false) : { bucket: "hold", done: false };
  return { bucket: pushAllowed(f, "fixup") ? "fix" : "unapproved", done: false };
}

/** The last refusal came from GitHub or the network and was tried once only: the merge is tried again. */
const transientRetry = (f: PrFacts): boolean => f.lastMerge?.outcome === "refused" && !!f.lastMerge.reason && TRANSIENT_REFUSAL.test(f.lastMerge.reason) && (f.lastMerge.refusals ?? 1) < 2;

/** The last merge try was refused for a reason that is not about CI, mergeable or the head, and nothing changed since: only a person can clear it. */
export function refusalStuck(f: PrFacts): boolean {
  const m = f.lastMerge;
  if (m?.outcome !== "refused" || !m.reason || STATE_REFUSAL.test(m.reason) || f.runsApprovedAfterMerge) return false;
  if (transientRetry(f)) return false;
  return m.ci === null || m.mergeable === null || (m.ci === f.ci && m.mergeable === f.mergeable);
}

/** GitHub still reports the mergeable state as unknown after every re-read: the reason a person is asked, or null. */
export function unknownStuck(f: PrFacts): string | null {
  const u = f.unknown;
  if (!u || f.mergeable === "MERGEABLE" || f.mergeable === "CONFLICTING" || !u.stuck) return null;
  return `GitHub still reports the merge state as unknown after being asked to compute it (unknown since ${u.since.slice(0, 16).replace("T", " ")})`;
}

/** The CI fix is done with nothing to fix while the queue reads CI as failing: the reason a person is asked, or null. */
export function ciFixIdle(f: PrFacts): string | null {
  const c = f.cifix;
  if (f.ci !== "failure" || f.mergeable === "CONFLICTING" || !c || !c.states.includes("skipped") || c.states.some((s) => s !== "skipped" && CIFIX_FINAL_STATES.includes(s)) || cifixBucket(f) !== "done") return null;
  return `CI fails, but the CI fix has nothing to fix${c.skipReason ? ` (${excerpt(c.skipReason)})` : ""}`;
}

/** comment-wait: the step's comment never reached GitHub and the step runs again after a backoff (cifix.unsent). */
export type CifixBucket = "unreviewed" | "comment-wait" | "work" | "unapproved" | "cannot-push" | "formatting" | "linting" | "collect" | "rerun" | "rerun-wait" | "failed" | "capped" | "done";

/** CI is red at the head, the review gate waits on it, and no take review covers the head. */
function unreviewedRed(f: PrFacts): boolean {
  const r = f.review;
  // A take review is repaired by the CI fix itself: at the head (normal path) or at an earlier head (our own breakage or the review gate's red CI).
  const take = mergeEntry(f) || (!!r && (r.verdict === "take" || r.verdict === "take-fix") && !(r.head === f.head && r.stale));
  // The checks are read at the current head when it is not the reviewed head (gateRed); otherwise the plan's CI state is.
  const red = f.gateRed === true || f.ci === "failure";
  return f.ghState === "OPEN" && red && f.reviewHold?.kind === "ci" && f.reviewHold.red === true && !take && !f.draft && notHeld(f)
    && f.mergeable !== "CONFLICTING" && !f.changesRequested && !f.mergeHeld && !f.brokeByUs;
}

/** Where the CI fix step stands for a PR whose CI fails at the reviewed head, or null when it is no candidate. */
export function cifixBucket(f: PrFacts): CifixBucket | null {
  const r = f.review, c = f.cifix;
  if (ownImplementation(f)) return null;
  // Our own push that turned the checks red is repaired against the pushed head, whose review is still the one of the head before.
  const broke = !!f.brokeByUs || !!f.gateRed;
  // The next review waits for green CI at a head no take review covers, and the CI fix needs a take review: the contributor is asked once.
  if (c && unreviewedRed(f)) {
    if (CIFIX_FINAL_STATES.some((s) => c.states.includes(s)) || c.unsent === "final") return "done";
    return f.repoFacts.commentApproved && !f.quiet ? (c.unsent ? "comment-wait" : "unreviewed") : "cannot-push";
  }
  // A merge-entry PR has no review to work from: its CI is fixed against its head. A review-entry PR not approved for merge gets no fix work.
  const mx = mergeEntry(f);
  if (!fixAllowed(f) || !c || f.ghState !== "OPEN" || (f.ci !== "failure" && !broke) || f.draft || !notHeld(f)) return null;
  if (!mx && (!r || (r.verdict !== "take" && r.verdict !== "take-fix") || (r.head !== f.head && !broke) || (r.stale && !broke))) return null;
  if (f.mergeable === "CONFLICTING" || f.changesRequested || f.mergeHeld) return null;
  if (!mx && r!.verdict === "take-fix") {
    const fx = fixupOf(f);
    if (fx && ["fix", "unapproved", "ask", "ask-retry"].includes(fx.bucket)) return null;
  }
  const has = (s: string) => c.states.includes(s);
  if (CIFIX_FINAL_STATES.some(has) || c.unsent === "final") return "done";
  if (c.unsent) return "comment-wait";
  if (has("linting")) return "linting";
  if (c.formattingTask !== null || has("formatting")) return c.formattingTask !== null && c.formatterEnded ? "collect" : "formatting";
  if (has("capped")) return "failed";
  if (c.totalPushes >= CIFIX_MAX_PUSHES_PER_PR || c.totalTries >= CIFIX_MAX_TRIES_PER_PR) return "capped";
  if (c.tries >= CIFIX_MAX_TRIES) return "failed";
  if (c.infraRuns && c.rerunAt === null) return "rerun";
  if (c.rerunAt !== null && !(c.checksAt && c.checksAt > c.rerunAt)) return "rerun-wait";
  if (!f.pushable && !f.repoFacts.commentApproved) return "cannot-push";
  if (f.pushable && !pushAllowed(f, "cifix")) return "unapproved";
  return "work";
}

/** The CI fix step's action bucket: what it does next, or null when it does nothing. */
function cifixOf(f: PrFacts): "work" | "collect" | "rerun" | "capped" | "ask" | "other" | null {
  const b = cifixBucket(f);
  if (b === null) return null;
  if (b === "unreviewed") return "ask";
  // A fix given up or capped at this head: the contributor is asked once.
  // Not for our own breakage, and not when the fix-up already asked at this head: one comment per head.
  if ((b === "failed" || b === "capped") && f.repoFacts.commentApproved && !f.brokeByUs && fixupOf(f)?.bucket !== "asked") return "ask";
  // No rerun at a head the contributor pushed that no review has read.
  if (b === "rerun") return f.repoFacts.ciApproved && !f.gateRed ? "rerun" : "other";
  return b === "work" || b === "collect" || b === "capped" ? b : "other";
}

/** A step's comment that never reached GitHub, due again at `until` (ms). */
const unsentWait = (what: string, until?: number): Wait => system(`${what} again ${until === undefined ? "later" : `after ${new Date(until).toISOString().slice(11, 16)}`}: the last one did not reach GitHub`);
const unsentUntil = (u: UnsentAsk | undefined): number | undefined => (u && u !== "final" ? u.until : undefined);

/** What stops a started PR whose fixes nobody approved: a conflict or red CI (not a red main's, except on the PR that fixes it). */
export const unapprovedStop = (f: PrFacts): "conflict" | "ci" | null =>
  !workflowOf(f) || fixAllowed(f) ? null : f.mergeable === "CONFLICTING" ? "conflict" : f.ci === "failure" && (!f.repoFacts.mainRed || f.mainFix) ? "ci" : null;

/**
 * Who settles a PR's conflict with its base branch once its merge is approved: the conflict step merges the base in (`tomorrow`: today's
 * merges are used up), and the fixes follow; or the contributor or another person has to resolve it, and nothing is fixed or merged before.
 */
export type ConflictPath = "merge" | "tomorrow" | "contributor" | "person";
/** The conflict path of a started PR; null when it does not conflict, or when nothing at its head says it is wanted (no take or take-fix review, and no merge entry). */
export function conflictPath(f: PrFacts | null): ConflictPath | null {
  if (f?.mergeable !== "CONFLICTING") return null;
  const r = f.review, c = f.conflict;
  if (!mergeEntry(f) && !(r && (r.verdict === "take" || r.verdict === "take-fix") && r.head === f.head && !r.stale)) return null;
  if (!c?.baseOk) return "person";
  switch (c.bucket) {
    // The approval of the merge is the approval of this push as well; `done`: pushed, and the mirror does not show it yet.
    case "merge": case "unapproved": case "done": return "merge";
    case "linting": return f.pushable ? "merge" : "person";
    case "capped": return "tomorrow";
    case "ask": case "ask-retry": case "asked": return "contributor";
    default: return "person";
  }
}
/** Nobody but the contributor or another person can settle the conflict. */
export const byHand = (p: ConflictPath | null): p is "contributor" | "person" => p === "contributor" || p === "person";

/** What a PR waits on when its conflict or CI fix is left to the contributor. */
const stuckWait = (f: PrFacts): Wait | null => {
  // A started PR nobody approved gets no fix work: what stops it is a maintainer's to settle.
  if (unapprovedStop(f)) return person(MAINTAINER_ANSWER_WAIT);
  const approval = person("comment approval for the repo");
  if (f.mergeable === "CONFLICTING" && f.conflict?.bucket === "capped") return system("conflict merge cap for today reached; next merge tomorrow");
  if (f.mergeable === "CONFLICTING" && f.conflict?.bucket === "ask-retry") return unsentWait("the comment asking the contributor to resolve the conflict", f.conflict.until);
  if (f.mergeable === "CONFLICTING" && f.conflict && ["ask", "asked", "held"].includes(f.conflict.bucket)) return f.conflict.bucket === "held" ? (f.repoFacts.commentApproved ? person("a person to resolve the conflict") : approval) : contributor("the contributor to resolve the conflict");
  if (f.mergeable === "CONFLICTING" && f.conflict?.bucket === "unapproved" && fixAllowed(f)) return person("push approval for the repo");
  if (f.mergeable === "CONFLICTING" && f.conflict) {
    if (f.inActiveBatch) return system(WAITS["in-batch"]!);
    // A base branch the conflict step may not merge.
    if (!f.conflict.baseOk) return person("a person to resolve the conflict");
    if (f.conflict.bucket === "linting") {
      if (f.lint.some((l) => l.step === "conflict" && !l.ended)) return system("the lint run of the conflict resolution");
      if (!f.pushable) return person("a person to resolve the conflict");
      if (!pushAllowed(f, "conflict")) return person("push approval for the repo");
    }
  }
  const cf = cifixBucket(f);
  if (cf === "unapproved") return person("push approval for the repo");
  // A finished formatter run or lint task whose patch may not be delivered.
  const undelivered = f.pushable ? (pushAllowed(f, "cifix") ? null : person("push approval for the repo")) : f.repoFacts.commentApproved ? null : approval;
  const linted = cf === "linting" && f.lint.some((l) => l.step === "cifix" && l.ended);
  if (undelivered && (cf === "collect" || linted)) return undelivered;
  if (cf === "formatting" || (cf === "linting" && !linted)) return system("the formatter or lint run of the CI fix");
  if (cf === "rerun-wait") return system("the rerun of the failed CI jobs");
  if (cf === "rerun" && !f.repoFacts.ciApproved) return person("CI approval for the repo");
  if (cf === "comment-wait") return unsentWait("the CI fix comment", unsentUntil(f.cifix?.unsent));
  if (cf === "done" && f.cifix?.states.includes("asked")) return contributor("the contributor to fix CI");
  if (cf === "done" && (f.cifix?.states.includes("comment-failed") || f.cifix?.unsent === "final")) return person("a person: the CI fix comment failed");
  if (cf === "done" && f.cifix?.states.includes("pushing")) return system("the push of the CI fix");
  if (cf === "done" && f.cifix?.states.some((s) => s === "push-denied" || s === "cannot-push")) return person("a person to fix CI: the CI fix could not push");
  if (cf === "failed" || cf === "capped") return f.brokeByUs ? person("a person to fix CI our push broke") : f.repoFacts.commentApproved ? contributor("the contributor to fix CI") : approval;
  return cf === "cannot-push" ? approval : null;
};

/** What a PR waits on when the review waits for red CI and the CI fix could not start: the contributor was asked, or a person decides. Null when the ask is still due. */
const unreviewedWait = (f: PrFacts): Wait | null => {
  if (!f.cifix || !unreviewedRed(f)) return null;
  const s = f.cifix.states;
  if (s.includes("asked")) return contributor("the contributor to fix CI");
  if (!f.repoFacts.commentApproved) return person("comment approval for the repo");
  if (s.includes("comment-failed") || f.cifix.unsent === "final") return person("a person: the comment to the contributor failed");
  if (f.cifix.unsent) return unsentWait("the comment asking the contributor to fix CI", f.cifix.unsent.until);
  if (s.includes("skipped")) return person(`a person: CI is red and the CI fix has nothing to fix${f.cifix.skipReason ? ` (${excerpt(f.cifix.skipReason)})` : ""}`);
  return CIFIX_FINAL_STATES.some((x) => s.includes(x)) ? person("a person to look at the red CI") : null;
};

/** Actions that work the PR towards merge (a push, a base merge, a review of a new head, a pre-merge review, the merge), as against comment-only asks. */
const worksOn = (a: Action): boolean => {
  const b = a.params?.bucket;
  switch (a.kind) {
    // A contributor's push during our work leaves a new head to review: the PR is still ours to carry on.
    case "review": case "carry": return true;
    case "fixup": return b === "fix";
    case "conflict": return b === "merge";
    case "cifix": return b === "work" || b === "collect" || b === "rerun";
    case "merge": case "premerge": case "lint": case "implement": return true;
    default: return false;
  }
};

/** Queue states on the path to merge: the PR stays assigned in them unless a stage gave it up. */
const PROGRESS_STATES: ReadonlySet<string> = new Set(["ready", "waiting-ci", "waiting-premerge", "waiting-verify", "ci-approval", "waiting-main-ci", "decision-answered-merge", "needs-fix-up", "ci-failed", "refused"]);

/** The unassign action of an open PR: kept while it is on the path to merge (in flight, in a batch, work due, a progress state), released in every other state and when a stage gave it up. */
function unassignOf(f: PrFacts, state: PlanState, actions: Action[]): Action[] {
  const fx = fixupOf(f), cf = cifixBucket(f);
  const inBatch = state === "in-batch" || state === "batch-checking" || f.inActiveBatch;
  const flying = inFlightNow(f, state);
  const waitingToReview = (f.reviewHold?.kind === "ci" && !f.reviewHold.red) || f.reviewHold?.kind === "interval";
  const working = actions.some(worksOn) || inBatch || flying;
  // A conflicting PR whose conflict step has nothing to do (asked, held, not approved, done) waits on its author, whatever the queue state says.
  const conflictStuck = f.mergeable === "CONFLICTING" && !!f.conflict && !["merge", "linting", "capped", "ask-retry"].includes(f.conflict.bucket);
  // A comment that did not reach GitHub is posted again by the pipeline after its backoff: the PR stays ours meanwhile.
  const retrying = (f.mergeable === "CONFLICTING" && f.conflict?.bucket === "ask-retry") || fx?.bucket === "ask-retry" || cf === "comment-wait";
  const gaveUp = state === "opus-close" || state === "verify-failed" || state === "verify-error" || state === "batch-failed" || conflictStuck
    || (!!fx && (fx.bucket === "cannot-push" || fx.bucket === "asked" || (fx.bucket === "hold" && !fx.done))) || cf === "failed" || cf === "capped" || cf === "cannot-push" || cf === "done"
    || f.mergeHeld || (state === "ci-approval" && !f.repoFacts.ciApproved) || ownImplementation(f)?.state === "stuck";
  const keep = working || retrying || (!gaveUp && (waitingToReview || PROGRESS_STATES.has(state)));
  return unassignActions(f.assignment, f.ghState === "OPEN", !keep);
}

/** Who a PR in needs-fix-up waits on. Null while a fix-up, conflict, CI-fix or lint action of the PR is due (the action is the next step). */
function fixupWait(f: PrFacts, fx: { bucket: FixupBucket; done: boolean } | null, actions: Action[]): Wait | null {
  if (actions.some((a) => ["fixup", "conflict", "cifix", "lint"].includes(a.kind))) return null;
  if (!fixAllowed(f)) return person(MAINTAINER_ANSWER_WAIT);
  if (f.mergeable === "CONFLICTING") return f.conflict?.bucket === "unapproved" ? person("push approval for the repo")
    : f.conflict?.bucket === "ask-retry" ? unsentWait("the comment asking the contributor to resolve the conflict", f.conflict.until)
    : contributor("the contributor's merge of the base branch");
  switch (fx?.bucket) {
    case "asked": return contributor("the contributor's fixes");
    case "ask-retry": return unsentWait("the comment asking the contributor for the fixes", unsentUntil(f.fixup?.unsent));
    case "cannot-push": return f.fixup?.recorded.includes("comment-failed") || f.fixup?.unsent === "final" ? person("a person: the ask comment failed") : f.repoFacts.commentApproved ? contributor("the contributor's fixes") : person("comment approval for the repo");
    case "hold": return fx.done ? system("the new review of our pushed fix-up") : person("comment approval for the repo");
    case "unapproved": return person("push approval for the repo");
    case "ask": case "fix": return null;
    // A review that asks for fixes and lists none the fix-up can make.
    default: return f.fixup?.fixes === 0 ? person(MAINTAINER_ANSWER_WAIT) : system("the review's fixes to be applied");
  }
}

/** What an unstarted PR waits on. */
export const NOT_STARTED_WAIT = "a maintainer to start it";
/** What an unstarted PR waits on, with the reason that alone keeps it off the auto path. */
function notStartedWait(f: PrFacts): string {
  if (ruledOut(f)) return `${f.ruledOut!.join(", ")}; waits for a maintainer`;
  if (!f.duplicates || !onAutoPath({ ...f, duplicates: undefined })) return NOT_STARTED_WAIT;
  return `duplicates ${f.duplicates.of.map((n) => `${f.repo}#${n}`).join(", ")}; waits for ${f.duplicates.compared ? "a maintainer" : "their comparison or a maintainer"}`;
}
/** What a started PR waits on when its steps stopped for a person (its recommendation, or a blocker). */
export const MAINTAINER_ANSWER_WAIT = "a maintainer's answer";

/** PassFacts of a decision that has none to give: no re-read pace holds the next diff re-read. */
export const NO_PASS: PassFacts = { rereadPaceAt: 0 };

export function decidePr(f: PrFacts, pass: PassFacts = NO_PASS): Plan {
  const plan = (state: PlanState, p: Partial<Plan> = {}): Plan => ({
    repo: f.repo, number: f.number, head: f.head, state, path: null, reasons: [], note: null, wait: null, waitKind: null, eligible: false, conflictNote: null, ...p,
    actions: permitted(f, p.actions ?? []), waitCode: p.wait == null ? null : waitCodeOf(p.wait),
  });
  const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });
  const r = f.review;
  const open = f.ghState === "OPEN";

  if (!f.inScope) return plan("out-of-scope", { actions: unassignActions(f.assignment, open, true) });
  // Our own integration PRs only carry reviewed PRs: their runs wait for approval like a member's.
  if (f.integration) {
    const approve = f.runs && !f.mergeHeld && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0));
    return plan("integration", { actions: approve ? [act("approve-ci", f.head)] : [] });
  }
  // The mirror shows a head we already pushed off: anything planned or asked here would be about a commit that is gone, and the PR is still ours, so the assignment stays.
  if (open && f.pushedOff) return plan("pushed", { wait: "the mirror to show our push", waitKind: "system" });
  const held = f.heldBacklog;

  // Actions that do not depend on the PR's place in the queue.
  const extra: Action[] = [];
  const im = ownImplementation(f);
  const attempt = liveAttempt(f);
  // The session's next step on the PR: the revision due at the head, a revision that has started (also when its issue was
  // closed or held, where the issue plans nothing), or, once the PR merged or closed, the end of the attempt (the revise
  // work records it and ends the workspace). While the repo's Implement feature is off, or nobody it runs for settles on the
  // repo, an open PR plans no revision and waits.
  const implDue = open && !!im && (im.state === "revising" || !!reviseOf(f));
  const implHeld = implDue ? (f.repoFacts.implementOn ? standingWait(im!, f.repo) : system(implementOffWait(f.repo))) : null;
  // Ending the attempt is bookkeeping (no GitHub write, no session): it runs whatever the switch says.
  const implementAct = implDue && !implHeld ? act("implement", f.head, { bucket: "revise", issue: im!.issue })
    : attempt && !open ? act("implement", null, { bucket: "revise", issue: attempt.issue }) : null;
  if (implementAct && !open) extra.push(implementAct);
  const pm = f.postmerge;
  if (pm && pm.mergedAt >= pm.since) {
    const retryAfter = new Date(f.now - RETRY_AFTER_MS).toISOString();
    const reviewed = pm.review && (pm.review.error === null || !pm.review.error.startsWith("retry:") || pm.review.at > retryAfter);
    if (!reviewed) extra.push(act("postmerge", pm.head));
  }
  // An operator's fix-up of this head (a resolution card's step, or the first part of a pre-approved merge); it needs no review verdict.
  const opFix = f.operator?.fix;
  if (opFix && f.ghState === "OPEN" && !f.heldBacklog && f.head && !f.draft && f.mergeable !== "CONFLICTING" && !f.lint.some((l) => l.source === "operator")
    && f.pushable && pushAllowed(f, "fixup", true) && opFix.attempts + 1 <= FIXUP_MAX_ATTEMPTS) extra.push(act("fixup", f.head, { bucket: "fix", source: "operator" }));

  // A PR nobody started and that is off the auto path gets no model work and no question.
  if (open && notStarted(f)) {
    return plan(held ? "backlog" : "not-started", { actions: unassignActions(f.assignment, open, true), wait: notStartedWait(f), waitKind: "person" });
  }
  const mx = mergeEntry(f);

  const mergedByUs = f.lastMerge?.outcome === "merged";
  const takeReview = !!r && (r.verdict === "take" || r.verdict === "take-fix");
  const merged = f.ghState === "MERGED" || mergedByUs;
  // A review older than a comment or review by someone else, or at another head, leaves the PR out of the queue until it is reviewed again.
  // A merge-entry PR is in the queue at its head without one. A draft is not in the queue.
  const ready = open && !isDraft(f);
  const inQueue = (takeReview && (merged || (ready && !r.stale && r.head === f.head))) || (mx && ready);
  // The head the queue's steps work on: the reviewed head, or a merge-entry PR's own head.
  const qHead = mx ? f.head : r?.head ?? null;

  const actions: Action[] = [...extra];
  let e: Entry | null = null;
  let state: PlanState;
  if (inQueue) {
    e = queueEntry(f, merged, !merged);
    state = e.state;
  } else if (held) state = "backlog";
  else if (f.draft) state = "draft";
  else if (r && r.head === f.head && !r.stale && r.verdict === "hold") state = "opus-hold";
  else if (r && r.head === f.head && !r.stale && r.verdict === "close") state = "opus-close";
  else state = r ? "review-stale" : "not-reviewed";

  if (!open && !inQueue) return plan("closed", { actions: extra });
  // A merged PR has only its post-merge review to do.
  if (merged) return plan(state, { ...(e ? { path: e.path, reasons: e.reasons, note: e.note, eligible: eligible(f, e) } : {}), actions: extra });

  // Review: no review at the head, or one made stale (a PR at its re-review cap waits).
  // A head whose earlier review carries over our checked fix-up is carried, not reviewed.
  // A due review waits while another item blocks the PR, CI at the head has not passed, or the day's review cap is used (src/review/gate.ts); a carry only waits for CI.
  let reviewWait: string | null = null;
  if (!held && !f.draft && !!f.head && !mx && f.carriable) {
    if (f.reviewHold?.kind === "ci") reviewWait = f.reviewHold.wait;
    else actions.push(act("carry", f.head));
  } else if (!held && reviewDue(f)) {
    if (f.reviewHold) reviewWait = f.reviewHold.wait;
    else actions.push(act("review", f.head));
  } else if (!held && !f.draft && !mx && r && r.head === f.head && r.stale && !r.staleActionable) {
    reviewWait = "review cap for today reached; next on a maintainer's request or tomorrow";
  }

  // Post the review.
  if (!held && !f.authorIsPipeline && !f.batchPr && r && f.post.postable && r.head === f.head) {
    const p = f.post.posted;
    if (!(p && p.head === f.head && r.at <= (p.opusAt ?? p.at ?? ""))) actions.push(act("post-review", f.head));
  }

  // Verify: a take at the head (or a merge entry, which has no review), CI not failing, not verified yet (a stale verification does not count).
  const verifiable = mx ? !!f.head : !!r && r.head === f.head && r.verdict === "take" && !r.stale;
  if (!held && !f.draft && verifiable && f.ci !== "failure" && (!f.verification || f.verification.state === "stale")) {
    actions.push(act("verify", f.head, { bucket: f.verifyUnavailable ? "unavailable" : "plan" }));
  }

  // Approve the CI runs GitHub holds for a fork PR's reviewed head (a merge entry's head).
  if (!held && qHead && (mx || (r && takeReview && r.head === f.head)) && f.checksHere && f.checksOpen && f.runs && !f.mergeHeld
    && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0))) actions.push(act("approve-ci", qHead));

  // Fix-up of a take-fix review's fixes, or of the pre-merge review's defect fixes.
  const fx = fixupOf(f);
  // The review's own fix-up waits while an operator's fix-up of the head is queued: two pushes would move the head under each other.
  if (f.operator?.fix) { /* the operator's fix-up above */ }
  else if (fx) {
    if (fx.bucket === "ask" || (!fx.done && (fx.bucket === "cannot-push" || fx.bucket === "fix"))) actions.push(act("fixup", f.head, { bucket: fx.bucket, source: "review" }));
  } else if (e && e.state === "needs-fix-up" && e.premerge === "fix" && f.mergeable !== "CONFLICTING" && !f.mergeHeld && !f.draft && !f.lint.some((l) => l.source === "premerge")) {
    actions.push(act("fixup", f.head, { bucket: "fix", source: "premerge" }));
  }

  // Merge the base branch into a conflicting PR, or ask the contributor.
  if (f.conflict && f.conflict.baseOk && f.mergeable === "CONFLICTING" && fixAllowed(f) && (mx || (r && takeReview && r.head === f.head && !r.stale)) && !f.draft && !held && !f.mergeHeld && !f.inActiveBatch) {
    if (f.conflict.bucket === "merge" || f.conflict.bucket === "ask") actions.push(act("conflict", f.head, { bucket: f.conflict.bucket }));
  }

  // An implementation PR goes back to its session for the review's fixes and red CI, after a conflict is merged away.
  if (implementAct && open) actions.push(implementAct);

  const cf = cifixOf(f);
  if (cf && cf !== "other") {
    // Repairing our own breakage comes before every other action of the PR.
    if ((f.brokeByUs || f.gateRed) && (cf === "work" || cf === "collect")) actions.unshift(act("cifix", f.head, { bucket: cf }));
    else actions.push(act("cifix", f.head, { bucket: cf }));
  }

  // The CI fix has nothing to fix while the queue reads CI as failing: Merge could not take effect, so a person answers the workflow's recommendation.
  const idleCi = e && e.state === "ci-failed" && !held ? ciFixIdle(f) : null;
  const holdState = (state === "opus-hold" && !!r && !held) || !!idleCi;

  // Stored model patches whose lint task ended: the collect step folds the format changes and pushes, or sends the findings back to the model.
  for (const l of f.lint) {
    // A conflict resolution is collected while the PR still conflicts; every other patch needs it not to.
    const conflicted = l.step === "conflict";
    const basic = l.ended && open && !f.draft && (conflicted ? f.mergeable === "CONFLICTING" && !!f.conflict?.baseOk && !f.inActiveBatch : f.mergeable !== "CONFLICTING") && !f.mergeHeld && !f.heldBacklog && !!f.head;
    // An operator's patch needs no review at the head; every other patch needs a take review there that is not stale.
    // A CI fix of our own breakage is reviewed against the head before the push.
    const reviewed = l.source === "operator" || (mx && notHeld(f)) || (l.step === "cifix" && (!!f.brokeByUs || !!f.gateRed) && !!r && takeReview && notHeld(f)) || (!!r && takeReview && r.head === f.head && !r.stale && notHeld(f));
    // A patch of the review's or the pre-merge review's own fixes, stored before a maintainer took the PR up for review only, is not pushed.
    const approved = f.pushable ? pushAllowed(f, l.step, l.source === "operator") && (l.source === "operator" || fixAllowed(f)) : l.step === "cifix" && f.repoFacts.commentApproved;
    // A CI fix patch whose comment did not reach GitHub is posted again once the backoff ends, and not after the last one.
    const unsentHeld = l.step === "cifix" && !!f.cifix?.unsent;
    if (basic && reviewed && approved && !unsentHeld) actions.push(act("lint", f.head, { bucket: l.step, source: l.source }));
  }

  if (e) {
    if (e.state === "waiting-premerge" && mergeAllowed(f) && premergeRetryDue(f)) actions.push(act("premerge", qHead));
    if (eligible(f, e) && !refusedAsBefore(f, e) && !f.mergeWaiting) {
      const singleOnly = f.verification?.state === VERIFY_UNAVAILABLE || f.verifyOverride || e.noCi || f.mainFix || f.baseOffDefault;
      actions.push(act("merge", qHead, { singleOnly, batchable: !singleOnly }));
    }
  }

  // A pre-approved merge before its hand-over: the PR is not merged or batched meanwhile (src/preapproval).
  // A merge entry's pre-merge review is part of its own path, before the hand-over.
  if (f.operator?.hold) for (let i = actions.length - 1; i >= 0; i--) if (["merge", ...(mx ? [] : ["premerge"])].includes(actions[i]!.kind)) actions.splice(i, 1);
  // Its pre-merge review is the one thing it still needs from the queue: the merge is handed over only after a clean one at the head.
  if (f.operator?.premerge && e && r && inQueue && mergeAllowed(f) && !f.draft && !f.mergeHeld && ciAllows("operator", f.ci, e.noCi) && f.mergeable === "MERGEABLE" && premergeRetryDue(f)) actions.push(act("premerge", r.head));

  // A diff that waits for what the merge rule reads beside it is read again by the pre-merge step, with no model call; after a read that left it waiting, an hour later.
  if (f.diffPending && r && f.ghState === "OPEN" && rereadDue(f, pass) && !actions.some((a) => a.kind === "premerge")) actions.push(act("premerge", r.head));

  actions.push(...unassignOf(f, state, actions));

  const main = actions.some((a) => ["review", "carry", "premerge", "merge", "verify", "implement"].includes(a.kind));
  const queueWait = (st: QueueState): Wait | null => {
    if (st === "waiting-ci" && f.mergeable !== "MERGEABLE" && f.mergeable !== "CONFLICTING" && f.unknown) {
      const stuck = unknownStuck(f);
      return stuck ? person(`${stuck}; closing and reopening the PR on GitHub makes it compute the state`)
        : system(`GitHub's merge state, unknown since ${f.unknown.since.slice(11, 16)} (unknown for ${f.unknown.reads} checks reads in a row)`);
    }
    if (st === "waiting-premerge" && !workflowOf(f) && !mergeAllowed(f)) return person("merge approval for the repo");
    if (f.mergeWaiting && e && eligible(f, e)) return person("the sign-in or access of the person who approved the merge");
    if (st === "refused" && refusalStuck(f)) return person(`a person: the merge was refused (${excerpt(f.lastMerge!.reason!)})`);
    // A started PR nobody approved gets no CI fix, and its red CI may be the default branch's: nobody is asked about it until that is green.
    if (st === "ci-failed" && workflowOf(f) && !fixAllowed(f)) return system(WAITS["waiting-main-ci"]!);
    if (st === "ready" && e?.path === "maintainer") return system("the approved merge to be handed over to its approver");
    return WAITS[st] ? { text: WAITS[st]!, kind: PERSON_WAITS.has(st) ? "person" : "system" } : null;
  };
  const draftWait: Wait | null = state === "draft" && isDraft(f) ? contributor("the pull request to be marked ready for review") : null;
  // A hold review waits for a maintainer's answer to the workflow's recommendation.
  const holdWait: Wait | null = holdState ? person(MAINTAINER_ANSWER_WAIT) : null;
  // An implementation PR whose session revises it, or whose revision is stuck: that is what it waits on, whatever the queue state.
  const implWait: Wait | null = implHeld ?? (im?.state === "revising" ? system(`the implementation session's revision for #${im.issue}`)
    : im?.state === "stuck" ? person(`a maintainer's answer on the stuck implementation of #${im.issue}`)
    : im && open && !!f.head && im.revisedHeads.includes(f.head) && redAtHead(f) ? person("a person: CI is red at the head and has nothing for the implementation session to fix")
    : im && im.state === "pr-opened" && open && !!f.head && im.revisedHeads.includes(f.head) && r?.head === f.head && !r.stale && r.verdict === "take-fix" ? person("a person: the implementation session ended without the review's fixes") : null);
  // A revision in progress is what the PR waits on, also while its continuation is planned.
  const wait: Wait | null = im?.state === "revising" && open ? implWait : main ? null : implWait ?? (e ? (f.mergeHeld && e.state !== "merged" ? person("merge held by an operator") : f.draft ? system("the mirror to show that it is closed") : stuckWait(f) ?? (e.state === "needs-fix-up" ? fixupWait(f, fx, actions) : queueWait(e.state))) : null);
  // A review hold names what the pre-approved merge itself waits for, so it comes before the generic pre-approval wait.
  const finalWait: Wait | null = wait ?? (main ? null : draftWait ?? holdWait ?? unreviewedWait(f)) ?? (!main && reviewWait ? (f.reviewHold?.person ? person(reviewWait) : system(reviewWait)) : null) ?? (f.operator?.hold && !main ? system("its pre-approved merge") : null);
  return plan(state, { ...(e ? { path: e.path, reasons: e.reasons, note: e.note, conflictNote: e.conflictNote, eligible: eligible(f, e) } : {}), actions, wait: finalWait?.text ?? null, waitKind: finalWait?.kind ?? null });
}

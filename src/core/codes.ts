// Why work waits, is refused or stopped, as codes: who can move it on and what the reader may do about it. The sentence a person reads
// stays beside the code, in `text`. No imports: the web build may use it.

export type Who = "person" | "contributor" | "system";

/** Why an action that is due may not run. */
export type RefusalCode =
  | "pipeline-off" | "scope" | "ended" | "duplicate" | "blocked" | "not-approved" | "unaccepted-head" | "not-handed-over"
  | "actor-gone" | "actor-unknown" | "box-identity" | "request-unnamed" | "repo-approval" | "breaker" | "hold" | "other";

/** What an item waits on when nothing of it is due. */
export type WaitCode = RefusalCode
  | "answer" | "not-started" | "ci" | "mergeable-unknown" | "mergeable-stuck" | "premerge" | "verification" | "verification-failed"
  | "ci-approval" | "ci-approval-failed" | "main-red" | "batch" | "batch-failed" | "changes-requested" | "merge-refused" | "refusal-retry"
  | "sign-in" | "hand-over" | "leg" | "base-off-default" | "no-ci" | "review-hold" | "review-failed" | "review-cap"
  | "fix-contributor" | "fix-running" | "fix-failed" | "conflict-contributor" | "conflict-person" | "conflict-cap"
  | "ci-contributor" | "ci-running" | "ci-fix-failed" | "ci-own-breakage" | "ci-nothing-to-fix" | "ask-unsent" | "ask-failed" | "lint"
  | "revision" | "revision-failed" | "implement-question" | "implement-stuck" | "implement-off" | "implement-ended" | "implement-room"
  | "open-pr" | "draft" | "mirror" | "triage" | "open-request" | "outside-hold";

/** Why a merge leg ended without a merge. */
export type StopCode =
  | "author-push" | "head-back" | "review-hold" | "review-close" | "review-failed" | "not-reviewable" | "verification-failed"
  | "premerge-defect" | "premerge-failed" | "merge-refused" | "fix-failed" | "fix-too-large" | "fix-cannot-run" | "ci-failed" | "no-ci"
  | "approval-gone" | "actor-gone" | "workflow-ended" | "pr-gone" | "pr-closed" | "pr-merged" | "person" | "blocked" | "other";

export type Params = Readonly<Record<string, string | number | null | readonly (string | number)[]>>;
export type Why<C extends string> = { code: C; who: Who; params?: Params; text: string };
export type Refusal = Why<RefusalCode>;
export type Stop = Why<StopCode>;

/** Who settles a refusal of this code. */
export const refusalWho = (code: RefusalCode): Who => (code === "not-handed-over" || code === "actor-unknown" || code === "scope" ? "system" : "person");

/** Person waits that ask nothing: a person set them on purpose, or their person acts on GitHub, on a switch or at the sign-in. */
const NO_QUESTION: ReadonlySet<WaitCode> = new Set(["hold", "repo-approval", "breaker", "box-identity", "changes-requested", "sign-in", "open-pr"]);

/** Whether a started item with this wait has to have a question open. */
export const needsQuestion = (code: WaitCode, who: Who): boolean => who === "person" && !NO_QUESTION.has(code);

// ---- codes of the texts ---------------------------------------------------------------------------------------------

/** The waits that are always the same text. */
const WAIT_TEXT: Readonly<Record<string, WaitCode>> = {
  "a maintainer's answer": "answer",
  "a maintainer to start it": "not-started",
  "the mirror to show our push": "mirror",
  "the mirror to show that it is closed": "mirror",
  "an operator to switch AutoCraft to its GitHub App: started work runs as the person who started it only through the app": "box-identity",
  "comment approval for the repo": "repo-approval",
  "push approval for the repo": "repo-approval",
  "CI approval for the repo": "repo-approval",
  "merge approval for the repo": "repo-approval",
  "label approval for the repo": "repo-approval",
  "a maintainer's answer to the question it stopped with": "blocked",
  "a maintainer to accept the author's new commits": "unaccepted-head",
  "a maintainer's approval of the work": "not-approved",
  "the workflow's steps before the merge": "not-handed-over",
  "a maintainer to start it again": "ended",
  "a maintainer to start it or the item it duplicates": "duplicate",
  "a maintainer to ask for the fix-up again": "request-unnamed",
  "a maintainer to resume it": "hold",
  "the pipeline to be on": "pipeline-off",
  "merge held by an operator": "hold",
  "CI or GitHub's mergeable state": "ci",
  "CI on the latest commit to finish": "ci",
  "CI on the latest commit to pass": "ci",
  "the pre-merge review": "premerge",
  "verification": "verification",
  "a person: verification failed": "verification-failed",
  "a person: verification errored": "verification-failed",
  "approval of CI runs": "ci-approval",
  "a green main": "main-red",
  "its batch": "batch",
  "the maintainer's review": "changes-requested",
  "a change in CI or mergeable state": "refusal-retry",
  "the sign-in or access of the person who approved the merge": "sign-in",
  "the approved merge to be handed over to its approver": "hand-over",
  "its pre-approved merge": "leg",
  "review cap for today reached; next on a maintainer's request or tomorrow": "review-cap",
  "the contributor's fixes": "fix-contributor",
  "the new review of our pushed fix-up": "fix-running",
  "the review's fixes to be applied": "fix-running",
  "the contributor to resolve the conflict": "conflict-contributor",
  "the contributor's merge of the base branch": "conflict-contributor",
  "a person to resolve the conflict": "conflict-person",
  "conflict merge cap for today reached; next merge tomorrow": "conflict-cap",
  "the lint run of the conflict resolution": "lint",
  "the contributor to fix CI": "ci-contributor",
  "the formatter or lint run of the CI fix": "ci-running",
  "the rerun of the failed CI jobs": "ci-running",
  "the push of the CI fix": "ci-running",
  "a person to fix CI: the CI fix could not push": "ci-fix-failed",
  "a person to look at the red CI": "ci-fix-failed",
  "a person to fix CI our push broke": "ci-own-breakage",
  "a person: the CI fix comment failed": "ask-failed",
  "a person: the comment to the contributor failed": "ask-failed",
  "a person: the ask comment failed": "ask-failed",
  "a person: its base is not the default branch, and AutoCraft merges only into that": "base-off-default",
  "a person: the repo has no CI, and AutoCraft merges only on green CI": "no-ci",
  "a person: CI is red at the head and has nothing for the implementation session to fix": "revision-failed",
  "a person: the implementation session ended without the review's fixes": "revision-failed",
  "the pull request to be marked ready for review": "draft",
  "the author's answer": "implement-question",
  "a maintainer's answer on the stuck implementation": "implement-stuck",
  "a person to queue the implementation again": "implement-ended",
  "not in scope": "scope",
  "a Backlog hold": "ended",
  "the label referee": "triage",
  "Haiku's second opinion": "triage",
  "stays open as a plugin candidate": "open-request",
  "an open request for a person to pick up": "open-request",
  "the outside-surge breaker, until an operator resumes it": "outside-hold",
};

/** The waits whose text names something: an item, a person, a time, a reason. The first that matches. */
const WAIT_FORM: readonly (readonly [RegExp, WaitCode])[] = [
  [/^duplicates .*; waits for (a maintainer|their comparison or a maintainer)$/s, "duplicate"],
  [/; waits for a maintainer$/, "not-started"],
  [/^a maintainer of \S+ to answer, approve or start it again: /, "actor-gone"],
  [/^GitHub's answer on .* access to \S+$/s, "actor-unknown"],
  [/^the circuit breaker of \S+ to be resumed$/, "breaker"],
  [/^Implement is off for /, "implement-off"],
  [/, which blocks its review$/, "review-hold"],
  [/^next review after \d\d:\d\d$/, "review-hold"],
  [/^its review failed \d+ times at this commit; /, "review-failed"],
  [/^the review after \d+ failed (try|tries) at this commit, from /, "review-failed"],
  [/^(the comment asking the contributor (to resolve the conflict|to fix CI|for the fixes)|the CI fix comment) again (later|after \d\d:\d\d): /, "ask-unsent"],
  [/^a person: CI is red and the CI fix has nothing to fix/, "ci-nothing-to-fix"],
  [/^GitHub's merge state, unknown since /, "mergeable-unknown"],
  [/^GitHub still reports the merge state as unknown /, "mergeable-stuck"],
  [/^a person: the merge was refused \(/, "merge-refused"],
  [/^the implementation session's revision for #\d+$/, "revision"],
  [/^a maintainer's answer on the stuck implementation of #\d+$/, "implement-stuck"],
  [/^\d+ implementations already running in /, "implement-room"],
  [/^open PR #\d+( mentions it)?$/, "open-pr"],
  [/^author's daily limit \(/, "outside-hold"],
];

/** The code of a plan's wait text (decide.ts, decide-item.ts, and the outside hold a stored row shows instead). */
export function waitCodeOf(text: string): WaitCode {
  return (Object.hasOwn(WAIT_TEXT, text) ? WAIT_TEXT[text] : undefined) ?? WAIT_FORM.find(([re]) => re.test(text))?.[1] ?? "other";
}

/**
 * The reasons a merge leg ends with, the first that matches. The codes that stand for a blocker of their own come first, in the blockers'
 * order: a reason that quotes another (a review's sentence, a refusal) keeps the blocker of what it quotes.
 */
const STOP_FORM: readonly (readonly [RegExp, StopCode])[] = [
  [/another push moved the head/, "author-push"],
  [/the head went back/, "head-back"],
  [/pre-merge review found/, "premerge-defect"],
  [/the review says hold/, "review-hold"],
  [/the review says close/, "review-close"],
  [/verification failed/, "verification-failed"],
  [/too-large/, "fix-too-large"],
  [/^the fix-up cannot run: |^the review of .* asks for fixes and its fix-up cannot run/, "fix-cannot-run"],
  [/^the fix-up /, "fix-failed"],
  [/ cannot be reviewed \(/, "not-reviewable"],
  [/^the review of .* waits on /, "review-failed"],
  [/^the pre-merge review of .* failed$/, "premerge-failed"],
  [/^the merge was refused: /, "merge-refused"],
  [/^CI failed at /, "ci-failed"],
  [/^the repo has no CI/, "no-ci"],
  [/^merging is no longer approved$/, "approval-gone"],
  [/ no longer may act on /, "actor-gone"],
  [/^its workflow ended$/, "workflow-ended"],
  [/^the PR is gone$/, "pr-gone"],
  [/^the PR was merged before /, "pr-merged"],
  [/^the PR was closed$/, "pr-closed"],
  [/^cancelled by pipeline$/, "blocked"],
  [/^cancelled by /, "person"],
];

/** The code of a merge leg's stored reason, for a row that has none. */
export const stopCodeOf = (reason: string): StopCode => STOP_FORM.find(([re]) => re.test(reason))?.[1] ?? "other";

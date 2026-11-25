// The vocabulary of a Plan: what state an item is in and which actions are due. No imports: the web build may use it.

/** A repo step approval (control StepApproval). */
export type MayApproval = { by: string; at: string };
/** A live workflow as src/core/may.ts reads it (its WorkflowGate). */
export type MayWorkflow = {
  live: boolean; entry: "review" | "fix-up" | "implement" | "merge"; state: string; startedBy: string; approvedBy: string | null; approvedAt: string | null;
  blocker: string | null; baseHead: string | null; fixupAsked: boolean;
};

/** Why an outside author's item waits for model work: over the author's daily budget, or created in a surge. */
export type OutsideHoldInfo = { reason: "limit" | "surge"; author: string; kind: "pr" | "issue"; /** The author's daily limit for the item's kind. */ limit: number };

/** Queue states of PRs that have a take or take-fix review at their current head (the merge queue's list). */
export const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "waiting-premerge", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "merged", "held-backlog",
  "batch-checking", "in-batch", "batch-failed", "ci-approval", "changes-requested", "waiting-main-ci",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** States of open PRs outside the merge queue. */
export const OTHER_PR_STATES = [
  "out-of-scope", // the repo's pipeline switch is off and nobody started the item, or its author is over a limit
  "integration", // an integration batch PR the pipeline opened itself
  "pushed", // our push moved the PR off the head the mirror still shows: nothing is planned until a sync shows the new head
  "backlog", // sent to the backlog (no take review at its head)
  "draft", // a draft, or closed on GitHub, with no take review
  "opus-hold", // the review at the head says hold
  "opus-close", // the review at the head says close
  "review-stale", // reviewed, but the head moved or the discussion moved on: due a new review
    "not-reviewed", // no review yet: due a review
  "not-started", // nobody started it, and it is not a small or medium bug fix the workflow runs by itself
  "closed", // closed or merged on GitHub, outside the merge queue (post-merge review only)
] as const;

export const PLAN_STATES = [...QUEUE_STATES, ...OTHER_PR_STATES] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export type ActionKind =
  | "review" | "carry" | "post-review" | "verify" | "approve-ci" | "premerge" | "merge"
  | "fixup" | "conflict" | "cifix" | "lint" | "postmerge"
  // item steps (issues and PRs)
  | "classify" | "referee" | "prioritize" | "embed" | "dupes" | "dupes-compare" | "label"
  | "act" | "implement"
  // the pipeline's account leaves an item that is off the path to merge (src/core/assignment.ts)
  | "unassign";

/** Who an item is assigned to as mirrored, and whether the last successful assign or unassign in the audit is our assignment of the pipeline account. `login`: the pipeline account (null when unknown: nothing is released). */
export type AssignFacts = { login: string | null; assignees: string[]; ours: boolean };

export type Action = { kind: ActionKind; head: string | null; params?: Record<string, unknown> };

/** Where a head's unsent ask comments leave the next ask (src/core/rules.ts unsentAsk); absent when it is due. */
export type UnsentAsk = { until: number } | "final";
export type LintFact = { step: "fixup" | "cifix" | "conflict"; source: "review" | "premerge" | "carry" | "operator"; ended: boolean };

/** Who a wait is on: a person at the repo (an operator or maintainer to approve or answer), the PR's contributor, or the system (CI, a sync, a model step, a timer). */
export type WaitKind = "person" | "contributor" | "system";

export type Plan = {
  repo: string; number: number; head: string | null;
  state: PlanState;
  /** How it may merge: by the rule, by an operator's answer, or (the maintainer workflow's merge entry) on the approval of the maintainer who queued it. */
  path: MergePath;
  /** Why it is outside the merge rule, in the queue's wording. */
  reasons: string[];
  note: string | null;
  /** Every action due now, in priority order. */
  actions: Action[];
  /** The conflict-handling note ("conflict: merging main"); apart from `note`, which is the queue's own. */
  conflictNote: string | null;
  /** What it waits on when no main-path action is due. */
  wait: string | null;
  /** Who `wait` is on; null exactly when `wait` is. */
  waitKind: WaitKind | null;
  /** The merge rule or an operator's answer lets it merge now (a refused PR still counts while its retry waits for a change). */
  eligible: boolean;
};

/** `maintainer`: the merge entry of the maintainer workflow; it runs no Opus review, and the merge itself is handed to the approver. */
export type MergePath = "rule" | "operator" | "maintainer" | null;

/** The live maintainer workflow of an item (src/workflow/types.ts ItemWorkflow), as the planner reads it. */
export type WorkflowFact = {
  entry: "review" | "fixup" | "implement" | "merge";
  /** Approved for merge, at the start or later. */
  approved: boolean;
  startedBy: string;
  startedAt: string;
  /** False on an implementation PR, which carries the workflow of its issue. */
  own: boolean;
};

/** The state of an item's latest workflow when none is live (src/workflow/types.ts WorkflowState). Stopped and backlog mean hands off: not even the auto path takes the item up again until someone starts it. */
export type EndedWorkflow = "done" | "stopped" | "closed" | "backlog";

export const isQueueState = (s: PlanState): s is QueueState => (QUEUE_STATES as readonly string[]).includes(s);

// ---- facts of a PR ----------------------------------------------------------------------------------------------
// The type lives here, not in facts.ts, so that decide.ts can use it without reaching node:*. facts.ts re-exports it.

export type PrTier = "whitelisted" | "not" | "allow" | "deny";

/** The latest Opus review of the PR (newest `at`, then rowid; any verdict). */
export type ReviewFacts = {
  head: string;
  at: string;
  verdict: string;
  /** Unsure at this head or anywhere in the chain of heads AutoCraft pushed it from: only a hand-over after this review lets it merge. */
  unsure: boolean;
  mode: string | null;
  reason: string;
  /** Number of fixes the review lists. */
  fixes: number;
  /** The discussion moved on after the review read it, or an operator marked it stale (no daily cap). */
  stale: boolean;
  /** `stale` as the Review step counts it: a PR at its daily cap of discussion-triggered re-reviews is not due again. */
  staleActionable: boolean;
};

export type PrFacts = {
  repo: string; number: number;
  /** Time of the decision, ms. */
  now: number;
  /**
   * The earliest time after `now` (ms) at which loading this PR's facts again could give other facts than these with `now` replaced:
   * a timed hold, backoff or cache lifetime the loaders read ends then. Absent: nothing the loaders read changes with the clock alone.
   */
  refreshAt?: number;
  /** The global pipeline switch. decide() ignores it; gates() applies it to the pipeline's own writes. */
  pipelineOn: boolean;
  /** The push stages that stopped themselves on this item's repo (circuit breaker), by stage name (fixup, cifix, implement, merge): the reason. gates() refuses their writes. */
  tripped?: Partial<Record<"fixup" | "cifix" | "implement" | "merge", string>>;
  /** A push of ours made the required checks at this head go red: CI fix works on it ahead of other work, even before a review of this head. */
  brokeByUs?: boolean;
  /** The head is new and its CI is red, and the PR has a take or take-fix review of an earlier head: CI fix works from that review and the contributor path is the normal one. */
  gateRed?: boolean;
  /** The head has no review, but the review of the earlier head carries to it (src/review/carry.ts): the Carry step stores it and no model reviews the head. */
  carriable?: boolean;
  /** Why a due review waits (src/review/gate.ts): an open blocker, CI at the head not finished or not passed, the PR's daily review cap, or the minimum time since its last review. */
  reviewHold?: { kind: "blocked" | "ci" | "cap" | "interval" | "failed"; wait: string; /** When a timed wait ends (ms). */ until?: number; /** A ci hold whose head's CI has failed. */ red?: boolean; person?: boolean };
  /** AutoCraft has its own work on this PR: one of its pushes (fix-up, CI fix, base merge) at or since the reviewed head, a stored lint patch, or the PR is our own fix PR. It ends when the PR is closed; selection also drops it while the plan waits on a person (see inFlightNow). */
  inFlight?: boolean;
  /** Our push moved this open PR off its mirrored head and no sync has run since (the mirror's updatedAt is not after the push). */
  pushedOff?: boolean;
  assignment: AssignFacts;
  /** GitHub state as mirrored. */
  ghState: "OPEN" | "MERGED" | "CLOSED";
  /** The PR's current head commit (checks fetched after the mirror's last update win over the mirror). */
  head: string | null;
  /** A draft, or not open on GitHub, as the freshest of mirror and checks says. */
  draft: boolean;
  author: string | null;
  authorIsPipeline: boolean;
  tier: PrTier;
  /** Closed PRs whose parts the pipeline carried onto this PR, with their authors' tiers. Carried code is held to its source authors' tiers, not the PR author's. */
  carriedFrom?: { number: number; author: string | null; tier: PrTier }[];
  lines: number;
  size: "S" | "M" | "L";
  /** Settled label of the current classification run. */
  label: string | null;
  needsDecisionFlag: boolean;
  /** The label was settled by a referee that was unsure (Opus, or Sonnet then Opus failing): the PR never takes the rule path. */
  labelUnsure?: boolean;
  // scope
  /** In scope: a maintainer started it, or its repo's Pipeline switch is on. */
  inScope: boolean;
  /** Held for model work because its author is outside the team and over a limit or in a surge (src/outside.ts); such an item is not in scope. */
  outsideHold?: OutsideHoldInfo;
  /** The item's live maintainer workflow; null when nobody started it. */
  workflow?: WorkflowFact | null;
  /** Without a live one, how the item's latest workflow ended; loaded like `workflow`. */
  endedWorkflow?: EndedWorkflow | null;
  /** An integration batch PR the pipeline opened itself. */
  integration: boolean;
  /** Any merge batch's own PR (without the author check). */
  batchPr: boolean;
  /** Its latest workflow sent it to the backlog. */
  heldBacklog: boolean;
  /** The quiet pull request of a security fix that is not yet public: nothing is posted about it on GitHub. */
  quiet?: boolean;
  /** An operator holds its merge. */
  mergeHeld: boolean;
  /** The score of its live workflow (weight, then age), else the rank score; null when unranked. Lanes order by it, highest first, then by number. */
  score: number | null;
  repoFacts: {
    mergeApproved: boolean; pushApproved: boolean; commentApproved: boolean; ciApproved: boolean;
    /** The repo has no CI at all. */
    noCi: boolean;
    /** The default branch's CI is red. */
    mainRed: boolean;
    /** Issue implementations are approved for the repo: the gate of an implementation PR's revisions. */
    fixIssueApproved?: boolean;
    /** The repo's `implement` build feature is on (src/build/features.ts): the switch of an implementation PR's revisions and of the end of its attempt. */
    implementOn: boolean;
  };

  review: ReviewFacts | null;
  /** Posting the review: whether there is public text (or an earlier post to edit), and our earlier post. */
  post: { postable: boolean; posted: { head: string | null; at: string | null; opusAt: string | null } | null };

  // checks at the reviewed head
  /** The checks were fetched for the reviewed head. */
  checksHere: boolean;
  /** At the reviewed head: the checks say open and not a draft. */
  checksOpen: boolean;
  /** CI at the reviewed head with optional checks applied; "pending" while approved runs have not finished; "unknown" when the checks are of another head. */
  ci: string;
  mergeable: string;
  /** The mergeable state has read as unknown since `since`, and was read again `rereads` times (src/merge/mergeable.ts); null when it is known. */
  unknown: { since: string; reads: number; rereads: number; stuck: boolean } | null;
  /** Workflow runs waiting for approval at the head the checks describe (for an integration PR: at the batch tip). */
  runs: {
    waiting: number; reread: boolean; crossRepo: boolean; approvable: number;
    /** Why the pipeline does not approve them: the repo's CI approval is off, approving failed twice, or they are not runs it approves (not a fork's pull_request); null when it will. */
    blocked: "off" | "failed" | "unsupported" | null;
  } | null;

  /** The latest merge attempt at the reviewed head. */
  lastMerge: { outcome: string; reason: string | null; ci: string | null; mergeable: string | null; /** Refused tries at this head. */ refusals?: number } | null;
  /** Runs were approved after that attempt. */
  runsApprovedAfterMerge: boolean;
  /** The merge was approved after the failed or errored verification of the head: that approval stands over it. */
  verifyOverride: boolean;
  verification: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  /** Why Verify cannot build the repo (private, not Rust without CI), or null. */
  verifyUnavailable: string | null;

  /** The approver's merge leg is in the merge queue at the reviewed head (a hand-over); `afterReview`: it got there after that review. */
  handOver: { afterReview: boolean } | null;
  /** The merge, made as the person who approved it, waits for their sign-in or access: the merge step leaves it out, so none is proposed. */
  mergeWaiting: boolean;

  /** The pre-merge review row at the reviewed head. */
  premerge: { at: string; tries: number; hasFindings: boolean; /** The review left a claim of the description unverified. */ unsure: boolean; defects: number; defectsAllFixable: boolean; /** Every defect's fix names a safe path, so a fix-up can apply them. */ fixesSafe: boolean; minor: number; error: string | null } | null;
  premergeFixUsed: boolean;
  /** Owner statements (owner_statements) that the Opus review or the pre-merge review at the reviewed head says the PR goes against; any makes the PR ask for a Merge? answer. */
  /** Reasons from the PR's diff that keep it off the merge rule (README, brand files, third-party links); read from the diff cache at the reviewed head, null when the diff is not cached. */
  sensitive: string[] | null;
  /**
   * The cached diff waits for what the merge rule reads beside it (whole files, workflow steps): `sensitive` holds the
   * conservative reasons, and the pre-merge step reads the diff again (no model call). `lastRead`: the last such re-read (ms).
   * The instance-wide re-read pace is not a fact of the PR: decidePr takes it from PassFacts.
   */
  diffPending?: { lastRead: number | null };
  statementConflicts: { id: number; where: string; text: string; reason: string }[];
  /** The PR's head branch may be pushed to (source of the maintainer flag follows `checksHere`). */
  pushable: boolean;
  /** Heads the PR was pushed from by AutoCraft, newest first, starting with the reviewed head. */
  pushChain: string[];
  /** For a conflicting open PR: what fix-up does and the base branch. */
  conflict: { bucket: string; base: string; /** The base branch name is one fix-up may merge. */ baseOk: boolean; /** When a capped bucket ends, or an ask-retry bucket's comment is due again (ms). */ until?: number } | null;
  /** Member of a merge batch that is checking or open, at any head. */
  inActiveBatch: boolean;
  /** Fix-up of a take-fix review at the current head: its usable fixes, the tries used and the final rows recorded at the head (fixups.state, no source). */
  fixup: { fixes: number; attempts: number; recorded: string[]; /** Ask comments at the head that never reached GitHub: the next one is due at `until` (ms), or the asks are final. */ unsent?: UnsentAsk } | null;
  /** Queued carry-over jobs of the duplicate groups (one per group decision) whose closed PRs left points to carry: tries used. */
  carry: { attempts: number; /** Its ask comment did not reach GitHub: the next is due at `until` (ms). */ unsent?: { until: number } }[];
  /**
   * An operator's fix-up (src/preapproval): `fix` is the queued one for the current head with the tries the PR's operator fix-ups used;
   * `hold` is true while a pre-approved merge waits for its fix-up, review or CI (or an operator fix-up request is still worked), so nothing merges meanwhile.
   * `premerge` is true when the PR's pre-approved merge waits for the pre-merge review of this head.
   */
  operator?: { fix: { attempts: number } | null; hold: boolean; premerge: boolean };
  /** Stored model patches at the reviewed head whose lint task is queued, oldest first: `ended` once the task has a final state. A CI fix's source is `review`. */
  lint: LintFact[];
  /** CI fix state at the reviewed head, loaded while CI fails. */
  cifix: {
    /** ci_fixes states at the head, oldest first. */
    states: string[]; tries: number; rerunAt: string | null; infraRuns: number[] | null;
    formattingTask: number | null; formatterEnded: boolean;
    totalPushes: number; totalTries: number;
    /** The reason of the head's skipped CI fix (nothing to fix), or null. */
    skipReason: string | null;
    /** When the checks were fetched (ISO). */
    checksAt: string | null;
    /** Comments at the head that never reached GitHub, as on `fixup`. */
    unsent?: UnsentAsk;
  } | null;
  /** The pipeline merged the PR: when, and what the stored post-merge review looks like. */
  postmerge: { mergedAt: string; head: string | null; since: string; review: { at: string; error: string | null } | null } | null;
  /** The batch the reviewed head is in. */
  batch: "batch-checking" | "in-batch" | "batch-failed" | null;
  /** The PR is one AutoCraft opened to fix main CI. */
  mainFix: boolean;
  /**
   * The implementation (src/implement) whose PR this is: the latest attempt that opened it, with its issue, its state and the
   * heads its revisions started from. Absent or null for every other PR. A live one takes the PR's review fixes and red CI
   * itself (implement{revise}) instead of the fix-up and the CI fix.
   */
  implementation?: { issue: number; state: string; revisedHeads: string[] } | null;
  /** The PR's base is not its repository's default branch: it merges singly (into the base its review read), never in an integration batch. */
  baseOffDefault: boolean;
  /** The open PR of this repository whose head branch is this PR's base (a stacked PR); null when none. */
  stackedOn: number | null;
  /** A maintainer's formal block: why, and whether from a live read. */
  changesRequested: { why: string; live: boolean } | null;
  /** The note when live review reads failed several times in a row. */
  gateFailureNote: string | null;
  /**
   * What the merge and push approval checks (src/core/may.ts) read: the repo's merge and push approvals, the live workflow's
   * approval inputs, and the heads of the push chain that are our own commits. Absent on facts built by hand: the repo approvals
   * in `repoFacts` stand alone.
   */
  may?: { repoMerge: MayApproval | null; repoPush: MayApproval | null; workflow: MayWorkflow | null; ownHeads: string[]; /** Who asked for the queued fix-up of the current head. */ fixupBy: string | null };
  /** For a PR outside the pipeline's scope (no other review facts are loaded): what its stored rows say, enough for the Work page to name the step it waits on. */
  outside?: { review: string | null; verify: string | null; ci: string | null };
};

/** Inputs of a decision that belong to the instance, not to one PR: read once per planner pass and given to every decidePr call of it. */
export type PassFacts = {
  /** The earliest time the instance's diff re-read pace and the rate-limit pause allow the next re-read (ms). */
  rereadPaceAt: number;
};

// ---- facts and plans of an item's triage steps (issues and PRs) -----------------------------------------------------

/** Where an open item stands in the triage steps (classify, referee), in the order Work's next-step text checks them. */
export const ITEM_STATES = [
  "held-backlog", // sent to the backlog
  "referee-due", // Jev and Haiku disagree, and the referee (Sonnet, then Opus when Sonnet was unsure) has not settled it
  "unclassified", // no Jev or Haiku verdict in the run
  "waiting-haiku", // Jev is unsure and Haiku has not given its second opinion
  "classified", // settled, nothing in the triage steps blocks it; later steps depend on its kind
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export type ItemFacts = {
  repo: string; number: number;
  kind: "pr" | "issue";
  /** Open on GitHub as mirrored; the loader reads open items only. */
  open: boolean;
  /** Time of the decision, ms. */
  now: number;
  /** As on PrFacts. */
  refreshAt?: number;
  /** Open item as the mirror says (the freshest-checks rule of PrFacts is for the PR path only). */
  draft: boolean;
  /** In scope: a maintainer started it, or its repo's Pipeline switch is on. */
  inScope: boolean;
  /** Held for model work because its author is outside the team and over a limit or in a surge (src/outside.ts); such an item is not in scope. */
  outsideHold?: OutsideHoldInfo;
  /** An integration batch PR the pipeline opened itself. */
  integration: boolean;
  /** Its latest workflow sent it to the backlog. */
  held: "backlog" | null;
  score: number | null;
  /** The global pipeline switch. decideItem ignores it; gates() applies it to the pipeline's own writes. */
  pipelineOn: boolean;
  /** As on PrFacts. */
  tripped?: Partial<Record<"fixup" | "cifix" | "implement" | "merge", string>>;
  /** A live implementation of the issue (src/implement/types.ts LIVE_STATES), or the item is our own fix PR. */
  inFlight?: boolean;
  assignment: AssignFacts;
  /** The repo's approvals for the writes below (decideItem does not apply them: gates() does). */
  repoFacts: { labelsApproved: boolean; commentApproved: boolean; fixIssueApproved: boolean };
  /** As on PrFacts. */
  workflow?: WorkflowFact | null;
  /** As on PrFacts; a workflow ended `closed` lets its person's close through outside the scope. */
  endedWorkflow?: EndedWorkflow | null;

  /** The classification run every step reads (the current run, else the newest verdict run). */
  run: string | null;
  classification: {
    /** The settled rule with the referee's answer applied. */
    status: "settled" | "waiting" | "disagree" | "unclassified";
    label: string | null;
    flags: string[];
    jevLabel: string | null; haikuLabel: string | null;
    referee: { sure: boolean; final: boolean; failedAt?: string | null } | null;
    /** Jev's verdict in the run: its time, whether the item's classifier input changed since, and whether Jev is unsure of the type or a flag. */
    jev: { at: string; changed: boolean; unsure: boolean } | null;
    /** Haiku's verdict in the run; `aloneCurrent`: it classified the item alone at its current input (that settles it without Jev). */
    haiku: { at: string; aloneCurrent: boolean } | null;
    /** A classify.jev request gave no valid verdict for the item's current input while Jev was up. */
    jevFailed?: boolean;
  };

  /** Hash of the item's embedded text (stored by sync, else computed). */
  embedHash: string;
  /** Hash of the stored vector of the current embedding model, null when there is none. */
  embeddedHash: string | null;
  /** Hash the priority row was made at. */
  priorityHash: string | null;
  /** Hash of the text at the item's last duplicate scan. */
  scannedHash: string | null;
  /** Unchecked duplicate pairs the item is in (pair rule: open on one side, text current, one side in scope). */
  pairsToCheck: number;
  /** Member of a duplicate kind-set that needs a comparison: "model" when one of its sets needs a model call, "rule" when each is settled by rule (ruleOutcome), false when none. */
  inCompareSet: false | "rule" | "model";
  labels: {
    /** The item is the quiet pull request of a security fix that is still landing: it gets no `security` label. */
    quietFix?: boolean;
    /** Labels on GitHub as mirrored. */
    existing: string[];
    /** The note of the item's latest "labeled" stage row ("added: a, b"). */
    labeledNote: string | null;
  };

  /** A person's close of the item that the Act step carries out now (a `workflow_actions` row in `pending`), as that person. */
  close: { id: number; by: string; weight: number; at: string } | null;

  /** The open PR that holds an issue: one that closes or addresses it (`closes`), else a person's PR that mentions it by number; null when there is none. */
  openPr: { number: number; closes: boolean } | null;

  /** The Implement stage's view of an issue (a PR's has queuedBy null and row null). */
  implement: {
    /** Who queued the issue for implementation: who started its live implement workflow; null when it has none. */
    queuedBy: string | null;
    /** Whether queuedBy still counts on the repo (data/access standing); "unknown" while GitHub has not answered on their write access. */
    standing: "yes" | "no" | "unknown";
    /** The repo's `implement` build feature is on (src/build/features.ts). */
    featureOn: boolean;
    /** The issue's current attempt, else its newest ended one; null when it has none. */
    row: {
      /** An implementations state (src/implement/types.ts). */
      state: string;
      attempt: number;
      /** The issue's title or body changed since the attempt last planned. */
      textChanged: boolean;
      /** An `asked` attempt: a comment by a person (no bot, not ours) came after its newest question. */
      newCommentAfterQuestion: boolean;
      /** An answer round follows the newest question of an `asked` attempt, or the blocker question of a `stuck` one. */
      decisionAnswered: boolean;
      /** An ended attempt, and the issue was queued again after it ended (its live implement workflow is newer). */
      requeuedAfterEnd: boolean;
      /** Who an `asked` attempt waits on, from its newest question round: the issue's author (a GitHub comment) or a maintainer (the workflow's recommendation); null in other states. */
      asked: "author" | "maintainer" | null;
      /** The attempt's PR is open. */
      prOpen: boolean;
    } | null;
    /** Live implementations in the repo other than this issue's. */
    liveInRepo: number;
  };
};

/** What is due for an open item in the triage steps. */
export type ItemPlan = {
  repo: string; number: number; kind: "pr" | "issue";
  state: ItemState;
  actions: Action[];
  /** What it waits on when no action is due. */
  wait: string | null;
  /** Who `wait` is on; null exactly when `wait` is. */
  waitKind: WaitKind | null;
};

/** The item's plans together: the triage plan, and for a PR the review-to-merge Plan; `actions` lists both, triage first. */
export type ItemView = {
  repo: string; number: number; kind: "pr" | "issue";
  head: string | null;
  item: ItemPlan;
  pr: Plan | null;
  actions: Action[];
  /** The Work page's next-step text. */
  next: string;
};

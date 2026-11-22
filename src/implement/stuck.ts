// A stuck implementation (D8): one decision per issue, `<repo>#<n>:implement`, with Try again, Open as draft PR (only when
// the change passes the PR step's diff check), Close issue and Backlog; decide.prepare recommends one like for any decision.
// Three attempts per issue text version at most get Try again. Three implementations in a row on a repo that end stuck or
// failed without a PR trip the repo's Implement breaker (`implement:<repo>`).
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { actionable, ask, BACKLOG, factsOf, getDecision, optionsOf, type DecisionRow, type Option } from "../decisions.ts";
import { tripKey } from "../core/push-outcome.ts";
import { sinceOf, trip, tripRow } from "../push-outcomes.ts";
import { textHash } from "../core/open-prs.ts";
import { queuerOf } from "./gate.ts";
import { closeOnAnswer, type CloseDeps } from "./close.ts";
import { settleQuestions } from "./questions.ts";
import { addRound, implementationsOf, roundsOf, setImplementationState, startImplementation } from "./store.ts";
import type { Implementation } from "./types.ts";

const ACTOR = "implement";

/** Why an implementation got stuck, and the line the decision and the row's reason start with. */
export const STUCK_CAUSES = {
  "plan-unparseable": "The plan call's reply could not be read, twice",
  "plan-failed": "The plan call failed",
  "plan-flagged": "The plan still mentions or quotes the reference documentation",
  "question-failed": "The plan's questions could not be posted or asked",
  "close-failed": "The issue could not be closed",
  "reset-failed": "The workspace tree could not be reset after the plan",
  "session-failed": "The implementation session failed twice",
  "session-lost": "The Task Runner kept losing the session before the checks",
  "no-report": "The session did not reply with its report",
  blocked: "The session could not finish",
  "needs-dependency": "The change needs a dependency the workspace does not have",
  "checks-failing": "AutoCraft's checks still fail after three follow-up rounds",
  "checks-no-verdict": "AutoCraft's checks gave no verdict twice (timeout, killed or did not run)",
  "no-change": "The session finished without changing anything",
  "diff-refused": "The change touches what an implementation may not change",
  "push-failed": "Pushing the branch failed repeatedly",
  "workspace-lost": "The workspace could not be started again",
} as const;
export type StuckCause = keyof typeof STUCK_CAUSES;

/** Attempts per issue text version that may end stuck and still be offered Try again. */
export const MAX_ATTEMPTS_PER_TEXT = 3;
/** Implementations in a row on a repo that end stuck or failed without a PR before the repo's Implement breaker trips. */
export const STUCK_IN_A_ROW = 3;

export const implementDecisionId = (repo: string, number: number): string => `${repo}#${number}:implement`;

export const STUCK_OPTIONS = {
  tryAgain: { key: "try-again", label: "Try again", hint: "Plan and implement it again in a new attempt. Text you add goes to the model as guidance." },
  draft: { key: "draft-pr", label: "Open as draft PR", hint: "Open the change as it is as a draft pull request for a person to finish." },
  close: { key: "close-issue", label: "Close issue", hint: "AutoCraft comments that the issue is closed for now and closes it as not planned." },
} as const satisfies Record<string, Option>;

/**
 * Whether the attempt's change would pass the PR step's diff check (validateImplementation), so Open as draft PR can be offered.
 * The PR step provides it; without one the option is never offered.
 */
export type DiffCheck = (db: Db, impl: Implementation) => Promise<{ ok: boolean; reason?: string }>;
export const noDiffCheck: DiffCheck = async () => ({ ok: false, reason: "the diff check is not available" });

/** The hash of the issue's current title and body, as attempts record it; null when the issue is not in the mirror. */
async function currentTextHash(db: Db, repo: string, number: number): Promise<string | null> {
  const it = await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", repo).where("number", "=", number));
  return it ? textHash(it.title ?? "", it.body ?? "") : null;
}

/** The comment the stuck decision's Close issue posts before the close. */
export const STUCK_CLOSE_COMMENT = "Closing this as not planned for now. Reopen it when it should be picked up again.";

/** Clears the answer of the decision `id` (and its carrying-out state), so the question is open again. */
async function clearAnswer(db: Db, id: string): Promise<void> {
  await db.run(db.k.updateTable("main.decisions").set({ answer: null, answer_note: null, exceptions: null, answered_by: null, answered_at: null, applied_at: null, adopted_opinion: null, exec_state: null, exec_reason: null, dispute_by: null, dispute_reason: null, dispute_at: null })
    .where("id", "=", id));
}

/** Attempts of the issue on its text version `hash`. */
const attemptsOnText = async (db: Db, repo: string, number: number, hash: string): Promise<number> =>
  (await implementationsOf(db, repo, number)).filter((r) => r.textHash === hash).length;

/**
 * Moves the attempt to `stuck` and asks its decision. Any earlier answer of the issue's decision is cleared first, applied or
 * not (one an earlier attempt left unapplied included): the question is a new one. The attempt's question decisions are set
 * aside. Then the repo's breaker is checked. Returns the decision id.
 */
export async function markStuck(db: Db, impl: Implementation, cause: StuckCause, detail: string | null, o: { diffCheck?: DiffCheck; at?: string } = {}): Promise<string> {
  const at = o.at ?? new Date().toISOString();
  const id = implementDecisionId(impl.repo, impl.number);
  const hash = await currentTextHash(db, impl.repo, impl.number) ?? impl.textHash;
  const tries = await attemptsOnText(db, impl.repo, impl.number, hash);
  const draft = cause === "diff-refused" || cause === "no-change" ? { ok: false } : await (o.diffCheck ?? noDiffCheck)(db, impl);
  const options: Option[] = [
    ...(tries < MAX_ATTEMPTS_PER_TEXT ? [STUCK_OPTIONS.tryAgain] : []),
    ...(draft.ok ? [STUCK_OPTIONS.draft] : []),
    STUCK_OPTIONS.close, BACKLOG,
  ];
  const head = STUCK_CAUSES[cause];
  const reason = `${head}${detail ? `: ${detail}` : ""}`.replace(/\s+/g, " ").slice(0, 300);
  const facts = [
    `attempt ${impl.attempt}; ${tries} of ${MAX_ATTEMPTS_PER_TEXT} on this issue text`,
    ...(impl.diffStat ? [`change: ${impl.diffStat}`] : []),
    ...(tries >= MAX_ATTEMPTS_PER_TEXT ? [`no Try again: ${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text; editing the issue allows more`] : []),
  ];
  await db.write(async () => {
    await clearAnswer(db, id);
    await ask(db, [{
      id, kind: "other", repo: impl.repo, number: impl.number, question: "The implementation is stuck. What next?",
      context: `${reason}.${impl.report?.summary ? `\nThe session's last report: ${impl.report.summary}` : ""}`.slice(0, 2000),
      facts, options, asked_at: at, asked_by: ACTOR,
    }], true);
    await setImplementationState(db, impl.id, "stuck", { decisionId: id, reason }, at);
  });
  await settleQuestions(db, impl, null, at);
  await audit(db, ACTOR, "implement-stuck", `${impl.repo}#${impl.number}`, { implementation: impl.id, cause, reason });
  await tripIfStuckInARow(db, impl.repo, at);
  return id;
}

/** Trips `implement:<repo>` when the repo's last STUCK_IN_A_ROW finished implementations since its last resume all ended stuck or failed without a PR. */
export async function tripIfStuckInARow(db: Db, repo: string, at = new Date().toISOString()): Promise<boolean> {
  const key = tripKey("implement", repo);
  if ((await tripRow(db, key))?.active) return false;
  const since = await sinceOf(db, key);
  const rows = await db.all(db.k.selectFrom("main.implementations").select(["number", "attempt", "state", "pr_number"])
    .where("repo", "=", repo).where("updated_at", ">", since)
    .where((eb) => eb.or([eb("pr_number", "is not", null), eb("state", "in", ["stuck", "failed"])]))
    .orderBy("updated_at", "desc").orderBy("id", "desc").limit(STUCK_IN_A_ROW));
  if (rows.length < STUCK_IN_A_ROW || rows.some((r) => r.pr_number !== null)) return false;
  await trip(db, key, `${STUCK_IN_A_ROW} implementations in a row in ${repo} ended stuck or failed without a PR`, rows.map((r) => `${repo}#${r.number} attempt ${r.attempt}`), at);
  return true;
}

/** A Try again note for the attempt: who answered, when, and the text. */
export type AttemptGuidance = { by: string | null; at: string; text: string };

/** The guidance people gave the attempt (Try again notes) with who gave it, oldest first. */
export async function attemptGuidance(db: Db, implementationId: number): Promise<AttemptGuidance[]> {
  return (await roundsOf(db, implementationId)).filter((r) => r.kind === "guidance").flatMap((r) => {
    const g = r.result as { text?: unknown; by?: unknown } | null;
    return typeof g?.text === "string" && g.text.trim() ? [{ by: typeof g.by === "string" ? g.by : null, at: r.at, text: g.text.trim() }] : [];
  });
}

/** The guidance people gave the attempt (Try again notes), oldest first. */
export async function guidanceOf(db: Db, implementationId: number): Promise<string[]> {
  return (await attemptGuidance(db, implementationId)).map((g) => g.text);
}

/** The PR step opens the attempt's PR as a draft: its stuck decision was answered Open as draft PR. */
export async function opensAsDraft(db: Db, impl: Implementation): Promise<boolean> {
  return impl.decisionId !== null && (await getDecision(db, impl.decisionId))?.answer === STUCK_OPTIONS.draft.key;
}

export type StuckOutcome = { did: string; next: Implementation | null };

/**
 * Asks the stuck decision again because its answer cannot be carried out: the answer is cleared, `why` heads its context,
 * and Try again is no longer offered once the attempts on this issue text are used up.
 */
async function askAgain(db: Db, impl: Implementation, d: DecisionRow, why: string, at: string): Promise<void> {
  const hash = await currentTextHash(db, impl.repo, impl.number) ?? impl.textHash;
  const tries = await attemptsOnText(db, impl.repo, impl.number, hash);
  const options = optionsOf(d).filter((o) => o.key !== STUCK_OPTIONS.tryAgain.key || tries < MAX_ATTEMPTS_PER_TEXT);
  const head = `Not carried out: ${why}`.replace(/\s+/g, " ").slice(0, 400);
  const rest = (d.context ?? "").replace(/^Not carried out: [^\n]*\n/, "");
  await db.write(async () => {
    await clearAnswer(db, d.id);
    await ask(db, [{
      id: d.id, kind: d.kind, repo: impl.repo, number: impl.number, question: d.question, context: `${head}.\n${rest}`.slice(0, 2000),
      facts: factsOf(d), options, asked_at: at, asked_by: ACTOR,
    }], true);
  });
  await audit(db, ACTOR, "implement-reask", `${impl.repo}#${impl.number}`, { implementation: impl.id, decision: d.id, answer: d.answer, why });
}

/**
 * Carries out the answer of a stuck attempt's decision, when someone who settles on the repo gave one: Try again ends the
 * attempt and starts a new one (its note becomes the new attempt's guidance), Open as draft PR hands the attempt to the PR
 * step, Close issue comments and closes the issue (close.ts). Backlog only holds the item, which the planner reads. An
 * answer that cannot be carried out is asked again with the reason; one that waits (a sign-in, a transient failure) stays.
 * Returns null when there is no answer to carry out.
 */
export async function applyStuckAnswer(db: Db, impl: Implementation, o: { at?: string; close?: CloseDeps } = {}): Promise<StuckOutcome | null> {
  const at = o.at ?? new Date().toISOString();
  if (impl.state !== "stuck" || impl.decisionId === null) return null;
  const a = (await actionable(db)).find((x) => x.id === impl.decisionId);
  if (!a) return null;
  const d = (await getDecision(db, a.id))!;
  const applied = async () => void await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", a.id).where("applied_at", "is", null));
  const again = async (why: string): Promise<StuckOutcome> => {
    await askAgain(db, impl, d, why, at);
    return { did: `not carried out (${why}); asked again`, next: null };
  };
  if (a.answer === STUCK_OPTIONS.tryAgain.key) {
    const hash = await currentTextHash(db, impl.repo, impl.number) ?? impl.textHash;
    if (await attemptsOnText(db, impl.repo, impl.number, hash) >= MAX_ATTEMPTS_PER_TEXT) return await again(`${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text, so Try again is not available; editing the issue allows more`);
    await setImplementationState(db, impl.id, "failed", { reason: `${impl.reason ?? "stuck"}; tried again` }, at);
    const next = await startImplementation(db, { repo: impl.repo, number: impl.number, queuedBy: await queuerOf(db, impl.repo, impl.number) ?? impl.queuedBy, textHash: hash }, at);
    const note = d.answer_note?.trim();
    if (note) await addRound(db, next.id, "guidance", { result: { by: d.answered_by, text: note.slice(0, 4000), decisionId: a.id } }, at);
    await applied();
    await audit(db, ACTOR, "implement-retry", `${impl.repo}#${impl.number}`, { from: impl.id, to: next.id, by: d.answered_by });
    return { did: `attempt ${next.attempt} started`, next };
  }
  if (a.answer === STUCK_OPTIONS.draft.key) {
    if (!optionsOf(d).some((x) => x.key === STUCK_OPTIONS.draft.key)) return await again("Open as draft PR was not offered for this attempt");
    await setImplementationState(db, impl.id, "opening", {}, at);
    await applied();
    return { did: "handed to the PR step as a draft", next: null };
  }
  if (a.answer === STUCK_OPTIONS.close.key) {
    const r = await closeOnAnswer(db, impl, { decisionId: a.id, answer: a.answer, bucket: "build", comment: STUCK_CLOSE_COMMENT }, { ...o.close, now: () => at });
    if ("done" in r) return { did: r.done, next: null };
    if ("waiting" in r) return { did: `not closed yet: ${r.waiting}`, next: null };
    return await again(r.refused);
  }
  return await again(`the answer ${a.answer} is not one of its options`);
}

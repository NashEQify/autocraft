// A stuck implementation (D8): one decision per issue, `<repo>#<n>:implement`, with Try again, Open as draft PR (only when
// the change passes the PR step's diff check), Close issue and Backlog; decide.prepare recommends one like for any decision.
// Three attempts per issue text version at most get Try again. Three implementations in a row on a repo that end stuck or
// failed without a PR trip the repo's Implement breaker (`implement:<repo>`).
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { actionable, ask, BACKLOG, getDecision, type Option } from "../decisions.ts";
import { tripKey } from "../core/push-outcome.ts";
import { sinceOf, trip, tripRow } from "../push-outcomes.ts";
import { textHash } from "../fixissue/candidates.ts";
import { queuerOf } from "./gate.ts";
import { addRound, implementationsOf, roundsOf, setImplementationState, startImplementation } from "./store.ts";
import type { Implementation } from "./types.ts";

const ACTOR = "implement";

/** Why an implementation got stuck, and the line the decision and the row's reason start with. */
export const STUCK_CAUSES = {
  "plan-unparseable": "The plan call's reply could not be read, twice",
  "session-failed": "The implementation session failed twice",
  "no-report": "The session did not reply with its report",
  blocked: "The session could not finish",
  "needs-dependency": "The change needs a dependency the workspace does not have",
  "checks-failing": "AutoCraft's checks still fail after three follow-up rounds",
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
  close: { key: "close-issue", label: "Close issue", hint: "Close the issue on GitHub." },
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

/** Attempts of the issue on its text version `hash`. */
const attemptsOnText = async (db: Db, repo: string, number: number, hash: string): Promise<number> =>
  (await implementationsOf(db, repo, number)).filter((r) => r.textHash === hash).length;

/**
 * Moves the attempt to `stuck` and asks its decision. An earlier answer of the issue's decision that was applied is cleared
 * first: the question is a new one. Then the repo's breaker is checked. Returns the decision id.
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
    await db.run(db.k.updateTable("main.decisions").set({ answer: null, answer_note: null, exceptions: null, answered_by: null, answered_at: null, applied_at: null, adopted_opinion: null, exec_state: null, exec_reason: null, dispute_by: null, dispute_reason: null, dispute_at: null })
      .where("id", "=", id).where("applied_at", "is not", null));
    await ask(db, [{
      id, kind: "other", repo: impl.repo, number: impl.number, question: "The implementation is stuck. What next?",
      context: `${reason}.${impl.report?.summary ? `\nThe session's last report: ${impl.report.summary}` : ""}`.slice(0, 2000),
      facts, options, asked_at: at, asked_by: ACTOR,
    }], true);
    await setImplementationState(db, impl.id, "stuck", { decisionId: id, reason }, at);
  });
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

/** The guidance people gave the attempt (Try again notes), oldest first. */
export async function guidanceOf(db: Db, implementationId: number): Promise<string[]> {
  return (await roundsOf(db, implementationId)).filter((r) => r.kind === "guidance").flatMap((r) => {
    const t = (r.result as { text?: unknown } | null)?.text;
    return typeof t === "string" && t.trim() ? [t.trim()] : [];
  });
}

/** The PR step opens the attempt's PR as a draft: its stuck decision was answered Open as draft PR. */
export async function opensAsDraft(db: Db, impl: Implementation): Promise<boolean> {
  return impl.decisionId !== null && (await getDecision(db, impl.decisionId))?.answer === STUCK_OPTIONS.draft.key;
}

export type StuckOutcome = { did: string; next: Implementation | null };

/**
 * Carries out the answer of a stuck attempt's decision, when someone who settles on the repo gave one: Try again ends the
 * attempt and starts a new one (its note becomes the new attempt's guidance), Open as draft PR hands the attempt to the PR
 * step. Backlog only holds the item, which the planner reads. Returns null when there is nothing to carry out.
 */
export async function applyStuckAnswer(db: Db, impl: Implementation, at = new Date().toISOString()): Promise<StuckOutcome | null> {
  if (impl.state !== "stuck" || impl.decisionId === null) return null;
  const a = (await actionable(db)).find((x) => x.id === impl.decisionId);
  if (!a) return null;
  const d = (await getDecision(db, a.id))!;
  const applied = async () => void await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", a.id).where("applied_at", "is", null));
  if (a.answer === STUCK_OPTIONS.tryAgain.key) {
    const hash = await currentTextHash(db, impl.repo, impl.number) ?? impl.textHash;
    if (await attemptsOnText(db, impl.repo, impl.number, hash) >= MAX_ATTEMPTS_PER_TEXT) return null;
    await setImplementationState(db, impl.id, "failed", { reason: `${impl.reason ?? "stuck"}; tried again` }, at);
    const next = await startImplementation(db, { repo: impl.repo, number: impl.number, queuedBy: await queuerOf(db, impl.repo, impl.number) ?? impl.queuedBy, textHash: hash }, at);
    const note = d.answer_note?.trim();
    if (note) await addRound(db, next.id, "guidance", { result: { by: d.answered_by, text: note.slice(0, 4000), decisionId: a.id } }, at);
    await applied();
    await audit(db, ACTOR, "implement-retry", `${impl.repo}#${impl.number}`, { from: impl.id, to: next.id, by: d.answered_by });
    return { did: `attempt ${next.attempt} started`, next };
  }
  if (a.answer === STUCK_OPTIONS.draft.key) {
    await setImplementationState(db, impl.id, "opening", {}, at);
    await applied();
    return { did: "handed to the PR step as a draft", next: null };
  }
  if (a.answer === STUCK_OPTIONS.close.key) {
    // The attempt ends here. The close itself is a GitHub write of the Act stage; the answer stays unapplied until it is made.
    await setImplementationState(db, impl.id, "cancelled", { reason: "Close issue was answered" }, at);
    return { did: "ended; the issue close is left to the Act stage", next: null };
  }
  return null;
}

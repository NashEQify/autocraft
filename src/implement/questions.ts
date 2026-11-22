// The questions a plan asks before an issue is implemented (implement.plan with ready false). A fact only the reporter
// knows goes to the author as one comment on the issue from the bot, when the repo approves comments; a product, design or
// scope choice (or a size split) goes to the maintainers as a decision with the plan's options, Backlog and a free-text note,
// which the prepare step summarises and recommends. Every question is one `question` round with its audience, so the planner
// waits on the newest one and plans again on its answer (issue-facts.ts). After QUESTION_ROUNDS_MAX rounds of questions the
// maintainers decide instead whether to go on with stated assumptions, hold it or close the issue.
import type { Db } from "../db/index.ts";
import { ask, BACKLOG, getDecision, optionsOf, type DecisionRow, type Option } from "../decisions.ts";
import { WITHDRAWN } from "../merge/withdraw.ts";
import { addRound, roundsOf, setImplementationState } from "./store.ts";
import { PLAN_QUESTION_CHARS, QUESTION_ROUNDS_MAX, type PlanAsked } from "./plan-types.ts";
import type { Implementation, PlanQuestion, PlanReply, QuestionRound } from "./types.ts";

/** `asked_by` of the decisions an implementation asks. */
export const IMPLEMENT_ASKER = "implement";
/** The options of the decision asked after QUESTION_ROUNDS_MAX rounds of questions. */
export const LIMIT_IMPLEMENT: Option = { key: "implement", label: "Implement with the stated assumptions", hint: "Plan again without asking; the plan states each assumption it makes and the PR lists them." };
export const LIMIT_CLOSE: Option = { key: "close", label: "Close issue", hint: "AutoCraft comments that the issue lacks the detail to implement and closes it as not planned." };
export const LIMIT_CLOSE_COMMENT = "Closing this for now: it does not have the detail needed to implement it. Reopen it with the missing details and it can be picked up again.";

export const questionDecisionId = (repo: string, number: number, attempt: number, round: number): string => `${repo}#${number}:implement-q${attempt}-${round}`;
export const limitDecisionId = (repo: string, number: number, attempt: number): string => `${repo}#${number}:implement-limit-${attempt}`;
export const isLimitDecision = (id: string | null): boolean => id !== null && /:implement-limit-\d+$/.test(id);
const isQuestionDecision = (id: string | null): id is string => id !== null && /:implement-(q\d+-\d+|limit-\d+)$/.test(id);

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The comment that asks the author: their questions, numbered when there are several. */
export function authorComment(qs: readonly PlanQuestion[]): string {
  const texts = qs.map((q) => cut(q.text.trim(), PLAN_QUESTION_CHARS));
  const body = texts.length === 1 ? texts[0]! : texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Before this can be implemented, a few details are needed:\n\n${body}`;
}

export type QuestionDeps = {
  /** Comments are approved on the repo: author questions can be posted. */
  commentsApproved: boolean;
  /** Posts the comment on the issue (write.ts via the caller's grant); returns the comment's id, or throws. */
  postComment(text: string): Promise<string | null>;
  log(line: string): void;
  now?: () => string;
};

/**
 * Sets the attempt's question decisions aside, all but `keep`: an open one is answered withdrawn by the pipeline and an
 * answered one is marked applied, since the plan round that follows has read its answer.
 */
export async function settleQuestions(db: Db, impl: Implementation, keep: string | null, at: string): Promise<void> {
  const ids = new Set<string>();
  for (const r of await roundsOf(db, impl.id)) {
    const id = r.kind === "question" ? (r.result as Partial<QuestionRound> | null)?.decisionId ?? null : null;
    if (isQuestionDecision(id)) ids.add(id);
  }
  if (isQuestionDecision(impl.decisionId)) ids.add(impl.decisionId);
  if (keep !== null) ids.delete(keep);
  if (!ids.size) return;
  const list = [...ids];
  await db.write(async () => {
    await db.run(db.k.updateTable("main.decisions").set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: "superseded by a later plan round", adopted_opinion: null })
      .where("id", "in", list).where("answer", "is", null));
    await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "in", list).where("answer", "is not", null).where("applied_at", "is", null));
  });
}

/**
 * Asks what the reply's questions need and moves the attempt to `asked`. `planRound` is the id of the plan round the reply
 * is stored in (its questions are counted with the earlier ones). Running it again on the same plan round writes only what
 * an earlier run did not: a comment or decision already recorded in a question round after the plan round is not made again.
 * Returns the rounds written.
 */
export async function askQuestions(db: Db, impl: Implementation, reply: PlanReply, deps: QuestionDeps, planRound: number): Promise<QuestionRound[]> {
  const at = deps.now?.() ?? new Date().toISOString();
  const ref = `${impl.repo}#${impl.number}`;
  const rounds = await roundsOf(db, impl.id);
  const asked = rounds.filter((r) => r.kind === "plan" && r.id <= planRound && (r.result as { ready?: unknown } | null)?.ready === false).length;
  const before = rounds.filter((r) => r.kind === "question" && r.id > planRound).map((r) => r.result as Partial<QuestionRound> | null);
  const did = (audience: QuestionRound["audience"]): boolean => before.some((q) => q?.audience === audience);
  const written: QuestionRound[] = [];
  const round = async (q: QuestionRound): Promise<void> => {
    await addRound(db, impl.id, "question", { callId: impl.planCallId, result: q }, at);
    written.push(q);
  };
  // The attempt moves on, and records which plan round it moved on from (plan_call_id), in one write.
  const moveOn = async (decisionId: string | null): Promise<void> => {
    await settleQuestions(db, impl, decisionId, at);
    await setImplementationState(db, impl.id, "asked", { decisionId, planCallId: impl.planCallId }, at);
  };

  // Past the limit (this reply's round included): the maintainers choose how to go on.
  if (asked > QUESTION_ROUNDS_MAX) {
    const id = limitDecisionId(impl.repo, impl.number, impl.attempt);
    const text = `Implement ${ref} with the stated assumptions? The plan still has open questions after ${QUESTION_ROUNDS_MAX} rounds.`;
    if (!did("maintainer")) {
      await ask(db, [{
        id, kind: "other", repo: impl.repo, number: impl.number, question: text,
        context: `The plan so far: ${cut(reply.summary, 400)}\n\nStill open:\n${reply.questions.map((q) => `- ${cut(q.text, 300)}`).join("\n")}`,
        facts: [`attempt: ${impl.attempt}`, `question rounds: ${asked - 1}`],
        options: [LIMIT_IMPLEMENT, BACKLOG, LIMIT_CLOSE], asked_by: IMPLEMENT_ASKER, asked_at: at,
      }]);
      await round({ audience: "maintainer", text, decisionId: id });
    }
    await moveOn(id);
    deps.log(`${ref}: ${asked - 1} rounds of questions; asked the maintainers whether to go on (${id})`);
    return written;
  }

  let author = reply.questions.filter((q) => q.audience === "author");
  const maintainer = reply.questions.filter((q) => q.audience === "maintainer");
  if (author.length && !deps.commentsApproved) {
    deps.log(`${ref}: comments are not approved on ${impl.repo}; the author question goes to the maintainers`);
    maintainer.push(...author.map((q) => ({ ...q, audience: "maintainer" as const })));
    author = [];
  }

  if (author.length && !did("author")) {
    const text = authorComment(author);
    const commentId = await deps.postComment(text);
    for (const q of author) await round({ audience: "author", text: q.text, ...(commentId !== null && { commentId }) });
    deps.log(`${ref}: asked the author${commentId !== null ? ` (comment ${commentId})` : ""}`);
  }

  let decisionId: string | null = null;
  if (maintainer.length) {
    decisionId = questionDecisionId(impl.repo, impl.number, impl.attempt, asked);
    if (!did("maintainer")) {
      const [first, ...rest] = maintainer;
      await ask(db, [maintainerDecision(impl, reply, first!, rest, decisionId, at)]);
      for (const q of maintainer) await round({ audience: "maintainer", text: q.text, decisionId });
      deps.log(`${ref}: asked the maintainers (${decisionId})`);
    }
  }
  await moveOn(decisionId);
  return written;
}

/** The decision of a maintainer question: its options, Backlog and the plan's recommendation; further open questions in the context. */
function maintainerDecision(impl: Implementation, reply: PlanReply, q: PlanQuestion, rest: PlanQuestion[], id: string, at: string): Record<string, unknown> {
  const options: Option[] = q.options.slice(0, 3).map((o, i) => ({ key: `o${i + 1}`, label: cut(o.label, 80), ...(o.hint && { hint: cut(o.hint, 200) }) }));
  // A question without two options (an author question rerouted here) gets one answer to give in the note.
  if (options.length < 2) options.splice(0, options.length, { key: "answer", label: "Answer in the note", hint: "Write the answer in the note; the plan runs again with it." });
  const rec = q.recommended === null ? -1 : q.options.findIndex((o) => o.label === q.recommended);
  const also = rest.length ? `\n\nAlso open (answer in the note):\n${rest.map((x) => `- ${cut(x.text, 300)}`).join("\n")}` : "";
  return {
    id, kind: reply.size === "XL" ? "split" : "other", repo: impl.repo, number: impl.number, question: cut(q.text, PLAN_QUESTION_CHARS),
    context: `The plan so far: ${cut(reply.summary, 400)}${also}`,
    facts: [`size: ${reply.size}`, `kind: ${reply.kind}`, `attempt: ${impl.attempt}`],
    options: [...options, BACKLOG],
    ...(rec >= 0 && rec < options.length && { recommended: options[rec]!.key, recommended_reason: "The plan recommends it." }),
    asked_by: IMPLEMENT_ASKER, asked_at: at,
  };
}

/** The attempt's earlier questions with what answered them: the decision's answer and note; an author question's answer is in the comments. */
export async function askedSoFar(db: Db, impl: Implementation): Promise<PlanAsked[]> {
  const decisions = new Map<string, DecisionRow | undefined>();
  const out: PlanAsked[] = [];
  for (const r of await roundsOf(db, impl.id)) {
    if (r.kind !== "question") continue;
    const q = r.result as Partial<QuestionRound> | null;
    if (!q || (q.audience !== "author" && q.audience !== "maintainer") || typeof q.text !== "string") continue;
    let answer: string | null = null;
    if (q.decisionId) {
      if (!decisions.has(q.decisionId)) decisions.set(q.decisionId, await getDecision(db, q.decisionId));
      const d = decisions.get(q.decisionId);
      // A question set aside unanswered (settleQuestions) has no answer to show.
      if (d?.answer && d.answer !== WITHDRAWN) {
        const label = optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer;
        answer = `${label}${d.answer_note ? `: ${d.answer_note}` : ""}`;
      }
    }
    out.push({ audience: q.audience, text: q.text, at: r.at, answer });
  }
  return out;
}

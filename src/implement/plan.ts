// The plan bucket of the implement step: one Opus call (implement.plan) in a workspace at the default branch head, on the
// queuer's Task Runner, that reads the issue, its comments and the thread's guidance and either plans the change or asks
// (questions.ts). The reply is parsed strictly; an unusable reply, or an author question that the reference lint flags,
// gets one follow-up turn in the same session. After the reply the tree is reset, so the session starts clean.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { readLive } from "../act/index.ts";
import { exec } from "../fixup/git.ts";
import { guardItem } from "../core/guard.ts";
import { byOfJob } from "../core/gates.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { textHash } from "../fixissue/candidates.ts";
import { actionable, getDecision } from "../decisions.ts";
import { closeItem, commentOn, ghComment } from "../github/write.ts";
import { ITEM_SERVER, itemTools } from "../itemtools/index.ts";
import { Client } from "../mirror.ts";
import { claudeParts, CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, referenceProblems, type PublicText } from "../reference-lint.ts";
import { REFERENCE_SERVER, promptTier } from "../remote/bundle.ts";
import { fixTurnMessage } from "../replylint.ts";
import { isBotLogin } from "../review/bots.ts";
import { setting } from "../settings-read.ts";
import { settleMemo, settlesNow } from "../settlers.ts";
import { endWorkspace } from "../build/workspaces.ts";
import type { StepContext } from "../runner/steps.ts";
import { queuerOf } from "./gate.ts";
import {
  PLAN_ACCEPTANCE_MAX, PLAN_BODY_CHARS, PLAN_COMMENT_CHARS, PLAN_COMMENTS_MAX, PLAN_GUIDANCE_CHARS, PLAN_GUIDANCE_MAX, PLAN_MAX_TURNS,
  PLAN_OPTIONS_MAX, PLAN_QUESTION_CHARS, PLAN_QUESTIONS_MAX, PLAN_SUMMARY_CHARS, PLAN_TIMEOUT_SEC,
  type PlanAsked, type PlanGuidance, type PlanInput, type PlanIssue,
} from "./plan-types.ts";
import { askedSoFar, askQuestions, IMPLEMENT_ASKER, isLimitDecision, LIMIT_CLOSE, LIMIT_CLOSE_COMMENT, LIMIT_IMPLEMENT, type QuestionDeps } from "./questions.ts";
import { addRound, currentImplementation, roundsOf, setImplementationState, startImplementation, updateImplementation } from "./store.ts";
import type { Implementation, PlanQuestion, PlanReply } from "./types.ts";
import { mainHeadOf, readyWorkspace, resetTree, runBoundCall, WorkspaceUnavailable, type CallResult } from "./workspace.ts";

export const PLAN_PROMPT_ID = "implement.plan";
const PROMPT = CLAUDE_PROMPTS[PLAN_PROMPT_ID];
export const PLAN_PROMPT_VERSION = createHash("sha256").update(PROMPT.template).digest("hex").slice(0, 10);

// ---- the reply -------------------------------------------------------------------------------------------------

const KINDS = ["bugfix", "feature", "change"] as const;
const SIZES = ["S", "M", "L", "XL"] as const;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const texts = (v: unknown, what: string, max = 50): string[] => {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string")) throw new Error(`${what} must be a list of at most ${max} texts`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
};

/** The JSON text of a reply: the whole content of its one fenced block, or the text from the first "{" to the last "}". */
function jsonOf(text: string): string {
  const fences = [...text.matchAll(/```[a-z]*\s*\n([\s\S]*?)\n\s*```/g)];
  if (fences.length > 1) throw new Error("the reply holds more than one fenced block");
  if (fences.length === 1) return fences[0]![1]!;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("the reply holds no JSON object");
  return text.slice(a, b + 1);
}

function question(v: unknown, i: number): PlanQuestion {
  const q = v as Partial<Record<keyof PlanQuestion, unknown>> | null;
  const at = `questions[${i}]`;
  if (!q || typeof q !== "object") throw new Error(`${at} must be an object`);
  if (q.audience !== "author" && q.audience !== "maintainer") throw new Error(`${at}.audience must be author or maintainer`);
  if (!isText(q.text) || q.text.length > PLAN_QUESTION_CHARS) throw new Error(`${at}.text must be text of at most ${PLAN_QUESTION_CHARS} characters`);
  const raw = q.options ?? [];
  if (!Array.isArray(raw)) throw new Error(`${at}.options must be a list`);
  const options = raw.map((o: unknown, k) => {
    const x = o as { label?: unknown; hint?: unknown } | null;
    if (!x || !isText(x.label) || (x.hint !== undefined && typeof x.hint !== "string")) throw new Error(`${at}.options[${k}] needs a label and a hint`);
    return { label: x.label.trim(), hint: typeof x.hint === "string" ? x.hint.trim() : "" };
  });
  if (q.audience === "author" && options.length) throw new Error(`${at} asks the author and has options: an author question has none`);
  if (q.audience === "maintainer" && (options.length < 2 || options.length > PLAN_OPTIONS_MAX)) throw new Error(`${at} asks the maintainers and needs 2 to ${PLAN_OPTIONS_MAX} options`);
  if (new Set(options.map((o) => o.label)).size !== options.length) throw new Error(`${at} repeats an option label`);
  const rec = q.recommended ?? null;
  if (rec !== null && (typeof rec !== "string" || !options.some((o) => o.label === rec))) throw new Error(`${at}.recommended must be one of its option labels or null`);
  return { audience: q.audience, text: q.text.trim(), options, recommended: rec };
}

/** Reads a plan reply; throws with what is wrong. `assume`: a maintainer chose to go on, so the reply must be ready. */
export function parsePlanReply(text: string, assume = false): PlanReply {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(jsonOf(text)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? "the JSON does not parse" : (e as Error).message);
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("the reply must be one JSON object");
  if (typeof o.ready !== "boolean") throw new Error("ready must be true or false");
  if (!KINDS.includes(o.kind as never)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  if (!SIZES.includes(o.size as never)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  if (!isText(o.summary) || o.summary.length > PLAN_SUMMARY_CHARS) throw new Error(`summary must be text of at most ${PLAN_SUMMARY_CHARS} characters`);
  if (!isText(o.plan)) throw new Error("plan must be text");
  const v = o.verification as { tests?: unknown; app?: unknown } | null | undefined;
  if (!v || typeof v !== "object") throw new Error("verification must be an object with tests and app");
  if (v.app !== null && v.app !== undefined && typeof v.app !== "string") throw new Error("verification.app must be text or null");
  if (!Array.isArray(o.questions ?? [])) throw new Error("questions must be a list");
  const reply: PlanReply = {
    ready: o.ready, kind: o.kind as PlanReply["kind"], summary: o.summary.trim(), plan: o.plan.trim(),
    acceptance: texts(o.acceptance ?? [], "acceptance", PLAN_ACCEPTANCE_MAX),
    verification: { tests: texts(v.tests ?? [], "verification.tests"), app: isText(v.app) ? v.app.trim() : null },
    size: o.size as PlanReply["size"], risks: texts(o.risks ?? [], "risks"),
    questions: ((o.questions ?? []) as unknown[]).map(question),
  };
  if (reply.ready && (!reply.acceptance.length || reply.questions.length)) throw new Error(`a ready reply needs 1 to ${PLAN_ACCEPTANCE_MAX} acceptance criteria and no questions`);
  if (!reply.ready && (!reply.questions.length || reply.questions.length > PLAN_QUESTIONS_MAX)) throw new Error(`a reply that is not ready needs 1 to ${PLAN_QUESTIONS_MAX} questions`);
  if (!reply.ready && assume) throw new Error("assume is true: the maintainers chose to go on, so the reply must be ready, with each assumption as a risk");
  return reply;
}

/** The reply's texts that go public: the plan in the PR body (summary, plan, acceptance, verification, risks) and the author questions on the issue. */
export function publicTexts(r: PlanReply): PublicText[] {
  return [
    { field: "summary", text: r.summary }, { field: "plan", text: r.plan },
    ...r.acceptance.map((text, i) => ({ field: `acceptance[${i}]`, text })), ...r.risks.map((text, i) => ({ field: `risks[${i}]`, text })),
    ...r.verification.tests.map((text, i) => ({ field: `verification.tests[${i}]`, text })), ...(r.verification.app ? [{ field: "verification.app", text: r.verification.app }] : []),
    ...r.questions.flatMap((q, i) => (q.audience === "author" ? [{ field: `questions[${i}].text`, text: q.text }] : [])),
  ];
}

/** The plan as Markdown, for the item page and the PR body. */
export function planMarkdown(r: PlanReply): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    `**${r.kind}, size ${r.size}.** ${r.summary}`, r.plan,
    r.acceptance.length ? `**Acceptance**\n\n${list(r.acceptance)}` : "",
    r.verification.tests.length || r.verification.app ? `**Verification**\n\n${list([...r.verification.tests.map((t) => `\`${t.replace(/`/g, "'")}\``), ...(r.verification.app ? [r.verification.app] : [])])}` : "",
    r.risks.length ? `**Risks**\n\n${list(r.risks)}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---- the input ---------------------------------------------------------------------------------------------------

const cut = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

/** The issue, its comments (bots and the pipeline left out), the thread's guidance by operators and write-maintainers, and the earlier questions. */
export async function planInput(db: Db, o: { repo: string; number: number; sha: string; asked: PlanAsked[]; assume: boolean }): Promise<PlanInput> {
  const it = await db.get(db.k.selectFrom("items").select(["title", "body", "author", "labels"]).where("repo", "=", o.repo).where("number", "=", o.number));
  if (!it) throw new Error(`${o.repo}#${o.number} is not in the mirror`);
  const pipeline = await setting(db, "pipeline_login");
  const comments = (await db.all(db.k.selectFrom("comments").select(["author", "created_at", "body"]).where("repo", "=", o.repo).where("number", "=", o.number).orderBy("created_at").orderBy("id")))
    .filter((c) => c.author === null || (c.author !== pipeline && !isBotLogin(c.author)))
    .slice(-PLAN_COMMENTS_MAX).map((c) => ({ author: c.author, at: c.created_at ?? "", body: cut(c.body, PLAN_COMMENT_CHARS) }));
  let labels: string[] = [];
  try { labels = (JSON.parse(it.labels ?? "[]") as unknown[]).map(String); } catch { /* none */ }
  const issue: PlanIssue = { number: o.number, title: it.title ?? "", body: cut(it.body, PLAN_BODY_CHARS), author: it.author, labels, comments };
  const memo = settleMemo();
  const guidance: PlanGuidance[] = [];
  for (const t of await db.all(db.k.selectFrom("conversation_turns").select(["kind", "login", "at", "body"]).where("repo", "=", o.repo).where("number", "=", o.number)
    .where("kind", "in", ["operator", "maintainer"]).orderBy("at").orderBy("id"))) {
    // A maintainer's message counts while they settle on the repo (write access where the app acts for them).
    if (t.kind === "maintainer" && !await settlesNow(db, t.login, [o.repo], memo)) continue;
    guidance.push({ from: t.kind as PlanGuidance["from"], login: t.login, at: t.at, text: cut(t.body, PLAN_GUIDANCE_CHARS) });
  }
  return { ref: `${o.repo}#${o.number}`, repo: o.repo, sha: o.sha, issue, guidance: guidance.slice(-PLAN_GUIDANCE_MAX), asked: o.asked, assume: o.assume };
}

// ---- recording a reply -------------------------------------------------------------------------------------------

/**
 * Stores a parsed reply on the attempt (plan_json, plan_md, plan_call_id and a `plan` round) and moves it on: `planned`
 * when ready, else `asked` with its questions (questions.ts).
 */
export async function recordPlan(db: Db, impl: Implementation, r: { callId: number | null; reply: PlanReply }, q: QuestionDeps): Promise<Implementation["state"]> {
  const at = q.now?.() ?? new Date().toISOString();
  await updateImplementation(db, impl.id, { plan: r.reply, planMd: planMarkdown(r.reply), planCallId: r.callId }, at);
  await addRound(db, impl.id, "plan", { callId: r.callId, result: r.reply }, at);
  if (r.reply.ready) {
    await setImplementationState(db, impl.id, "planned", { decisionId: null }, at);
    return "planned";
  }
  await askQuestions(db, { ...impl, planCallId: r.callId }, r.reply, q);
  return "asked";
}

// ---- the job -----------------------------------------------------------------------------------------------------

export type PlanOptions = { repo: string; number: number; /** Nothing is written but the workspace and the call: no implementation row, no GitHub write, no decision. */ dry: boolean };

/** What one plan call and its follow-up turn came to. */
type Planned = { callId: number; reply: PlanReply } | { callId: number | null; error: string };

/** Runs the plan call, with one follow-up turn on an unusable reply or a flagged author question. */
async function callPlan(ctx: StepContext, o: { repo: string; number: number; sha: string; workspaceId: number; forLogin: string; input: PlanInput }): Promise<Planned> {
  const parts = claudeParts(PLAN_PROMPT_ID, [o.input], false);
  const dir = referenceDir(o.repo);
  const servers = [...(itemTools() ? [ITEM_SERVER] : []), ...(dir ? [REFERENCE_SERVER] : [])];
  const base = {
    workspaceId: o.workspaceId, repo: o.repo, number: o.number, baseSha: o.sha, forLogin: o.forLogin, promptId: PLAN_PROMPT_ID, promptVersion: PLAN_PROMPT_VERSION,
    model: PROMPT.models[0]!, tier: promptTier(PLAN_PROMPT_ID), effort: PROMPT.effort, system: parts.system, timeoutSeconds: PLAN_TIMEOUT_SEC, maxTurns: PLAN_MAX_TURNS,
    items: [{ repo: o.repo, number: o.number }], servers, ...(dir && { referenceRepo: dir.split("/").pop()! }), keepSession: true,
  };
  const turn = async (stdin: string, parentId?: number): Promise<CallResult> => await runBoundCall(ctx, { ...base, stdin, ...(parentId !== undefined && { parentId }) });
  let r = await turn(parts.stdin);
  for (let followUp = 0; ; followUp++) {
    if (r.outcome.state !== "done") return { callId: r.callId, error: r.outcome.state === "failed" ? `the plan call failed: ${r.outcome.error.replace(/\s+/g, " ").slice(0, 200)}` : "the plan call was not taken" };
    let problem: string;
    try {
      const reply = parsePlanReply(r.outcome.text, o.input.assume);
      const flagged = await referenceProblems(publicTexts(reply), dir, dir ? defaultSemanticDeps(ctx.db, `${o.repo}#${o.number}`) : undefined);
      if (!flagged.length) return { callId: r.callId, reply };
      if (followUp > 0) {
        // Still flagged after the follow-up: a flagged author question goes to the maintainers instead of being posted;
        // flagged plan text would reach the PR body, so the attempt stops.
        const fields = flagged.map((p) => p.field);
        if (fields.some((f) => !f.startsWith("questions["))) return { callId: r.callId, error: `the plan text still mentions or quotes the reference documentation (${[...new Set(fields)].join(", ")})` };
        const bad = new Set(flagged.map((p) => p.text));
        ctx.log(`${o.repo}#${o.number}: ${bad.size} author question(s) still flagged by the reference lint; asking the maintainers instead`);
        return { callId: r.callId, reply: { ...reply, questions: reply.questions.map((q) => (q.audience === "author" && bad.has(q.text) ? { ...q, audience: "maintainer" as const } : q)) } };
      }
      problem = `${fixTurnMessage(flagged)}\n\nReply again with ONLY the whole JSON object.`;
    } catch (e) {
      if (followUp > 0) return { callId: r.callId, error: `the plan reply was unusable twice: ${(e as Error).message}` };
      problem = `Your reply could not be used: ${(e as Error).message}. Reply again with ONLY the whole JSON object as the instructions describe.`;
    }
    ctx.log(`${o.repo}#${o.number}: follow-up turn on plan call ${r.callId}`);
    r = await turn(problem, r.callId);
  }
}

/** Whether the latest answer on the attempt's limit decision says to close, to go on with assumptions, or nothing. */
async function limitAnswer(db: Db, impl: Implementation): Promise<"close" | "implement" | null> {
  if (!isLimitDecision(impl.decisionId)) return null;
  const a = (await actionable(db)).find((x) => x.id === impl.decisionId);
  return a?.answer === LIMIT_CLOSE.key ? "close" : a?.answer === LIMIT_IMPLEMENT.key ? "implement" : null;
}

/** Carries out a Close answer on the limit decision: one comment, then the issue closed as not planned. */
async function closeOnAnswer(ctx: StepContext, impl: Implementation): Promise<string> {
  const db = ctx.db, ref = `${impl.repo}#${impl.number}`;
  const d = (await getDecision(db, impl.decisionId!))!;
  const g = await guardItem(db, { repo: impl.repo, number: impl.number }, { kind: "implement", bucket: "plan", decisionId: d.id }, byOfJob(ctx.job.requestedBy), d.id);
  if ("refused" in g) throw new Error(g.refused);
  if (!await commentApprovalOf(db, impl.repo)) throw new Error(`commenting in ${impl.repo} is not approved, so ${ref} is not closed`);
  const q = new Client(500);
  const live = await readLive(q, impl.repo, impl.number);
  if (!live) throw new Error(`${ref} could not be read on GitHub`);
  const w = { db, login: IMPLEMENT_ASKER };
  if (live.state === "OPEN") {
    await commentOn(w, g, q, "implement-close-comment", { repo: impl.repo, number: impl.number, id: live.id }, { by: "fixed-operator" }, LIMIT_CLOSE_COMMENT, { decision: d.id });
    await closeItem(w, g, q, { repo: impl.repo, number: impl.number, id: live.id, pr: false }, { decision: d.id }, "NOT_PLANNED");
  }
  const at = new Date().toISOString();
  await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", d.id).where("applied_at", "is", null));
  await setImplementationState(db, impl.id, "cancelled", { reason: `closed on ${d.answered_by ?? "a maintainer"}'s answer` }, at);
  return `${ref}: closed on the answer to ${d.id}`;
}

/** Leaves the attempt stuck with a reason; the stuck decision is asked by the stuck step. */
async function stuck(db: Db, impl: Implementation, reason: string): Promise<string> {
  await setImplementationState(db, impl.id, "stuck", { reason: reason.slice(0, 300) });
  return `${impl.repo}#${impl.number}: stuck: ${reason}`;
}

/** The `implement` job's plan bucket. Returns the one-line summary. */
export async function runPlan(ctx: StepContext, o: PlanOptions): Promise<string> {
  const db = ctx.db, ref = `${o.repo}#${o.number}`;
  const queuer = await queuerOf(db, o.repo, o.number);
  if (!queuer) throw new Error(`${ref} is not queued`);
  const item = await db.get(db.k.selectFrom("items").select(["title", "body", "state"]).where("repo", "=", o.repo).where("number", "=", o.number));
  if (!item || item.state !== "OPEN") throw new Error(`${ref} is not an open issue in the mirror`);
  const hash = textHash(item.title ?? "", item.body ?? "");

  let impl: Implementation | null = null;
  let assume = false;
  if (!o.dry) {
    impl = await currentImplementation(db, o.repo, o.number) ?? await startImplementation(db, { repo: o.repo, number: o.number, queuedBy: queuer, textHash: hash });
    if (impl.state !== "planning" && impl.state !== "asked") return `${ref}: nothing to plan (implementation ${impl.id} is ${impl.state})`;
    const limit = await limitAnswer(db, impl);
    if (limit === "close") return await closeOnAnswer(ctx, impl);
    assume = limit === "implement";
    // The current text is what this round plans; a later edit plans again (issue-facts.ts textChanged).
    await setImplementationState(db, impl.id, "planning", { textHash: hash });
    impl = { ...impl, state: "planning", textHash: hash };
  }
  const forLogin = impl?.queuedBy ?? queuer;
  const sha = await mainHeadOf(db, o.repo) ?? impl?.baseSha ?? null;
  if (!sha) throw new Error(`${ref}: no head commit for the default branch of ${o.repo}`);
  ctx.log(`${ref}: planning at ${sha.slice(0, 8)} on ${forLogin}'s Task Runner${o.dry ? " (dry run: nothing is stored or posted)" : ""}`);

  let wsId: number;
  try {
    wsId = await readyWorkspace(ctx, {
      repo: o.repo, baseSha: sha, have: impl && impl.baseSha === sha ? impl.workspaceId : null,
      adopt: async (id) => {
        if (!impl) return;
        await updateImplementation(db, impl.id, { workspaceId: id, baseSha: sha });
        // A re-plan on a newer head leaves the attempt's earlier workspace behind.
        if (impl.workspaceId !== null && impl.workspaceId !== id && await endWorkspace(db, impl.workspaceId)) ctx.log(`workspace ${impl.workspaceId} (at ${impl.baseSha?.slice(0, 8)}) ended`);
      },
    });
  } catch (e) {
    if (e instanceof WorkspaceUnavailable && impl) return await stuck(db, impl, e.message);
    throw e;
  }
  await ctx.progress(`${ref}: plan call in workspace ${wsId}`);
  ctx.handled(1);

  const input = await planInput(db, { repo: o.repo, number: o.number, sha, asked: impl ? await askedSoFar(db, impl) : [], assume });
  let planned: Planned;
  try {
    planned = await callPlan(ctx, { repo: o.repo, number: o.number, sha, workspaceId: wsId, forLogin, input });
  } finally {
    if (o.dry && await endWorkspace(db, wsId)) ctx.log(`workspace ${wsId} ended`);
  }
  const reset = o.dry ? null : await resetTree(db, wsId);
  if (reset) ctx.log(`${ref}: the tree of workspace ${wsId} was not reset: ${reset}`);

  if (o.dry) {
    if ("error" in planned) throw new Error(`${ref}: ${planned.error}`);
    const r = planned.reply;
    return `${ref}: plan call ${planned.callId}: ${r.ready ? "ready" : `${r.questions.length} question(s) (${[...new Set(r.questions.map((q) => q.audience))].join(", ")})`}, size ${r.size}; \`implement show ${ref} --call ${planned.callId}\` prints it`;
  }
  impl = impl!;
  if ("error" in planned) return await stuck(db, impl, planned.error);
  if (reset) return await stuck(db, impl, `the workspace tree could not be reset after the plan: ${reset}`);

  const g = await guardItem(db, { repo: o.repo, number: o.number }, { kind: "implement", bucket: "plan" }, byOfJob(ctx.job.requestedBy));
  const state = await recordPlan(db, impl, planned, {
    commentsApproved: await commentApprovalOf(db, o.repo) !== null && !("refused" in g),
    postComment: async (text) => {
      if ("refused" in g) throw new Error(g.refused);
      const r = await ghComment({ db, login: IMPLEMENT_ASKER }, g, exec, "implement-question", { repo: o.repo, number: o.number, pr: false }, { by: "model", kind: "comment", model: PROMPT.models[0] }, text, { call: planned.callId });
      if (r.code !== 0) throw new Error(`the question comment failed: ${r.stderr.replace(/\s+/g, " ").slice(0, 200)}`);
      return /#issuecomment-(\d+)/.exec(r.stdout)?.[1] ?? null;
    },
    log: ctx.log,
  });
  ctx.acted(1);
  const rounds = (await roundsOf(db, impl.id)).filter((x) => x.kind === "plan").length;
  return `${ref}: plan round ${rounds}: ${state === "planned" ? "planned" : "asked"} (call ${planned.callId}, size ${planned.reply.size})`;
}

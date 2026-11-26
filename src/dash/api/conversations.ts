// Opus conversations on items. Everyone who may see the repo reads them. Operators write to Opus, and so do maintainers with
// write access to the repo, whose messages run on their own Task Runners.
import type { Conversation, ConversationCard, ConversationTurn } from "../../../web/src/api/types.ts";
import { actionRefusal, buttonLabel, cardEffect, cardLines, cardRepos, commandText, followupsOf, headline, isRegistry, readParams, type CardParams } from "../../conversations/cards.ts";
import { queueReason } from "../../conversations/queue.ts";
import { cardDigest, isStaleRunning, sweepRunningCards, type CardRow } from "../../conversations/act.ts";
import { addMessage, loadStale, withdrawTurn, type Stale, type StoreDeps } from "../../conversations/store.ts";
import { ConversationError, loadQueue, loadThreads, type Queue, type Thread } from "../../data/conversations/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req, User } from "../types.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { listWorkflows } from "../../data/workflow/index.ts";
import { needVisible } from "./visible.ts";
import { PERM_READ_TTL } from "../server/sessions.ts";
import { githubIdentity } from "../../github/identity.ts";
import { canActMany, permKey } from "../../data/access/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { tierOfModel } from "../../remote/mode.ts";
import { CLAUDE_PROMPTS } from "../../prompts/index.ts";
import { isEnabled, pauseReason } from "../../runner/autopilot.ts";
import { ownTaker } from "../../remote/takers.ts";

const CONVERSATION_PROMPT_ID = "conversation.turn";
/** The step that answers maintainers' messages (src/runner/steps.ts). */
const MAINTAINER_STEP = "conversation-maintainer";

const isOperator = (req: Req): boolean => req.user.role === "operator";

/**
 * Whether the user may write to Opus on an item of `repo`: an operator, or a maintainer with write permission on the repo, read
 * live as the act rule reads it. A maintainer's turn runs on their own Task Runner. Talking writes nothing to GitHub, so the act
 * rule's app-identity condition does not apply.
 */
export async function canTalk(db: Db, user: Pick<User, "role" | "canWrite">, repo: string): Promise<boolean> {
  if (user.role === "operator") return true;
  return await mayRunRepo(user, repo);
}

/** The refusal of a maintainer's message to Opus while none of their Task Runners may take it (src/remote/takers.ts). */
export const NO_OWN_RUNNER = "Your Task Runner must be connected and ready to ask Opus. You can still post without Opus.";

async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ConversationError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Without `canWrite` the stored permissions count as they are. */
type Viewer = { login: string; role: string; canWrite?: (repo: string) => Promise<boolean> };
const refOf = (x: { repo: string; number: number }): string => `${x.repo}#${x.number}`;
/** What the views of several cards share. */
type CardsView = {
  queue: Queue; stale: Map<number, Stale>;
  /** Items ("repo#n") whose pull request is quiet, and when each item's live recommendation was written. */
  quiet: ReadonlySet<string>; recAt: Map<string, string | null>;
  /** The repos of the cards the viewer may act on. */
  mayAct: ReadonlySet<string>;
};

/**
 * The repos of `cards` the viewer may act on by the act rule. A permission too old to count is read from GitHub first, so the buttons
 * do not go when the stored one ages; an operator keeps them when GitHub does not answer. Each press checks live.
 */
async function mayActOn(db: Db, cards: CardRow[], who: Viewer | undefined): Promise<Set<string>> {
  const repos = [...new Set(cards.flatMap((c) => { const p = readParams(c.kind, c.params); return p ? cardRepos(c.repo, p) : []; }))];
  if (!who || (who.role !== "operator" && who.role !== "maintainer") || !repos.length) return new Set();
  if (who.canWrite) await Promise.all(repos.map((r) => who.canWrite!(r).catch(() => false)));
  const identity = await githubIdentity(db);
  const verdicts = await canActMany(db, repos.map((repo) => ({ login: who.login, repo })), { identity, mode: "cached", maxAgeMs: PERM_READ_TTL });
  return new Set(repos.filter((repo) => {
    const v = verdicts.get(permKey(who.login, repo));
    return v?.ok === true || (who.role === "operator" && identity === "app" && v?.ok === false && v.why === "stale");
  }));
}

const cardsView = async (db: Db, cards: CardRow[], who?: Viewer): Promise<CardsView> => {
  const proposed = cards.filter((c) => c.state === "proposed");
  const keys = [...new Set(proposed.map(refOf))];
  const refs = [...new Map(proposed.map((c) => [refOf(c), { repo: c.repo, number: c.number }])).values()];
  const [queue, stale, quiet, flows, mayAct] = await Promise.all([
    loadQueue(db), loadStale(db, proposed), keys.length ? loadQuiet(db, keys) : [], refs.length ? listWorkflows(db, { live: true, refs }) : [], mayActOn(db, cards, who),
  ]);
  return { queue, stale, mayAct, quiet: new Set(quiet), recAt: new Map(flows.map((w) => [refOf(w), w.recAt])) };
};

/** One card's view. A card of the retired decision system shows its stored line and its result only. */
export const cardView = async (db: Db, c: CardRow, who?: Viewer): Promise<ConversationCard> => viewOf(c, await cardsView(db, [c], who));

function viewOf(c: CardRow, v: CardsView): ConversationCard {
  const params = readParams(c.kind, c.params);
  const effect = params ? cardEffect(params) : null;
  const issue = params ? issueOf(params) : undefined;
  const command = params ? commandText(params) : undefined;
  const refusal = params && c.state === "proposed" ? actionRefusal(params, { quiet: v.quiet.has(refOf(c)), recAt: v.recAt.get(refOf(c)) ?? null }) : null;
  const stale = c.state === "proposed" ? v.stale.get(c.id) : undefined;
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  const preview = c.text && one(c.text) ? `Comment: ${one(c.text)}` : issue ? `Issue: ${one(issue.title)}` : undefined;
  const repos = params ? cardRepos(c.repo, params) : [];
  const place = c.state === "queued" ? v.queue.rows.find((r) => r.id === c.id)?.place ?? null : null;
  return {
    steps: params ? cardLines(params) : [c.description],
    ...(command !== undefined && { command }),
    ...(refusal && { refusal }),
    ...(stale && { stale }),
    label: params ? buttonLabel(params) : c.description,
    headline: params ? headline(params) : c.description,
    ...(preview && { preview }),
    canSettle: repos.length > 0 && repos.every((r) => v.mayAct.has(r)),
    id: c.id, kind: params?.kind ?? "comment", title: c.description, state: c.state as ConversationCard["state"], digest: cardDigest(c),
    ...(c.text !== null && { text: c.text }),
    ...(effect && { writes: effect }),
    ...(c.state === "done" && { done: { at: c.acted_at ?? "", link: c.result_url ?? "", label: c.result ?? "Done" } }),
    ...(c.state === "failed" && c.error && { error: c.error }),
    ...(c.state === "queued" && { queued: { place, reason: queueReason(place) } }),
    ...(c.acted_by && { by: c.acted_by }),
    ...(c.acted_at && { at: c.acted_at }),
    ...(c.edited_by && { edited: true, editedBy: c.edited_by }),
  };
}

/** The issue draft a card carries: the first a merge holds, or the one it would open. */
function issueOf(p: CardParams): { title: string } | undefined {
  return followupsOf(p)[0] ?? (p.kind === "command" && !isRegistry(p.command) && p.command.word === "open_issue" ? p.command : undefined);
}

export type ConversationView = Conversation;

async function threadView(db: Db, repo: string, n: number, who?: Viewer): Promise<{ thread: Thread | undefined; view: Omit<ConversationView, "canTalk" | "canWithdraw"> }> {
  const key = `${repo}#${n}`;
  let thread = (await loadThreads(db, [key])).get(key);
  // A card left Running by a crash must not show as running until the next restart.
  if (thread?.cards.some((c) => isStaleRunning(c))) {
    await sweepRunningCards(db);
    thread = (await loadThreads(db, [key])).get(key);
  }
  if (!thread) return { thread, view: { repo, number: n, exists: false, pending: false, startedBy: null, turns: [] } };
  const shared = await cardsView(db, thread.cards, who);
  const actions = new Map<number, ConversationCard[]>();
  const views = thread.cards.map((c) => viewOf(c, shared));
  for (const [i, c] of thread.cards.entries()) (actions.get(c.turn_id) ?? actions.set(c.turn_id, []).get(c.turn_id)!).push(views[i]!);
  const turns: ConversationTurn[] = thread.turns.map((t) => ({
    id: t.id, kind: t.kind, login: t.login, at: t.at, body: t.body,
    actions: actions.get(t.id) ?? [],
    notes: t.notes ? (JSON.parse(t.notes) as string[]) : [],
    ...(t.status && { status: t.status as ConversationTurn["status"] }),
    ...(t.error && { error: t.error }),
  }));
  const wait = thread.waiting;
  const progress = wait?.status === "answering" && wait.progress ? (JSON.parse(wait.progress) as string[]) : [];
  return { thread, view: { repo, number: n, exists: true, pending: !!wait, ...(progress.length > 0 && { progress }), startedBy: thread.conversation.created_by, turns } };
}

export const conversationView = async (db: Db, repo: string, n: number, who?: Viewer): Promise<Omit<ConversationView, "canTalk" | "canWithdraw">> => (await threadView(db, repo, n, who)).view;

function itemOf(req: Req): { repo: string; n: number } {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "the item number must be a whole number");
  return { repo: req.params.repo!, n };
}

function text(req: Req): string {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b) || typeof (b as { text?: unknown }).text !== "string") throw new HttpError(400, "the body must be an object with a text");
  return (b as { text: string }).text;
}

/** `ask: false` stores the message without asking Opus. */
function ask(req: Req): boolean {
  const a = (req.json as { ask?: unknown } | null)?.ask;
  if (a !== undefined && typeof a !== "boolean") throw new HttpError(400, "ask must be true or false");
  return a !== false;
}

/** The conversation as the requester sees it, with whether they may write to Opus and withdraw the maintainer's message that waits. */
async function viewFor(db: Db, req: Req, repo: string, n: number): Promise<ConversationView> {
  const [{ thread, view }, may] = await Promise.all([threadView(db, repo, n, req.user), canTalk(db, req.user, repo)]);
  const wait = thread?.waiting;
  const canWithdraw = wait?.kind === "maintainer" && (isOperator(req) || wait.login.toLowerCase() === req.user.login.toLowerCase());
  return { ...view, canTalk: may, canWithdraw };
}

/** Why a maintainer's message to Opus would not be answered now, or null: the pipeline is off or draining, its step is paused, or none of their Task Runners is ready. */
async function ownAskRefusal(db: Db, login: string, repo: string): Promise<string | null> {
  if (!await isEnabled(db)) return "The pipeline is off, so Opus cannot answer now. You can still post without Opus.";
  const paused = await pauseReason(db, MAINTAINER_STEP, Date.now(), { backoff: false });
  if (paused) return `Opus cannot answer now: ${paused}. You can still post without Opus.`;
  return await ownTaker(db, login, { prompt_id: CONVERSATION_PROMPT_ID, repos: [repo], tier: tierOfModel(CLAUDE_PROMPTS[CONVERSATION_PROMPT_ID].models[0]!) }) ? null : NO_OWN_RUNNER;
}

/** A message to Opus, or with `ask: false` a post without asking. A maintainer's asked message runs on their own Task Runner, so it is refused while it would not be answered (ownAskRefusal). */
export async function postMessage(db: Db, req: Req, deps?: StoreDeps): Promise<ConversationView> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  if (!await canTalk(db, req.user, repo)) throw new HttpError(403, "only operators, and maintainers with write access to the repository, write in conversations");
  const kind = isOperator(req) ? "operator" : "maintainer", asking = ask(req), body = text(req);
  const refused = kind === "maintainer" && asking ? await ownAskRefusal(db, req.user.login, repo) : null;
  if (refused) throw new HttpError(409, refused);
  await guard(() => addMessage(db, repo, n, { login: req.user.login, kind }, body, deps, asking));
  return await viewFor(db, req, repo, n);
}

/** Questions a person may put to Opus per hour and per day. */
export const ASK_LIMITS = { hour: 10, day: 50 } as const;

/** Throws 429 when the user has put ASK_LIMITS questions to Opus in the last hour or day. */
export async function assertAskRate(db: Db, login: string): Promise<void> {
  const q = queryDb(db);
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const count = async (ms: number) => Number((await q.get(q.k.selectFrom("main.conversation_turns").select((eb) => eb.fn.countAll().as("n"))
    .where("login", "=", login).where("kind", "in", ["operator", "maintainer"]).where("at", ">", since(ms))))?.n ?? 0);
  if (await count(3_600_000) >= ASK_LIMITS.hour || await count(86_400_000) >= ASK_LIMITS.day) throw new HttpError(429, "Too many questions to Opus. Try again later.");
}

/**
 * Puts a question to Opus on the sender's own runner, as postMessage does, for a message the chat has stored already. Returns the
 * turn it created, or why the question was not asked (the message stays in the chat): a maintainer's refusal (ownAskRefusal) or an
 * open question that Opus has not answered.
 */
export async function askOpus(db: Db, req: Req, repo: string, n: number, body: string, deps?: StoreDeps): Promise<{ turnId: number } | { refusal: string }> {
  const refused = isOperator(req) ? null : await ownAskRefusal(db, req.user.login, repo);
  if (refused) return { refusal: refused };
  try {
    return { turnId: await addMessage(db, repo, n, { login: req.user.login, kind: isOperator(req) ? "operator" : "maintainer" }, body, deps, true) };
  } catch (e) {
    if (e instanceof ConversationError && e.status === 409) return { refusal: e.message };
    throw e;
  }
}

/** Withdraws the maintainer's message that waits for Opus: an operator, or the maintainer who wrote it, so an item is never held by a message no runner takes. */
export async function postWithdraw(db: Db, req: Req): Promise<ConversationView> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  await withdrawMessage(db, req, repo, n);
  return await viewFor(db, req, repo, n);
}

/** Withdraws the message on the item that waits for Opus, as the reader: an operator, or the person who wrote it. */
export async function withdrawMessage(db: Db, req: Req, repo: string, n: number): Promise<void> {
  await guard(async () => await withdrawTurn(db, repo, n, { login: req.user.login, operator: isOperator(req) }));
}

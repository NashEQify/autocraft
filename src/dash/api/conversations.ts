// Opus conversations on items. Everyone who may see the repo reads them. Operators write to Opus, and so do maintainers with
// write access to the repo, whose messages run on their own Task Runners; cards are run, edited and dismissed by those who settle.
import type { Conversation, ConversationCard, ConversationTurn } from "../../../web/src/api/types.ts";
import { actionRefusal, buttonLabel, cardEffect, cardLines, cardRepos, commandText, followupsOf, headline, isRegistry, readParams, type CardParams } from "../../conversations/cards.ts";
import { queueReason } from "../../conversations/queue.ts";
import { cardDigest, cardOf, dismissCard, doCard, editCard, sweepRunningCards, type ActDeps, type CardRow } from "../../conversations/act.ts";
import { addMessage, loadStale, withdrawTurn, type Stale, type StoreDeps } from "../../conversations/store.ts";
import { ConversationError, loadQueue, loadThreads, type Queue, type Thread } from "../../data/conversations/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req, User } from "../types.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { listWorkflows } from "../../data/workflow/index.ts";
import { canSeeInternals } from "./staff.ts";
import { needVisible } from "./visible.ts";
import { PERM_READ_TTL } from "../server/sessions.ts";
import { actRefusal, githubIdentity } from "../../github/identity.ts";
import { canActMany, permKey } from "../../data/access/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Db } from "../../db/index.ts";
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

type Viewer = { login: string; role: string };
const refOf = (x: { repo: string; number: number }): string => `${x.repo}#${x.number}`;
/** What the views of several cards share. */
type CardsView = {
  queue: Queue; stale: Map<number, Stale>;
  /** Items ("repo#n") whose pull request is quiet, and when each item's live recommendation was written. */
  quiet: ReadonlySet<string>; recAt: Map<string, string | null>;
};

/** Whether `login` may act on every one of `repos` by the act rule, from cached write permissions. */
async function mayAct(db: Db, login: string, repos: string[]): Promise<boolean> {
  if (!repos.length) return false;
  const verdicts = await canActMany(db, repos.map((repo) => ({ login, repo })), { identity: await githubIdentity(db), mode: "cached", maxAgeMs: PERM_READ_TTL });
  return repos.every((repo) => verdicts.get(permKey(login, repo))?.ok === true);
}

const cardsView = async (db: Db, cards: CardRow[]): Promise<CardsView> => {
  const proposed = cards.filter((c) => c.state === "proposed");
  const keys = [...new Set(proposed.map(refOf))];
  const refs = [...new Map(proposed.map((c) => [refOf(c), { repo: c.repo, number: c.number }])).values()];
  const [queue, stale, quiet, flows] = await Promise.all([
    loadQueue(db), loadStale(db, proposed), keys.length ? loadQuiet(db, keys) : [], refs.length ? listWorkflows(db, { live: true, refs }) : [],
  ]);
  return { queue, stale, quiet: new Set(quiet), recAt: new Map(flows.map((w) => [refOf(w), w.recAt])) };
};

/** One card's view. A card of the retired decision system shows its stored line and its result only. */
export const cardView = async (db: Db, c: CardRow, who?: Viewer): Promise<ConversationCard> => await viewOf(db, c, await cardsView(db, [c]), who);

/** `who`: the viewer, for the card's `canSettle` (an operator, or a maintainer from cached permissions). */
async function viewOf(db: Db, c: CardRow, v: CardsView, who?: Viewer): Promise<ConversationCard> {
  const params = readParams(c.kind, c.params);
  const effect = params ? cardEffect(params) : null;
  const issue = params ? issueOf(params) : undefined;
  const command = params ? commandText(params) : undefined;
  const refusal = params && c.state === "proposed" ? actionRefusal(params, { quiet: v.quiet.has(refOf(c)), recAt: v.recAt.get(refOf(c)) ?? null }) : null;
  const stale = c.state === "proposed" ? v.stale.get(c.id) : undefined;
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  const preview = c.text && one(c.text) ? `Comment: ${one(c.text)}` : issue ? `Issue: ${one(issue.title)}` : undefined;
  const place = c.state === "queued" ? v.queue.rows.find((r) => r.id === c.id)?.place ?? null : null;
  return {
    steps: params ? cardLines(params) : [c.description],
    ...(command !== undefined && { command }),
    ...(refusal && { refusal }),
    ...(stale && { stale }),
    label: params ? buttonLabel(params) : c.description,
    headline: params ? headline(params) : c.description,
    ...(preview && { preview }),
    canSettle: !!who && params !== null && await mayAct(db, who.login, cardRepos(c.repo, params)),
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
  // A card left Running by a crash must not show as running until the next restart.
  await sweepRunningCards(db);
  const key = `${repo}#${n}`;
  const thread = (await loadThreads(db, [key])).get(key);
  if (!thread) return { thread, view: { repo, number: n, exists: false, pending: false, startedBy: null, turns: [] } };
  const shared = await cardsView(db, thread.cards);
  const actions = new Map<number, ConversationCard[]>();
  for (const c of thread.cards) (actions.get(c.turn_id) ?? actions.set(c.turn_id, []).get(c.turn_id)!).push(await viewOf(db, c, shared, who));
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
  const { thread, view } = await threadView(db, repo, n, req.user);
  const wait = thread?.waiting;
  const canWithdraw = wait?.kind === "maintainer" && (isOperator(req) || wait.login.toLowerCase() === req.user.login.toLowerCase());
  return { ...view, canTalk: await canTalk(db, req.user, repo), canWithdraw };
}

export async function getConversation(db: Db, req: Req): Promise<ConversationView> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  const view = await viewFor(db, req, repo, n);
  return !canSeeInternals(req) && (await loadQuiet(db, [`${repo}#${n}`])).size > 0 ? veilConversation(view) : view;
}

/** A viewer's copy of a quiet pull request's conversation: who spoke and when stays; the text, and cards go. */
function veilConversation(v: ConversationView): ConversationView {
  const { progress: _p, ...rest } = v;
  return { ...rest, turns: v.turns.map((t) => ({ id: t.id, kind: t.kind, login: t.login, at: t.at, body: "", actions: [], notes: [], ...(t.status && { status: t.status }) })) };
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

/** Withdraws the maintainer's message that waits for Opus: an operator, or the maintainer who wrote it, so an item is never held by a message no runner takes. */
export async function postWithdraw(db: Db, req: Req): Promise<ConversationView> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  await guard(async () => await withdrawTurn(db, repo, n, { login: req.user.login, operator: isOperator(req) }));
  return await viewFor(db, req, repo, n);
}

/** The card, for someone who settles it on every repo it writes to (the act rule: an AutoCraft login with write access). */
async function needCard(db: Db, req: Req): Promise<CardRow> {
  const id = Number(req.params.id);
  const c = Number.isInteger(id) ? await cardOf(db, id) : undefined;
  if (!c) throw new HttpError(404, `no card ${req.params.id}`);
  await needVisible(db, req, c.repo);
  for (const repo of cardRepos(c.repo, readParams(c.kind, c.params))) {
    if (await actRefusal(db, req.user, repo)) throw new HttpError(403, "only an operator, or a maintainer with write access where the app acts for them, runs cards");
  }
  return c;
}

export async function editCardText(db: Db, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  const edit = text(req);
  return await cardView(db, await guard(async () => await editCard(db, c.id, req.user.login, { text: edit })), req.user);
}

/** A queued press is the presser's: only they and operators dismiss it. */
function ownsPress(req: Req, c: CardRow): boolean {
  return isOperator(req) || c.acted_by?.toLowerCase() === req.user.login.toLowerCase();
}

export async function dismiss(db: Db, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  if (c.state === "queued" && !ownsPress(req, c)) throw new HttpError(403, "only the person who pressed it, or an operator, dismisses a queued press");
  return await cardView(db, await guard(async () => await dismissCard(db, c.id, req.user.login, { role: req.user.role })), req.user);
}

/**
 * Runs the card once; a second press returns the card as it is. The press carries the digest of the card it was made on,
 * so an edit by someone else in between is refused instead of running under this press.
 */
export async function doIt(db: Db, req: Req, deps?: ActDeps): Promise<ConversationCard> {
  const c = await needCard(db, req);
  const b = req.json as { skip?: unknown; note?: unknown; digest?: unknown } | null;
  if (typeof b?.digest !== "string") throw new HttpError(400, "digest must be the digest of the card as shown");
  if (c.state === "proposed" && b.digest !== cardDigest(c)) throw new HttpError(409, c.edited_by ? `the card changed since it was shown (edited by ${c.edited_by}); look at it again` : "the card changed since it was shown; look at it again");
  if (b?.note !== undefined && typeof b.note !== "string") throw new HttpError(400, "note must be a string");
  if (b?.skip !== undefined && !(Array.isArray(b.skip) && b.skip.length === 0)) throw new HttpError(400, "a card does one thing: it has no steps to skip");
  return await cardView(db, (await guard(() => doCard(db, c.id, req.user.login, { ...deps, via: "dashboard", note: b?.note as string | undefined, noteStaysOut: !isOperator(req), role: req.user.role, canWrite: (r) => req.user.canWrite(r) }))).card, req.user);
}

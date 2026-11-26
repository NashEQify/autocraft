// GET /api/items/:repo/:n/chat: an item's conversations with AutoCraft. What people said (from any surface) and AutoCraft's replies
// come from the chat messages, the workflow events they produced and the Opus turns; the work AutoCraft did, the GitHub activity and the
// Discord mentions come from the item trace (trace.ts), GitHub and Discord folded into one line per run between two other entries.
// A fixed number of set-based reads per request: the stamp's wave, then the trace, the thread and the merge leg's wait.
import type { ChatDiscordLink, ChatEntry, ChatFinding, ChatShot, ChatVia, ItemChat, ItemChatState, ItemChatUnchanged, ItemConversation } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { loadArtifacts } from "../../data/build/index.ts";
import { loadConversationsOfItem, loadMessages, type ChatMessageRow, type ConversationRow } from "../../data/chat/index.ts";
import { loadThreads } from "../../data/conversations/index.ts";
import { loadScreenshotRuns } from "../../data/merge/index.ts";
import type { CardRow, ThreadTurn } from "../../data/conversations/types.ts";
import { loadItemTraceStamp, type ItemTraceRows } from "../../data/views/trace.ts";
import { loadLegs, loadWorkflowHistory } from "../../data/workflow/index.ts";
import type { StoredEvent } from "../../data/workflow/types.ts";
import { commentDatabaseId } from "../../data/conversations/statements.ts";
import { t } from "../../i18n/index.ts";
import { askedLogins } from "../../workflow/asked.ts";
import { yesClause, yesNext } from "../../workflow/status.ts";
import { ENTRY_LABEL } from "../../workflow/vocab.ts";
import { legWait } from "../../workflow/waits.ts";
import { openRecommendation, shownWorkflow, type ItemWorkflow, type PlanPart, type Recommendation } from "../../workflow/types.ts";
import type { Req } from "../types.ts";
import { canTalk } from "./conversations.ts";
import { discordKeys, type ItemMention } from "./discord.ts";
import { statusOf } from "./maintain-item.ts";
import { clip, context, contextScope, eventsFrom, fingerprint, headerOf, loadTraceRows, shape, visibleItem, type Ctx, type Ev } from "./trace.ts";
import { blankIfHidden } from "./visible.ts";

/** A folded GitHub line keeps this many of its events. */
export const FOLD_KEEP = 5;
/** Trace kinds that are AutoCraft's work in the chat; plans, jobs, commands and turns are told elsewhere or stay in Events. */
const WORK_KINDS = new Set(["model-call", "check", "review", "write", "step"]);
const WAITING = new Set(["pending", "answering"]);
const MAIN = "main";

/** What the stamp and the answer both need, read once. */
type Base = { c: Ctx; convs: ConversationRow[]; messages: Map<number, ChatMessageRow[]>; history: ItemWorkflow[]; leg: { workflowId: number | null; state: string } | null; canReply: boolean; stamp: string };

async function base(db: Db, req: Req): Promise<Base> {
  const ref = await visibleItem(db, req);
  const key = `${ref.repo}#${ref.number}`;
  // Read alongside the context, which decides whether they count (an item the mirror lacks is a 404).
  const reads = Promise.all([
    contextScope(db, req).then((s) => loadItemTraceStamp(db, s, ref)),
    loadConversationsOfItem(db, ref.repo, ref.number).then(async (convs) => ({ convs, messages: await loadMessages(db, convs.map((x) => x.id)) })),
    loadWorkflowHistory(db, [ref]), loadLegs(db, [ref], { latestOnly: true }),
    canTalk(db, req.user, ref.repo),
  ]);
  void reads.catch(() => {});
  const c = await context(db, req);
  const [sources, { convs, messages }, histories, legs, canReply] = await reads;
  const history = histories.get(key) ?? [];
  const legRow = legs.get(key)?.[0];
  const leg = legRow ? { workflowId: legRow.workflow_id, state: legRow.state } : null;
  const said = [...messages.values()].flat().map((m) => [m.id, m.at, m.workflowEventId, m.turnId]);
  const stamp = fingerprint(c, JSON.stringify(["chat", c.veiled, canReply, discordKeys() !== null]), [...sources, convs.map((x) => [x.id, x.title]), said, history, leg]);
  return { c, convs, messages, history, leg, canReply, stamp };
}

export async function itemChat(db: Db, req: Req): Promise<ItemChat | ItemChatUnchanged> {
  const b = await base(db, req);
  if (req.query.get("since") === b.stamp) return { unchanged: true, stamp: b.stamp };
  return await chatFrom(db, b);
}

/** The chat as the requester sees it now, without the `since` check. */
export async function readChat(db: Db, req: Req): Promise<ItemChat> {
  return await chatFrom(db, await base(db, req));
}

async function chatFrom(db: Db, b: Base): Promise<ItemChat> {
  const { c } = b;
  const wf = shownWorkflow(b.history);
  const [rows, threads, wait, shots] = await Promise.all([
    loadTraceRows(c), loadThreads(db, [c.ref]), wf ? legWait(db, wf) : Promise.resolve(null), c.staff && !c.veiled ? shotsOf(db, c) : Promise.resolve(new Map<string, ChatShot[]>()),
  ]);
  // The chat veils by entry (who and when stay), so it reads the unveiled events and strips what a viewer may not read itself.
  const events = shape({ ...c, veiled: false }, eventsFrom({ ...c, veiled: false }, rows), null);
  const thread = threads.get(c.ref);
  const header = headerOf(c, rows);
  const head = headerFor(c, wf, rows, b.leg, wait, header.now.state === null ? t("Not planned yet") : header.now.text);
  const mainId = b.convs[0]?.id ?? null;
  const conversations = (b.convs.length ? b.convs : [null]).map((row): ItemConversation => {
    const main = row === null || row.id === mainId;
    const entries = entriesOf(c, {
      messages: row ? b.messages.get(row.id) ?? [] : [],
      workflowEvents: rows.workflowEvents, workflows: b.history,
      turns: (thread?.turns ?? []).filter((x) => turnConversation(x) === (row?.id ?? null) || (main && turnConversation(x) === null)),
      cards: thread?.cards ?? [],
      events: main ? events : [], mentions: main ? rows.discord : [], shots,
    });
    const running = main ? [...entries].reverse().find((e) => e.t === "work" && e.state === "running") : undefined;
    return {
      id: row ? String(row.id) : MAIN,
      title: row?.title || (wf ? t(ENTRY_LABEL[wf.entry]) : t("Conversation")),
      item: { repo: c.repo, number: c.n },
      entries,
      open: main ? openOf(c, wf) : null,
      canReply: b.canReply,
      working: running?.t === "work" ? running.title : null,
    };
  });
  return { repo: c.repo, number: c.n, stamp: b.stamp, ...head, conversations };
}

/** The conversation a turn belongs to, once turns carry it; null before. */
const turnConversation = (x: ThreadTurn): number | null => {
  const id = (x as { conversation_id?: unknown }).conversation_id;
  return id === null || id === undefined ? null : Number(id);
};

// ---- header ------------------------------------------------------------------------------------------------------------------

const STATE: Record<ItemWorkflow["state"], ItemChatState> = {
  running: "running", waiting: "running", recommending: "waiting", blocked: "waiting", stopped: "held", done: "done", closed: "done", backlog: "idle", superseded: "idle",
};

/** The header line, its state and what follows: the item page's status for a started item, the planner's line for one nobody started. */
function headerFor(c: Ctx, wf: ItemWorkflow | null, rows: ItemTraceRows, leg: Base["leg"], wait: string | null, planLine: string): Pick<ItemChat, "status" | "state" | "next"> {
  if (!wf) return { status: c.veiled ? rows.header.plan?.state ?? t("Not planned yet") : planLine, state: "idle", next: null };
  const events = rows.workflowEvents.filter((e) => e.kind !== "archived");
  const s = statusOf(wf, events, leg && leg.workflowId === wf.id ? leg.state : null, c.veiled, wait);
  const steps = s.steps ?? [];
  const at = steps.findIndex((x) => x.state === "running" || x.state === "waiting" || x.state === "stopped");
  // While the item waits for an answer, what follows is what a yes runs.
  const rec = STATE[wf.state] === "waiting" ? openRecommendation(wf) : null;
  const yes = rec ? yesNext(rec) : null;
  return { status: s.headline, state: STATE[wf.state], next: yes ?? (at >= 0 ? steps[at + 1]?.label ?? null : null) };
}

const question = (rec: Recommendation): string => yesClause(rec) ?? t("Reply yes, or write what to do instead.");

/** The open question of the item's workflow and who it asks; none for a workflow that asks nobody (the automatic merge rule's). */
function openOf(c: Ctx, wf: ItemWorkflow | null): ItemConversation["open"] {
  const rec = openRecommendation(wf);
  const to = wf ? askedLogins(wf) : [];
  return rec && to.length ? { to, question: c.veiled ? "" : question(rec) } : null;
}

// ---- entries -----------------------------------------------------------------------------------------------------------------

type Sources = {
  messages: ChatMessageRow[]; workflowEvents: StoredEvent[]; workflows: ItemWorkflow[]; turns: ThreadTurn[]; cards: CardRow[];
  events: Ev[]; mentions: ItemMention[]; shots: Map<string, ChatShot[]>;
};
/** One element of the timeline before folding: a chat entry, or an event that folds into a GitHub or Discord line. */
type Part = { at: string; rank: number; key: string } & ({ entry: ChatEntry } | { gh: Ev } | { dc: ItemMention });

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const VIA: Record<string, ChatVia> = { dashboard: "dashboard", github: "github", discord: "discord", agent: "agent", cli: "cli" };

/**
 * The entries of one conversation, oldest first. GitHub events not addressed to AutoCraft, and Discord mentions, between two other
 * entries fold into one line each; a GitHub line keeps its last FOLD_KEEP events and counts all of them.
 */
export function entriesOf(c: Ctx, s: Sources): ChatEntry[] {
  const parts: Part[] = [];
  const hide = (text: string): string => (c.veiled ? "" : blankIfHidden(text, c.hidden));
  const eventById = new Map(s.workflowEvents.map((e) => [e.id, e]));
  const turnById = new Map(s.turns.map((x) => [x.id, x]));
  const saidComments = new Set<string>();
  const discordCommands = new Set<string>();

  for (const m of s.messages) {
    const p = obj(m.payload);
    if (m.kind === "said" && m.via !== "autocraft") {
      if (m.githubCommentId !== null) saidComments.add(String(m.githubCommentId));
      const hash = str(p.msgHash);
      if (hash) discordCommands.add(hash);
      const turn = m.turnId !== null ? turnById.get(m.turnId) : undefined;
      const refusal = str(p.refusal) ?? (turn?.status === "failed" ? t("Opus could not answer this message.") : null);
      parts.push({ at: m.at, rank: 0, key: `msg:${m.id}`, entry: {
        t: "said", id: `msg:${m.id}`, at: m.at, login: m.author, via: VIA[m.via] ?? "dashboard", body: c.veiled ? "" : m.body, url: str(p.url),
        ...(turn && WAITING.has(turn.status ?? "") ? { pending: true } : {}), ...(refusal ? { refusal: c.veiled ? "" : refusal } : {}),
      } });
      const ev = m.workflowEventId !== null ? eventById.get(m.workflowEventId) : undefined;
      if (ev?.line) parts.push({ at: ev.at < m.at ? m.at : ev.at, rank: 1, key: `workflow:${ev.id}`, entry: { t: "reply", id: `workflow:${ev.id}`, at: ev.at, body: hide(ev.line), findings: [], ask: null } });
      continue;
    }
    parts.push({ at: m.at, rank: 1, key: `msg:${m.id}`, entry: { t: "reply", id: `msg:${m.id}`, at: m.at, body: hide(m.body), ...recommended(c, m, s.workflows) } });
  }

  for (const x of s.turns) {
    if (x.kind !== "opus") continue;
    const cards = s.cards.filter((k) => Number(k.turn_id) === x.id).map((k) => `- ${k.description}`);
    const body = cards.length ? `${x.body}\n\n${cards.join("\n")}` : x.body;
    parts.push({ at: x.at, rank: 1, key: `turn:${x.id}`, entry: { t: "reply", id: `turn:${x.id}`, at: x.at, body: c.veiled ? "" : body, findings: [], ask: null } });
  }

  for (const e of s.events) {
    if (e.kind === "github") {
      if (e.actor.type === "step") continue;
      const comment = e.ref.commentId;
      if (comment && saidComments.has(commentDatabaseId(comment) ?? "")) continue;
      parts.push({ at: e.at, rank: 2, key: e.id, gh: e });
    } else if (WORK_KINDS.has(e.kind)) parts.push({ at: e.at, rank: 2, key: e.id, entry: workOf(c, e, s.shots.get(e.id)) });
  }
  for (const m of s.mentions) if (!discordCommands.has(m.msgHash)) parts.push({ at: m.at, rank: 2, key: `discord:${m.msgHash}`, dc: m });

  parts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  const out: ChatEntry[] = [];
  let gh: Extract<ChatEntry, { t: "github" }> | null = null;
  let dc: Extract<ChatEntry, { t: "discord" }> | null = null;
  for (const p of parts) {
    if ("gh" in p) {
      if (!gh) { gh = { t: "github", id: `github:${p.gh.id}`, at: p.gh.at, lines: [], count: 0, eventIds: [] }; out.push(gh); }
      gh.lines.push(githubLine(p.gh));
      gh.eventIds!.push(p.gh.id);
      gh.count = gh.lines.length;
    } else if ("dc" in p) {
      const link: ChatDiscordLink = { url: p.dc.url, at: p.dc.at, channel: p.dc.channel };
      if (!dc) { dc = { t: "discord", id: `discord:${p.dc.msgHash}`, at: p.dc.at, links: [] }; out.push(dc); }
      dc.links.push(link);
    } else {
      out.push(p.entry);
      gh = null;
      dc = null;
    }
  }
  for (const e of out) if (e.t === "github" && e.lines.length > FOLD_KEEP) { e.lines = e.lines.slice(-FOLD_KEEP); e.eventIds = e.eventIds!.slice(-FOLD_KEEP); }
  return out;
}

/** A recommendation's numbered findings and the question it asks, from the message's payload; nothing for an end line. */
function recommended(c: Ctx, m: ChatMessageRow, workflows: ItemWorkflow[]): { findings: ChatFinding[]; ask: { to: string[]; question: string } | null } {
  if (m.kind !== "recommended") return { findings: [], ask: null };
  const p = obj(m.payload);
  const parts = Array.isArray(p.parts) ? (p.parts as Partial<PlanPart>[]) : [];
  const findings = c.veiled ? [] : parts.filter((x) => typeof x.n === "number").map((x): ChatFinding => ({
    n: x.n!, title: blankIfHidden(x.title ?? "", c.hidden), file: x.file ?? null, major: x.major === true,
  }));
  const wf = workflows.find((w) => w.id === Number(p.workflowId));
  const rec = p.rec && typeof p.rec === "object" ? (p.rec as Recommendation) : null;
  const to = wf ? askedLogins(wf) : [];
  return { findings, ask: rec && to.length ? { to, question: c.veiled ? "" : question(rec) } : null };
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** One GitHub event as a line: who, and the comment's words or what happened. */
function githubLine(e: Ev): string {
  if (e.id.startsWith("gh:")) return e.summary;
  const body = e.body?.replace(/\s+/g, " ").trim();
  return body ? `${e.actor.name}: “${clip(body, 140)}”` : `${e.actor.name}: ${lowerFirst(e.summary)}`;
}

/** A work entry from a trace event: the part of its summary before the colon is the title, the rest the outcome. */
function workOf(c: Ctx, e: Ev, shots: ChatShot[] | undefined): ChatEntry {
  const colon = e.summary.indexOf(": ");
  const title = colon >= 0 ? e.summary.slice(0, colon) : e.summary;
  const outcome = colon >= 0 ? e.summary.slice(colon + 2) : null;
  const callState = e.call?.state;
  const state = callState === "running" || /^(running|queued|claimed)\b/.test(outcome ?? "") || /^Build task (queued|claimed|running)/.test(e.summary) ? "running"
    : callState === "failed" || /\bfailed\b|^exit \d/.test(outcome ?? "") ? "failed" : "done";
  const ended = e.call?.endedAt ? Date.parse(e.call.endedAt) : NaN;
  const seconds = Number.isNaN(ended) ? null : Math.max(0, Math.round((ended - Date.parse(e.at)) / 1000));
  const model = e.call?.model ?? (e.actor.type === "model" ? e.actor.name : null);
  return {
    t: "work", id: `work:${e.id}`, at: e.at, state, title, model, seconds,
    costUsd: c.veiled ? null : e.call?.costUsd ?? e.costUsd ?? null,
    outcome: c.veiled ? null : outcome,
    detail: c.veiled || !e.head ? [] : [[t("Commit"), e.head.slice(0, 7)]],
    eventId: e.id,
    ...(shots ? { shots } : {}),
  };
}

/**
 * The pictures of each screenshot run, keyed by the trace event of its head task: base then head per screen both tasks stored.
 * Staff only, as the screenshots were on the item page; the images are served by the task artifact route.
 */
async function shotsOf(db: Db, c: Ctx): Promise<Map<string, ChatShot[]>> {
  const runs = [...(await loadScreenshotRuns(db, [{ repo: c.repo, number: c.n }])).values()]
    .flatMap((r) => (r.headTaskId !== null && r.baseTaskId !== null ? [{ head: r.headTaskId, base: r.baseTaskId }] : []));
  const out = new Map<string, ChatShot[]>();
  if (!runs.length) return out;
  const artifacts = await loadArtifacts(db, runs.flatMap((r) => [r.base, r.head]), { contentType: "image/png" });
  const names = (id: number): string[] => (artifacts.get(id) ?? []).map((x) => x.name);
  for (const r of runs) {
    const before = new Set(names(r.base));
    const shots = names(r.head).filter((n) => before.has(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)).flatMap((name): ChatShot[] => [
      { label: t("{screen}, before", { screen: name }), taskId: r.base, name },
      { label: t("{screen}, after", { screen: name }), taskId: r.head, name },
    ]);
    if (shots.length) out.set(`task:${r.head}`, shots);
  }
  return out;
}

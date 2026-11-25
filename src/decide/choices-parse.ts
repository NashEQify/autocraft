// Reading the model's fenced `choices` block: every extra is checked with the step checkers, every core with its extras through
// compose and validateCard. What fails is dropped with a note; what survives is what `writeChoices` and `mergeChoices` store.
import { ownerOf, splitSlug } from "../owners.ts";
import { REFERENCE_LEAK } from "../review/opus-parse.ts";
import { writeEffect } from "../act/index.ts";
import { cleanReason } from "../act/templates.ts";
import { KEEP_IN_CORE } from "../core/rules.ts";
import { backlogHeldExpr, notOwnIntegrationExpr } from "../dupes/held.ts";
import { ALL_LABELS, isTypeLabel, sameLabel } from "../labels/set.ts";
import { inScopeExpr } from "../data/workflow/fragments.ts";
import { loadQuiet } from "../data/security/index.ts";
import { LOGIN } from "../access.ts";
import { cleanComment } from "../conversations/cards.ts";
import { CLOSE_REASONS, COMMENT_MAX, INSTRUCTIONS_MAX, ISSUE_TITLE_MAX, RESOLVE_MAX, type CloseReason } from "../conversations/types.ts";
import { findSeq, someSeq } from "../async-seq.ts";
import type { Expression, SqlBool } from "kysely";
import { getDecision, type Kind } from "../decisions.ts";
import { optionsOf, type DecisionRow } from "../decisions.ts";
import {
  addedCore, compose, coresFor, currentChoices, extraId, mergeChoices, MAX_ADDED_CORES, withIds, writeChoices, type Core,
} from "./choices.ts";
import { coreKey, type ChoicesBlockExtra, type ChoicesRow, type CoreKey, type ExtraKind, type StoredDraft } from "./choices-types.ts";
import { cardsToDrafts } from "./choices-convert.ts";
import { PREPARE_REASON_MAX } from "./prepare-types.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** A validated `choices` block: what a prepare writes whole and a conversation turn merges. */
export interface ParsedChoices {
  pick: { core: CoreKey | null; reason: string | null };
  /** Each core the reply drafted, by key. */
  cores: Record<CoreKey, { params?: StoredDraft["params"]; extras: ChoicesBlockExtra[] }>;
  /** Cores the reply adds. */
  add: { key: CoreKey; draft: { params?: StoredDraft["params"]; extras: ChoicesBlockExtra[] } }[];
  /** Added cores the reply removes. */
  drop: CoreKey[];
}

export interface ChoicesReply {
  /** The reply's text before the block. */
  text: string;
  /** Null: the reply has no block, or it is unusable (see `notes`). */
  choices: ParsedChoices | null;
  /** The question to the author as a proposed comment card, when the block has a valid `ask`. */
  ask: NewCard | null;
  notes: string[];
  /** The pick's core when it was dropped or does not exist; asks for a repeat. */
  pickLost: CoreKey | null;
  /** The reply has a choices block (valid or not). */
  hasBlock: boolean;
}

const FENCE = /```choices[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;
const MAX_EXTRAS = 8;
const KINDS: ExtraKind[] = ["comment", "open_issue", "label", "unlabel", "assign", "request_reviewers"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plain = (note: string): string => note.replace(/^dropped (a resolution|a card)[: ]*/, "");

function blockOf(reply: string): { text: string; json: string | null } {
  const t = reply.trimEnd(), m = FENCE.exec(t);
  return { text: (m ? t.slice(0, m.index) : reply).trim(), json: m ? m[1]! : null };
}

/** One drafted extra checked with its step checker, or why it is dropped. */
async function checkExtra(db: Db, repo: string, n: number, raw: unknown, removing: string[], drop: ReadonlySet<string>): Promise<{ extra: ChoicesBlockExtra } | { note: string }> {
  if (!isObj(raw)) return { note: "an extra is not an object" };
  const kind = raw.kind as ExtraKind;
  if (!KINDS.includes(kind)) return { note: `unknown extra "${String(raw.kind).slice(0, 40)}"` };
  const on = raw.on === true;
  const step = (r: { value: Step } | { note: string }): { value: Step } | { note: string } => ("note" in r ? { note: plain(r.note) } : r);
  switch (kind) {
    case "comment": {
      const t = commentText(raw.text, drop);
      return "note" in t ? { note: plain(t.note) } : { extra: { kind, on, text: t.value } };
    }
    case "label": {
      const r = step(await labelStep(db, repo, n, raw.label, removing));
      return "note" in r ? r : { extra: { kind, on, label: (r.value as Extract<Step, { kind: "label" }>).label } };
    }
    case "unlabel": {
      const r = step(await unlabelStep(db, repo, n, raw.label));
      return "note" in r ? r : { extra: { kind, on, label: (r.value as Extract<Step, { kind: "unlabel" }>).label } };
    }
    case "assign": {
      const r = step(await assignStep(db, repo, n, raw.login));
      return "note" in r ? r : { extra: { kind, on, login: (r.value as Extract<Step, { kind: "assign" }>).login } };
    }
    case "request_reviewers": {
      const r = step(await reviewersStep(db, repo, n, raw.logins));
      return "note" in r ? r : { extra: { kind, on, logins: (r.value as Extract<Step, { kind: "request_reviewers" }>).logins } };
    }
    case "open_issue": {
      const r = step(await openIssueStep(db, { repo: raw.repo ?? repo, title: raw.title, body: raw.body }, drop));
      if ("note" in r) return r;
      const v = r.value as Extract<Step, { kind: "open_issue" }>;
      return { extra: { kind, on, repo: v.repo, title: v.title, body: v.body } };
    }
  }
}

const composeExtra = (e: ChoicesBlockExtra) => ({ ...e, id: extraId(e) });

/**
 * A core with its drafted params and extras. The core alone is validated first (a core that fails is dropped), then the extras
 * one at a time on top of the ones kept, so an extra that breaks the card is dropped alone.
 */
async function checkCore(db: Db, repo: string, n: number, core: Core, raw: { reason?: unknown; instructions?: unknown; extras?: unknown }, drop: ReadonlySet<string>, notes: string[]): Promise<{ draft: { params?: StoredDraft["params"]; extras: ChoicesBlockExtra[] } } | null> {
  const params: { reason?: string; instructions?: string } = {};
  if (core.closing && typeof raw.reason === "string") {
    const r = cleanComment(raw.reason);
    if (r && drop.has(r)) notes.push(`left out the reason of ${core.key}: it mentions the reference folder or its documentation`);
    else if (r) params.reason = r;
  }
  if (core.params && "instructions" in core.params && typeof raw.instructions === "string") params.instructions = raw.instructions.trim();
  const base = compose(core, [], params);
  if ("note" in base) { notes.push(`dropped the choice ${core.key}: ${base.note}`); return null; }
  const v = await validateCard(db, repo, n, base.card, drop);
  if ("note" in v) { notes.push(`dropped the choice ${core.key}: ${plain(v.note)}`); return null; }
  const settle = v.card.params.kind === "resolution" ? v.card.params.settle : null;
  const stored: StoredDraft["params"] = {};
  if (core.closing && settle?.kind === "answer" && settle.reason) stored.reason = settle.reason;
  else if (core.closing && params.reason && settle?.kind === "answer") stored.reason = params.reason;
  if (params.instructions) stored.instructions = params.instructions;
  const list = Array.isArray(raw.extras) ? raw.extras.slice(0, MAX_EXTRAS) : [];
  const removing = list.flatMap((x) => (isObj(x) && x.kind === "unlabel" && typeof x.label === "string" ? [x.label] : []));
  const kept: ChoicesBlockExtra[] = [];
  for (const x of list) {
    const c = await checkExtra(db, repo, n, x, removing, drop);
    if ("note" in c) { notes.push(`dropped the ${isObj(x) ? String(x.kind).slice(0, 20) : "?"} extra of ${core.key} (${c.note})`); continue; }
    if (!core.allowed.includes(c.extra.kind)) { notes.push(`dropped the ${c.extra.kind} extra of ${core.key}: it is not offered with that choice`); continue; }
    const trial = [...kept, c.extra];
    const comp = compose(core, trial.map(composeExtra), params);
    if ("note" in comp) { notes.push(`dropped the ${c.extra.kind} extra of ${core.key} (${comp.note})`); continue; }
    const tv = await validateCard(db, repo, n, comp.card, drop);
    if ("note" in tv) { notes.push(`dropped the ${c.extra.kind} extra of ${core.key} (${plain(tv.note)})`); continue; }
    kept.push(c.extra);
  }
  return { draft: { ...(Object.keys(stored).length && { params: stored }), extras: kept } };
}

/** The key of an added core from the `end` of an `add` entry, or null. */
function endKey(end: unknown): CoreKey | null {
  if (!isObj(end)) return null;
  if (end.close === "completed" || end.close === "not_planned") return coreKey.close(end.close);
  if (Number.isInteger(end.duplicate) && (end.duplicate as number) > 0) return coreKey.duplicate(end.duplicate as number);
  if (typeof end.transfer === "string" && end.transfer.trim()) return coreKey.transfer(end.transfer.trim().replace(/^[^/]*\//, ""));
  if (end.fixup === true) return coreKey.fixup;
  if (end.review === true) return coreKey.review;
  return null;
}

const reasonOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, PREPARE_REASON_MAX) : "";
  return s || null;
};

/**
 * Reads a reply's `choices` block for decision `d` of item repo#n. Null: the reply has no text. `fresh` (a prepare): the block
 * replaces everything, so cores Opus added earlier are not offered. `pickOnly`, or a decision without cores (a group, a number-0 decision),
 * takes the pick only, as `o:<option key>`; its drafts are ignored.
 * `drop`: cleaned texts the reply lint still flagged after the fix turn; extras with them are dropped.
 */
export async function parseChoices(db: Db, repo: string, n: number, d: DecisionRow, reply: string, drop: ReadonlySet<string> = new Set(), o: { fresh?: boolean; pickOnly?: boolean } = {}): Promise<ChoicesReply | null> {
  const { text, json } = blockOf(reply);
  if (!text) return null;
  const out: ChoicesReply = { text, choices: null, ask: null, notes: [], pickLost: null, hasBlock: json !== null };
  if (json === null) return out;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { raw = null; }
  if (!isObj(raw)) { out.notes.push("dropped the choices block: it is not a JSON object"); return out; }
  if (!isObj(raw.pick) || (raw.pick.core !== null && typeof raw.pick.core !== "string")) { out.notes.push("dropped the choices block: it has no pick with a core or null"); return out; }
  const pickRaw = raw.pick.core as string | null, reason = reasonOf(raw.pick.reason);
  const offered = await coresFor(db, d);
  const notes = out.notes;
  const ask = await (async () => {
    if (!isObj(raw.ask)) return null;
    const v = await validateCard(db, repo, n, { kind: "resolution", steps: [{ kind: "comment" }], settle: null, text: raw.ask.text }, drop);
    if ("note" in v) { notes.push(`dropped the question to the author: ${plain(v.note)}`); return null; }
    return v.card;
  })();
  out.ask = ask;

  if (o.pickOnly || !offered.length) {
    const keys = optionsOf(d).map((x) => coreKey.option(x.key));
    if (pickRaw !== null && !keys.includes(pickRaw)) { out.pickLost = pickRaw; notes.push(`dropped the pick ${pickRaw}: it is not an option of the decision`); }
    const core = pickRaw !== null && keys.includes(pickRaw) ? pickRaw : null;
    out.choices = { pick: { core, reason: core ? reason : null }, cores: {}, add: [], drop: [] };
    return out;
  }

  const applicable = new Set(await applicableSteps(db, repo, n));
  const cur = o.fresh ? undefined : await currentChoices(db, d.id);
  const dropRaw = Array.isArray(raw.drop) ? raw.drop.filter((k): k is string => typeof k === "string") : [];
  const drops = dropRaw.filter((k) => cur?.added.includes(k));
  const existing: Core[] = [...offered];
  for (const k of cur?.added ?? []) {
    if (drops.includes(k)) continue;
    const c = await addedCore(db, d, k, applicable);
    if (c) existing.push(c);
  }
  const lost = new Set<CoreKey>();
  const out_: ParsedChoices = { pick: { core: null, reason: null }, cores: {}, add: [], drop: drops };

  // Added cores first, so a pick may name one.
  const newCores: Core[] = [];
  const capped = new Set<CoreKey>();
  let room = MAX_ADDED_CORES - existing.filter((c) => c.key.startsWith("x:")).length;
  for (const a of Array.isArray(raw.add) ? raw.add.slice(0, MAX_ADDED_CORES * 2) : []) {
    if (!isObj(a)) continue;
    const key = endKey(a.end);
    if (!key) { notes.push("dropped an added choice without a valid end (close, duplicate, transfer, fixup or review)"); continue; }
    const known = [...existing, ...newCores].find((c) => c.key === key);
    if (!known && room <= 0) { notes.push(`left out the added choice ${key}: at most ${MAX_ADDED_CORES} are kept`); capped.add(key); continue; }
    const core = known ?? await addedCore(db, d, key, applicable);
    if (!core) { notes.push(`left out the added choice ${key}: it does not apply to this item now`); lost.add(key); continue; }
    const r = await checkCore(db, repo, n, core, { instructions: a.instructions, extras: a.extras }, drop, notes);
    if (!r) { lost.add(key); continue; }
    if (!known) { newCores.push(core); room--; }
    out_.add = out_.add.filter((x) => x.key !== key);
    out_.add.push({ key, draft: r.draft });
  }

  const seen = new Set<CoreKey>();
  for (const c of Array.isArray(raw.cores) ? raw.cores.slice(0, 20) : []) {
    if (!isObj(c) || typeof c.core !== "string") { notes.push("dropped a choice entry without a core key"); continue; }
    const core = existing.find((x) => x.key === c.core);
    if (!core) { notes.push(`dropped the choice ${c.core.slice(0, 60)}: it is not one of the offered choices`); continue; }
    if (seen.has(core.key)) { notes.push(`dropped a second entry for the choice ${core.key}`); continue; }
    seen.add(core.key);
    const r = await checkCore(db, repo, n, core, c, drop, notes);
    if (!r) { lost.add(core.key); continue; }
    out_.cores[core.key] = r.draft;
  }

  if (pickRaw !== null && capped.has(pickRaw)) {
    // The pick's core was left out by the cap: the earlier pick stays.
    const old = cur?.pick.core && [...existing].some((c) => c.key === cur.pick.core) && !drops.includes(cur.pick.core) ? cur.pick : { core: null, reason: null };
    out_.pick = old;
    notes.push(`kept the earlier pick: ${pickRaw} was left out`);
  } else if (pickRaw !== null) {
    const live = [...existing, ...newCores].some((c) => c.key === pickRaw) && !lost.has(pickRaw);
    if (live) out_.pick = { core: pickRaw, reason };
    else {
      out.pickLost = pickRaw;
      if (!lost.has(pickRaw)) notes.push(`dropped the pick ${pickRaw.slice(0, 60)}: it is not one of the choices`);
    }
  }
  out.choices = out_;
  return out;
}

/** The public texts of a reply's choices block with their field names, for the reference checks. */
export function choicesTexts(reply: string): { field: string; text: string }[] {
  const { json } = blockOf(reply);
  if (json === null) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!isObj(raw)) return [];
  const out: { field: string; text: string }[] = [];
  const add = (field: string, v: unknown, oneLine = false) => {
    const t = typeof v === "string" ? (oneLine ? cleanComment(v).replace(/\s+/g, " ") : cleanComment(v)) : "";
    if (t) out.push({ field, text: t });
  };
  const extras = (path: string, list: unknown) => {
    if (!Array.isArray(list)) return;
    list.slice(0, MAX_EXTRAS).forEach((e, j) => {
      if (!isObj(e)) return;
      add(`${path}.extras[${j}].text`, e.text);
      add(`${path}.extras[${j}].title`, e.title, true);
      add(`${path}.extras[${j}].body`, e.body);
    });
  };
  if (Array.isArray(raw.cores)) raw.cores.slice(0, 20).forEach((c, i) => {
    if (!isObj(c)) return;
    add(`cores[${i}].reason`, c.reason);
    extras(`cores[${i}]`, c.extras);
  });
  if (Array.isArray(raw.add)) raw.add.slice(0, MAX_ADDED_CORES * 2).forEach((a, i) => { if (isObj(a)) extras(`add[${i}]`, a.extras); });
  if (isObj(raw.ask)) add("ask.text", raw.ask.text);
  return out;
}

// ---- A conversation turn ---------------------------------------------------------------

/** What a conversion of settling action cards into drafts gives back; see `hooks.settlingCardsToDrafts`. */
export interface SettlingDrafts {
  /** Drafts to merge into the turn's choices; null: the cards are dropped. */
  patch: { cores: ParsedChoices["cores"]; add: ParsedChoices["add"]; pick: ParsedChoices["pick"] | null } | null;
  notes: string[];
}

/**
 * Settling action cards of a conversation turn become drafts through `cardsToDrafts`; cards that map to no core are dropped with a note.
 * Tests or other callers may replace the hook.
 */
export const hooks: { settlingCardsToDrafts: (db: Db, repo: string, n: number, d: DecisionRow, cards: NewCard[]) => Promise<SettlingDrafts> } = {
  settlingCardsToDrafts: async (db, _repo, _n, d, cards) => {
    const r = await cardsToDrafts(db, d, cards.map((c) => ({ params: c.params, text: c.text })));
    const notes = [...r.notes];
    const unmapped = cards.length - r.used.length;
    if (unmapped > 0) notes.push(`dropped ${unmapped === 1 ? "a card" : `${unmapped} cards`} that settle the decision without matching one of its choices`);
    return { patch: r.used.length ? { cores: r.cores, add: r.add, pick: null } : null, notes };
  },
};

export interface TurnReply extends Parsed {
  /** The valid choices of the reply, for the decision below. */
  choices?: ParsedChoices;
  decision?: DecisionRow;
}

const isAsk = (c: NewCard): boolean => c.params.kind === "resolution" && !c.params.settle;

/**
 * A conversation reply. On an item whose open decision has cores the reply's block is `choices`; settling cards of an `actions`
 * block go through `hooks.settlingCardsToDrafts`, a card that only asks the author is kept. Otherwise it is `parseReply`.
 */
export async function parseTurn(db: Db, repo: string, n: number, reply: string, drop: ReadonlySet<string> = new Set()): Promise<TurnReply | null> {
  const d = await openDecision(db, repo, n);
  if (!d || !(await coresFor(db, d)).length) return await parseReply(db, repo, n, reply, drop);
  const c = await parseChoices(db, repo, n, d, reply, drop);
  if (!c) return null;
  const notes = [...c.notes];
  const cards: NewCard[] = c.ask ? [c.ask] : [];
  // Without a choices block the actions fence is cut off the text by parseReply.
  let text = c.text;
  let choices = c.choices ?? undefined;
  if (!c.hasBlock) {
    const r = await parseReply(db, repo, n, reply, drop);
    if (r) {
      text = r.text;
      notes.push(...r.notes);
      if (!cards.length) cards.push(...r.cards.filter(isAsk).slice(0, 1));
      const settling = r.cards.filter((x) => !isAsk(x));
      if (settling.length) {
        const h = await hooks.settlingCardsToDrafts(db, repo, n, d, settling);
        notes.push(...h.notes);
        if (h.patch) choices = { cores: h.patch.cores, add: h.patch.add, drop: [], pick: h.patch.pick ?? (await currentChoices(db, d.id))?.pick ?? { core: null, reason: null } };
      }
    }
  }
  return { text, cards, notes, ...(choices && { choices, decision: d }) };
}

/**
 * Stores validated choices for a decision: a prepare writes a whole new row, a conversation turn merges into the current one.
 * Call inside the transaction that inserts the turn (`turnId`); `seen` is the item snapshot JSON the turn was written against.
 */
export async function storeParsedChoices(db: Db, d: DecisionRow, p: ParsedChoices, o: { turnId: number | null; seen: string | null; source: "prepare" | "conversation"; by?: string | null; /** The decision's stamp when the reply's prompt was built. */ stampThen?: string | null; /** The login whose message the reply answered. */ askedBy?: string | null }): Promise<void> {
  // A late reply: the decision was answered, undone or asked again while the call ran.
  const now = await db.get(db.k.selectFrom("main.decisions").select(kx.cols("main.decisions")).$narrowType<{ kind: DecisionRow["kind"] }>().where("id", "=", d.id));
  if (!now || now.answer !== null || (o.stampThen != null && await decisionStamp(db, now) !== o.stampThen)) return;
  let seen: ChoicesRow["seen"] = { head: null, lastComment: null };
  try { const v = JSON.parse(o.seen ?? "{}") as { head?: string | null; last_comment?: string | null }; seen = { head: v.head ?? null, lastComment: v.last_comment ?? null }; } catch { /* no snapshot */ }
  const stamp = await decisionStamp(db, d);
  const by = o.by === undefined ? {} : { by: o.by };
  if (o.source === "conversation") {
    await mergeChoices(db, d.id, { turnId: o.turnId, askedBy: o.askedBy ?? null, stamp, seen, cores: p.cores, add: p.add, drop: p.drop, pick: p.pick }, by);
    return;
  }
  const drafts: ChoicesRow["drafts"] = {};
  for (const [k, v] of Object.entries(p.cores)) drafts[k] = { ...(v.params && { params: v.params }), extras: withIds(v.extras) };
  for (const a of p.add) drafts[a.key] = { ...(a.draft.params && { params: a.draft.params }), extras: withIds(a.draft.extras) };
  await writeChoices(db, { decisionId: d.id, repo: d.repo!, number: d.number!, turnId: o.turnId, stamp, seen, source: "prepare", drafts, added: p.add.map((a) => a.key), pick: p.pick }, by);
}

/** The compact `<choices>` JSON a turn block carries: the pick and the drafts as validated. */
export function choicesJson(p: ParsedChoices): string {
  return JSON.stringify({
    pick: p.pick,
    cores: Object.entries(p.cores).map(([core, v]) => ({ core, ...v.params, extras: v.extras })),
    ...(p.add.length && { add: p.add.map((a) => ({ core: a.key, ...a.draft.params, extras: a.draft.extras })) }),
    ...(p.drop.length && { drop: p.drop }),
  });
}

// ---- the legacy card model: resolutions of steps that settle a decision (only the retired decision files use it) ----
/**
 * One step of a resolution. The comment step's text is the card's `text`. Every kind but `review` and `fixup` is one GitHub write
 * through src/github/write.ts; `review` and `fixup` queue pipeline work. At most one step of each kind per card, except `label`
 * and `unlabel`. `close`, `duplicate` and `transfer` end the item here and come last.
 */
export type Step =
  | { kind: "comment" }
  | { kind: "label"; label: string }
  | { kind: "unlabel"; label: string }
  | { kind: "close"; reason: CloseReason; pr: boolean }
  | { kind: "duplicate"; of: number }
  | { kind: "reopen" }
  /** Opens a new issue in `repo` (this repo or another tracked one); title and body are the card's editable `issue` draft. */
  | { kind: "open_issue"; repo: string; title: string; body: string }
  /** Issues only: moves the issue to another tracked repo of the same owner. */
  | { kind: "transfer"; to: string }
  | { kind: "assign"; login: string }
  /** PRs only. */
  | { kind: "request_reviewers"; logins: string[] }
  /** PRs only: a fresh Opus review of the current head. */
  | { kind: "review" }
  /** PRs only: a fix-up run with the operator-editable instructions; `merge` makes it a pre-approved merge (see Preapproval in web/src/api/types.ts). */
  | { kind: "fixup"; instructions: string; merge: boolean };

/** How a resolution ends the item's open decision. `stamp` identifies the decision state it was written for. */
export type Settle =
  /** `reason`: the public reason a closing option's comment gives (see settleOf); it replaces the decision's own text when the card runs. */
  | { kind: "answer"; decision: string; option: string; stamp: string; reason?: string }
  /** `fromClose`: derived from the close or duplicate step, so its summary is false when that step is skipped. */
  | { kind: "handled"; decision: string; summary: string; stamp: string; fromClose?: true }
  | { kind: "backlog"; decision: string; stamp: string };

/** The legacy kinds (everything below `resolution`) stay runnable for cards stored before resolutions; new Opus output only produces `resolution`. */
export type CardParams =
  | { kind: "resolution"; steps: Step[]; settle: Settle | null }
  | { kind: "comment"; text: string }
  | { kind: "answer"; option: string; decision: string; stamp?: string }
  | { kind: "label"; label: string }
  | { kind: "backlog"; decision: string; stamp?: string }
  | { kind: "duplicate"; of: number }
  | { kind: "resolve"; decision: string; summary: string; stamp?: string }
  | { kind: "close"; reason: CloseReason; pr: boolean };

export type NewCard = { params: CardParams; text: string | null; description: string };

const legacyRef = (repo: string, n: number) => `${repo}#${n}`;

/** The item's open decision: the newest unanswered one that is about this item alone and is not a duplicate-group decision. */
export async function openDecision(db: Db, repo: string, n: number): Promise<DecisionRow | undefined> {
  return await db.get(db.k.selectFrom("decisions").select(kx.cols("decisions")).$narrowType<{ kind: Kind }>().where("repo", "=", repo).where("number", "=", n)
    .where("answer", "is", null).where((eb) => eb.not(kx.like(db, "id", eb.val("%:dupegroup:%")))).orderBy("asked_at", "desc").orderBy("id", "desc").limit(1));
}

/** Identifies the state of a decision a card was written for: its ask time and how often it was answered, undone or reopened. A re-ask or Reopen keeps the id, so the id alone cannot tell. */
export async function decisionStamp(db: Db, d: DecisionRow): Promise<string> {
  const n = (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("target", "=", d.id).where("action", "in", ["answer", "undo", "reopen"])))!.n;
  return `${d.asked_at}|${n}`;
}

const closeEffect = (p: { reason: CloseReason; pr: boolean }): string => p.pr ? "closes the PR on GitHub" : `closes the issue as ${p.reason === "completed" ? "completed" : "not planned"} on GitHub`;
const decisionWrite = async (db: Db, decision: string, option: string): Promise<string | null> => {
  const d = await getDecision(db, decision);
  return d ? writeEffect(d.kind as Kind, option) : null;
};

/** The GitHub write that answering with this card's option causes later (the Act step does it), or null when it writes nothing. For a resolution: every closing write it makes, joined. */
export async function cardEffect(db: Db, p: CardParams): Promise<string | null> {
  if (p.kind === "resolution") {
    const parts: string[] = [];
    for (const st of p.steps) {
      if (st.kind === "close") parts.push(closeEffect(st));
      else if (st.kind === "duplicate") parts.push("closes it as a duplicate on GitHub");
      else if (st.kind === "transfer") parts.push(`moves the issue to ${st.to} on GitHub`);
      else if (st.kind === "fixup" && st.merge) parts.push("merges the PR on GitHub once the fix-up, the review and CI pass");
    }
    if (p.settle?.kind === "answer") {
      const w = await decisionWrite(db, p.settle.decision, p.settle.option);
      if (w) parts.push(w);
    }
    return parts.length ? parts.join("; ") : null;
  }
  if (p.kind === "close") return closeEffect(p);
  if (p.kind !== "answer" || !p.decision) return null;
  return await decisionWrite(db, p.decision, p.option);
}

/** The word for a decision in the card lines: "scope", "close", "merge" ... ; "open" for kinds without a name of their own. */
const questionWord = (d: DecisionRow | undefined): string => (d && d.kind !== "other" ? d.kind : "open");
const optionLabel = (d: DecisionRow | undefined, key: string): string => (d ? optionsOf(d).find((x) => x.key === key)?.label : undefined) ?? key;

/**
 * Whether the card holds its open_issue step until the PR merges: it answers Merge, or its fix-up merges. The issue is filed after the merge
 * (src/conversations/held.ts), so a PR that never merges leaves none behind.
 */
export const holdsIssues = (p: CardParams): boolean =>
  p.kind === "resolution" && ((p.settle?.kind === "answer" && p.settle.option === "merge") || p.steps.some((x) => x.kind === "fixup" && x.merge));

/** One plain line for a step. `held`: the card holds its issue until the merge (holdsIssues). */
export function stepLine(st: Step, held = false): string {
  switch (st.kind) {
    case "comment": return "Post the comment below";
    case "label": return `Add the label "${st.label}"`;
    case "close": return st.pr ? "Close the PR" : `Close the issue as ${st.reason === "completed" ? "completed" : "not planned"}`;
    case "duplicate": return `Close as a duplicate of #${st.of}`;
    case "unlabel": return `Remove the label "${st.label}"`;
    case "reopen": return "Reopen it";
    case "open_issue": return `${held ? "After the merge: open" : "Open"} an issue in ${st.repo}: "${st.title}"`;
    case "transfer": return `Move the issue to ${st.to}`;
    case "assign": return `Assign ${st.login}`;
    case "request_reviewers": return `Ask ${st.logins.join(", ")} for a review`;
    case "review": return "Review the PR again";
    case "fixup": return st.merge ? "Fix up the PR as described below, then merge it if the review and CI pass" : "Fix up the PR as described below";
  }
}

/** One plain line for how a card ends the open decision. */
export async function settleLine(db: Db, s: Settle): Promise<string> {
  const d = await getDecision(db, s.decision);
  switch (s.kind) {
    case "answer": return `Answers the ${questionWord(d)} question with "${optionLabel(d, s.option)}"${s.reason ? `, giving the reason: ${s.reason}` : ""}`;
    case "handled": return `Closes the ${questionWord(d)} question as handled: "${s.summary}"`;
    case "backlog": return "Moves the item to the Backlog";
  }
}

/** The steps and settlement lines of any card, resolution or legacy (`description` is the legacy card's one line). */
export async function cardLines(db: Db, p: CardParams, description: string): Promise<{ steps: string[]; settles?: string }> {
  if (p.kind === "resolution") return { steps: p.steps.map((x) => stepLine(x, holdsIssues(p))), ...(p.settle && { settles: await settleLine(db, p.settle) }) };
  const steps = [description];
  switch (p.kind) {
    case "answer": return { steps: [], settles: await settleLine(db, { kind: "answer", decision: p.decision, option: p.option, stamp: p.stamp ?? "" }) };
    case "backlog": return { steps: [], settles: "Moves the item to the Backlog" };
    case "resolve": return { steps: [], settles: await settleLine(db, { kind: "handled", decision: p.decision, summary: p.summary, stamp: p.stamp ?? "" }) };
    case "close": case "duplicate": return { steps, settles: "Closes the open questions as handled" };
    default: return { steps };
  }
}

/** The primary button's label: the action in a few words, from the parameters and the item. Server-written. */
export async function buttonLabel(db: Db, p: CardParams): Promise<string> {
  switch (p.kind) {
    case "resolution": {
      const close = p.steps.find((x) => x.kind === "close");
      if (close) return close.pr ? "Close PR" : "Close issue";
      if (p.steps.some((x) => x.kind === "duplicate")) return "Close as duplicate";
      if (p.steps.some((x) => x.kind === "transfer")) return "Move issue";
      const fix = p.steps.find((x) => x.kind === "fixup");
      if (fix) return fix.merge ? "Fix up and merge" : "Fix up";
      if (p.steps.some((x) => x.kind === "review")) return "Review again";
      if (p.settle?.kind === "answer") return `Answer "${optionLabel(await getDecision(db, p.settle.decision), p.settle.option)}"`;
      if (p.settle?.kind === "backlog") return "Move to Backlog";
      if (p.steps.some((x) => x.kind === "open_issue")) return "Open issue";
      if (p.settle) return "Close question";
      if (p.steps.some((x) => x.kind === "comment")) return "Post comment";
      for (const [kind, label] of [["reopen", "Reopen"], ["request_reviewers", "Ask for review"], ["assign", "Assign"], ["unlabel", "Remove label"]] as const) if (p.steps.some((x) => x.kind === kind)) return label;
      return "Add label";
    }
    case "comment": return "Post comment";
    case "answer": {
      const d = await getDecision(db, p.decision);
      return `Answer "${optionLabel(d, p.option)}"`;
    }
    case "label": return "Add label";
    case "backlog": return "Move to Backlog";
    case "resolve": return "Close decision";
    case "duplicate": return "Close as duplicate";
    case "close": return p.pr ? "Close PR" : "Close issue";
  }
}

/** The card's first line: the button's action plus its key parameter ("Close issue as completed", "Close as duplicate of #12", "Move issue to <repo>"). Server-written. */
export async function headline(db: Db, p: CardParams): Promise<string> {
  const closeOf = (pr: boolean, reason: CloseReason) => (pr ? "Close PR" : `Close issue as ${reason === "completed" ? "completed" : "not planned"}`);
  switch (p.kind) {
    case "resolution": {
      const close = p.steps.find((x) => x.kind === "close");
      if (close?.kind === "close") return closeOf(close.pr, close.reason);
      const dup = p.steps.find((x) => x.kind === "duplicate");
      if (dup?.kind === "duplicate") return `Close as duplicate of #${dup.of}`;
      const move = p.steps.find((x) => x.kind === "transfer");
      if (move?.kind === "transfer") return `Move issue to ${move.to}`;
      const open = p.steps.find((x) => x.kind === "open_issue");
      if (open?.kind === "open_issue" && await buttonLabel(db, p) === "Open issue") return `Open issue in ${open.repo}`;
      return await buttonLabel(db, p);
    }
    case "duplicate": return `Close as duplicate of #${p.of}`;
    case "close": return closeOf(p.pr, p.reason);
    default: return await buttonLabel(db, p);
  }
}

/** The one-line description stored with a resolution: its steps and settlement. */
export async function describe(db: Db, repo: string, n: number, p: CardParams & { kind: "resolution" }): Promise<string> {
  const lines = await cardLines(db, p, "");
  return `On ${legacyRef(repo, n)}: ${[...lines.steps, ...(lines.settles ? [lines.settles] : [])].join("; ")}`;
}

/** Why Act would not close this item (an integration PR of ours, held by Backlog, outside the pilot), or null. */
export async function closeRefusal(db: Db, repo: string, n: number): Promise<string | null> {
  const has = async (cond?: (eb: kx.AnyEb) => Expression<SqlBool>) => !!await db.get(db.k.selectFrom("items as i").select((eb) => eb.lit(1).as("one"))
    .where("i.repo", "=", repo).where("i.number", "=", n).$if(!!cond, (q) => q.where((eb) => cond!(eb))));
  if (!await has()) return `${legacyRef(repo, n)} is not in the mirror`;
  if (!await has((eb) => notOwnIntegrationExpr(db, eb, "i"))) return `${legacyRef(repo, n)} is an integration PR the pipeline opened`;
  if (!await has((eb) => inScopeExpr(db, eb, "i.repo", "i.number"))) return `${legacyRef(repo, n)} is outside the pilot`;
  if (await has((eb) => backlogHeldExpr(db, eb, "i"))) return `${legacyRef(repo, n)} is held by a Backlog answer`;
  return null;
}

/** The type label the item has besides `label` (type labels are exclusive), or null. */
export async function otherTypeLabel(db: Db, repo: string, n: number, label: string, removing: readonly string[] = []): Promise<string | null> {
  if (!isTypeLabel(label)) return null;
  const row = await db.get(db.k.selectFrom("items").select("labels").where("repo", "=", repo).where("number", "=", n));
  let have: unknown[] = [];
  try { have = JSON.parse(row?.labels ?? "[]") as unknown[]; } catch { /* unreadable labels count as none */ }
  return have.map(String).find((l) => isTypeLabel(l) && !sameLabel(l, label) && !removing.some((r) => sameLabel(r, l))) ?? null;
}

export type Checked<T> = { value: T } | { note: string };

/** Model text for a comment step, cleaned and checked. */
export function commentText(raw: unknown, drop: ReadonlySet<string>): Checked<string> {
  const text = typeof raw === "string" ? cleanComment(raw) : "";
  if (!text) return { note: "dropped a resolution whose comment step has no text" };
  if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a resolution whose comment mentions the reference folder or its documentation" };
  if (text.length > COMMENT_MAX) return { note: `dropped a resolution whose comment is longer than ${COMMENT_MAX} characters` };
  return { value: text };
}

export async function labelStep(db: Db, repo: string, n: number, raw: unknown, removing: readonly string[]): Promise<Checked<Step>> {
  const l = typeof raw === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, raw)) : undefined;
  if (!l) return { note: `dropped a resolution: "${String(raw).slice(0, 40)}" is not a label the pipeline manages` };
  const other = await otherTypeLabel(db, repo, n, l.name, removing);
  if (other) return { note: `dropped a resolution: the item already has the type label "${other}" and an item has one type label` };
  return { value: { kind: "label", label: l.name } };
}

export async function closeStep(db: Db, repo: string, n: number, reason: unknown): Promise<Checked<Step>> {
  if (!CLOSE_REASONS.includes(reason as CloseReason)) return { note: "dropped a resolution whose close step has no reason of completed or not_planned" };
  const why = await closeRefusal(db, repo, n);
  if (why) return { note: `dropped a resolution: ${why}` };
  const row = (await db.get(db.k.selectFrom("items").select(["kind", "state"]).where("repo", "=", repo).where("number", "=", n)))!;
  if (row.state !== "OPEN") return { note: `dropped a resolution: ${legacyRef(repo, n)} is not open` };
  return { value: { kind: "close", reason: reason as CloseReason, pr: row.kind === "pr" } };
}

export async function duplicateStep(db: Db, repo: string, n: number, of: unknown): Promise<Checked<Step>> {
  if (!Number.isInteger(of) || of === n) return { note: "dropped a resolution whose duplicate step names no other item number" };
  if (!await db.get(db.k.selectFrom("items").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", of as number))) return { note: `dropped a resolution: ${legacyRef(repo, of as number)} is not in the mirror` };
  const why = await closeRefusal(db, repo, n);
  if (why) return { note: `dropped a resolution: ${why}` };
  return { value: { kind: "duplicate", of: of as number } };
}

type ItemFacts = { kind: string; state: string; author: string | null };
const itemFacts = async (db: Db, repo: string, n: number): Promise<ItemFacts | undefined> =>
  await db.get(db.k.selectFrom("items").select(["kind", "state", "author"]).where("repo", "=", repo).where("number", "=", n));
/** A repository name as the model wrote it, without a leading `owner/`. An owner that is not the repo's own leaves the value as written, which is no tracked repo. */
const bareRepo = (v: unknown): unknown => {
  if (typeof v !== "string" || !v.includes("/")) return v;
  const { owner, name } = splitSlug(v);
  return owner.toLowerCase() === ownerOf(name).toLowerCase() ? name : v;
};
const isTracked = async (db: Db, repo: string): Promise<boolean> => !!(await db.get(db.k.selectFrom("tracked_repos").select((eb) => eb.lit(1).as("one")).where("name", "=", repo)));
const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Whether the mirror says `login` can write to `repo`: a cached permission of write or higher, or an association of owner,
 * member or collaborator on an item or comment in the repo. The association is a hint only; Act reads the live permission before it writes.
 */
export async function mayWrite(db: Db, repo: string, login: string): Promise<boolean> {
  if (await db.get(db.k.selectFrom("repo_permissions").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("login", "=", login).where("permission", "in", ["write", "maintain", "admin"]))) return true;
  return !!await db.get(db.k.selectFrom("items").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where((eb) => kx.ciEq(db, "author", eb.val(login)))
    .where("author_association", "in", ["OWNER", "MEMBER", "COLLABORATOR"])
    .unionAll(db.k.selectFrom("comments").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where((eb) => kx.ciEq(db, "author", eb.val(login)))
      .where("author_association", "in", ["OWNER", "MEMBER", "COLLABORATOR"]))
    .limit(1));
}

const pr = (f: ItemFacts | undefined): boolean => f?.kind === "pr";

/** Model text for an issue title: cleaned like a comment, on one line. */
function issueText(raw: unknown, max: number, what: string, drop: ReadonlySet<string>, oneLineOnly: boolean): Checked<string> {
  const t = typeof raw === "string" ? (oneLineOnly ? cleanComment(raw).replace(/\s+/g, " ") : cleanComment(raw)) : "";
  if (!t) return { note: `dropped a resolution whose open_issue step has no ${what}` };
  if (REFERENCE_LEAK.test(t) || drop.has(t)) return { note: `dropped a resolution whose issue ${what} mentions the reference folder or its documentation` };
  if (t.length > max) return { note: `dropped a resolution whose issue ${what} is longer than ${max} characters` };
  return { value: t };
}

export async function openIssueStep(db: Db, st: Record<string, unknown>, drop: ReadonlySet<string>): Promise<Checked<Step>> {
  const repo = bareRepo(st.repo);
  if (typeof repo !== "string" || !await isTracked(db, repo)) return { note: `dropped a resolution: "${String(st.repo).slice(0, 40)}" is not a tracked repository` };
  const title = issueText(st.title, ISSUE_TITLE_MAX, "title", drop, true);
  if ("note" in title) return title;
  const body = issueText(st.body, COMMENT_MAX, "body", drop, false);
  if ("note" in body) return body;
  return { value: { kind: "open_issue", repo, title: title.value, body: body.value } };
}

export async function transferStep(db: Db, repo: string, n: number, toRaw: unknown): Promise<Checked<Step>> {
  const to = bareRepo(toRaw);
  const f = await itemFacts(db, repo, n);
  if (pr(f)) return { note: "dropped a resolution: only an issue can be moved to another repository" };
  if (typeof to !== "string" || !await isTracked(db, to) || to === repo) return { note: `dropped a resolution: "${String(to).slice(0, 40)}" is not another tracked repository` };
  if (ownerOf(to).toLowerCase() !== ownerOf(repo).toLowerCase()) return { note: "dropped a resolution: an issue moves only between repositories of one owner" };
  const why = await closeRefusal(db, repo, n);
  if (why) return { note: `dropped a resolution: ${why}` };
  if (f?.state !== "OPEN") return { note: `dropped a resolution: ${legacyRef(repo, n)} is not open` };
  return { value: { kind: "transfer", to } };
}

export async function assignStep(db: Db, repo: string, n: number, login: unknown): Promise<Checked<Step>> {
  if (typeof login !== "string" || !LOGIN.test(login)) return { note: "dropped a resolution whose assign step has no GitHub login" };
  if (!sameLogin((await itemFacts(db, repo, n))?.author ?? null, login) && !await mayWrite(db, repo, login)) return { note: `dropped a resolution: ${login} is neither the author nor known to have write access to ${repo}` };
  return { value: { kind: "assign", login } };
}

export async function reviewersStep(db: Db, repo: string, n: number, raw: unknown): Promise<Checked<Step>> {
  const f = await itemFacts(db, repo, n);
  if (!pr(f)) return { note: "dropped a resolution: reviewers can be requested on a PR only" };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 || raw.some((x) => typeof x !== "string" || !LOGIN.test(x))) return { note: "dropped a resolution whose request_reviewers step does not list one to three GitHub logins" };
  const logins = raw as string[];
  if (new Set(logins.map((x) => x.toLowerCase())).size !== logins.length) return { note: "dropped a resolution that requests the same reviewer twice" };
  const bad = await findSeq(logins, async (x) => sameLogin(f!.author, x) || !await mayWrite(db, repo, x));
  if (bad) return { note: `dropped a resolution: ${bad} is the PR's author or not known to have write access to ${repo}` };
  return { value: { kind: "request_reviewers", logins } };
}

export async function unlabelStep(db: Db, repo: string, n: number, raw: unknown): Promise<Checked<Step>> {
  const l = typeof raw === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, raw)) : undefined;
  if (!l) return { note: `dropped a resolution: "${String(raw).slice(0, 40)}" is not a label the pipeline manages` };
  const row = await db.get(db.k.selectFrom("items").select("labels").where("repo", "=", repo).where("number", "=", n));
  let have: unknown[] = [];
  try { have = JSON.parse(row?.labels ?? "[]") as unknown[]; } catch { /* unreadable labels count as none */ }
  if (!have.some((x) => sameLabel(String(x), l.name))) return { note: `dropped a resolution: the item does not have the label "${l.name}"` };
  return { value: { kind: "unlabel", label: l.name } };
}

async function reopenStep(db: Db, repo: string, n: number): Promise<Checked<Step>> {
  const f = await itemFacts(db, repo, n);
  if (f?.state !== "CLOSED") return { note: `dropped a resolution: ${legacyRef(repo, n)} is not closed` };
  const why = await closeRefusal(db, repo, n);
  return why ? { note: `dropped a resolution: ${why}` } : { value: { kind: "reopen" } };
}

export async function pipelineStep(db: Db, repo: string, n: number, st: Record<string, unknown>): Promise<Checked<Step>> {
  const f = await itemFacts(db, repo, n);
  if (!pr(f) || f?.state !== "OPEN") return { note: `dropped a resolution: a ${String(st.kind)} step needs an open PR` };
  if (st.kind === "review") return { value: { kind: "review" } };
  const instructions = typeof st.instructions === "string" ? st.instructions.trim() : "";
  if (!instructions) return { note: "dropped a resolution whose fixup step has no instructions" };
  if (instructions.length > INSTRUCTIONS_MAX) return { note: `dropped a resolution whose fixup instructions are longer than ${INSTRUCTIONS_MAX} characters` };
  if (st.merge !== undefined && typeof st.merge !== "boolean") return { note: "dropped a resolution whose fixup merge is not true or false" };
  return { value: { kind: "fixup", instructions, merge: st.merge === true } };
}

const MAX_STEPS = 8;

/** Steps that post model-written text on GitHub: not offered on a quiet pull request, whose fix must not be described in public before the advisory is published. */
/**
 * Whether a card's effect rests on the PR's code at the head it was written for: it posts a drafted comment or issue, or pushes a fix-up.
 * Other cards (answer, backlog, hold, label, close, review, reviewers) still run after a push; these are refused until the choices are written again.
 */
export function dependsOnCode(params: CardParams, text: string | null): boolean {
  switch (params.kind) {
    case "comment": return true;
    case "close": return text !== null && text.trim() !== "";
    case "resolution": return params.steps.some((x) => x.kind === "comment" || x.kind === "open_issue" || x.kind === "fixup") || (params.settle?.kind === "answer" && !!params.settle.reason?.trim());
    default: return false;
  }
}

export const PUBLIC_TEXT_STEPS: ReadonlySet<string> = new Set(["comment", "open_issue", "transfer"]);

/** The step kinds that can validate for the item as it is now, from the same facts and refusals as validateResolution; "fixup with merge" is listed apart. */
export async function applicableSteps(db: Db, repo: string, n: number): Promise<string[]> {
  const f = await itemFacts(db, repo, n);
  if (!f) return [];
  const open = f.state === "OPEN", isPr = pr(f), out: string[] = ["open_issue"];
  const quiet = (await loadQuiet(db, [`${repo}#${n}`])).size > 0;
  if (open) {
    out.push("comment", "label", "assign");
    if (await someSeq(ALL_LABELS, async (l) => !("note" in await unlabelStep(db, repo, n, l.name)))) out.push("unlabel");
    if (!await closeRefusal(db, repo, n)) out.push("close", "duplicate");
    if (isPr) {
      out.push("request_reviewers", "review", "fixup");
      const d = await openDecision(db, repo, n);
      if (d && (d.kind === "merge" || d.kind === "scope" || d.kind === "hold")) out.push("fixup with merge");
    } else if (!await closeRefusal(db, repo, n)) out.push("transfer");
  } else if (f.state === "CLOSED" && !("note" in await reopenStep(db, repo, n))) out.push("reopen");
  return quiet ? out.filter((k) => !PUBLIC_TEXT_STEPS.has(k)) : out;
}

/** The settlement the model asked for, checked against the item's open decision `d`. */
async function settleOf(db: Db, d: DecisionRow, raw: unknown): Promise<Checked<Settle>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a resolution whose settle is not an object" };
  const s = raw as Record<string, unknown>;
  const stamp = await decisionStamp(db, d);
  switch (s.kind) {
    case "answer":
      if (typeof s.option !== "string" || !optionsOf(d).some((o) => o.key === s.option)) return { note: `dropped a resolution: "${String(s.option).slice(0, 40)}" is not an option of the open decision` };
      if (s.reason === undefined || s.reason === null || s.reason === "") return { value: { kind: "answer", decision: d.id, option: s.option, stamp } };
      if (typeof s.reason !== "string") return { note: "dropped a resolution whose settle reason is not text" };
      // Only an option that closes with a comment takes a reason; for any other the field is ignored.
      if (!/\bcloses\b/.test(writeEffect(d.kind as Kind, s.option) ?? "")) return { value: { kind: "answer", decision: d.id, option: s.option, stamp } };
      // The reason goes into the closing comment, which a quiet pull request never gets.
      if (d.repo && d.number !== null && (await loadQuiet(db, [`${d.repo}#${d.number}`])).size > 0) return { note: "dropped a resolution: a quiet pull request's closing comment takes no reason" };
      const reason = cleanReason(cleanComment(s.reason));
      if (!reason) return { value: { kind: "answer", decision: d.id, option: s.option, stamp } };
      if (REFERENCE_LEAK.test(reason)) return { note: "dropped a resolution whose settle reason mentions the reference folder or its documentation" };
      return { value: { kind: "answer", decision: d.id, option: s.option, stamp, reason } };
    case "backlog":
      return { value: { kind: "backlog", decision: d.id, stamp } };
    case "handled": {
      const summary = typeof s.summary === "string" ? cleanComment(s.summary).replace(/\s+/g, " ") : "";
      if (!summary) return { note: "dropped a resolution that settles as handled without a summary" };
      if (REFERENCE_LEAK.test(summary)) return { note: "dropped a resolution whose summary mentions the reference folder or its documentation" };
      if (summary.length > RESOLVE_MAX) return { note: `dropped a resolution with a summary longer than ${RESOLVE_MAX} characters` };
      return { value: { kind: "handled", decision: d.id, summary, stamp } };
    }
    default:
      return { note: `dropped a resolution with unknown settle "${String(s.kind).slice(0, 40)}"` };
  }
}

/** The steps that settle an open decision as handled when the model named no settlement: they end the item here or hand the PR to a pipeline step. */
type Settling = Extract<Step, { kind: "close" | "duplicate" | "transfer" | "review" | "fixup" }>;
export const isSettling = (x: Step): x is Settling => x.kind === "close" || x.kind === "duplicate" || x.kind === "transfer" || x.kind === "review" || x.kind === "fixup";

async function closeSettle(db: Db, repo: string, d: DecisionRow, st: Settling): Promise<Settle> {
  const summary = st.kind === "duplicate" ? `Closed as a duplicate of ${legacyRef(repo, st.of)} in the conversation`
    : st.kind === "transfer" ? `Moved to ${st.to} in the conversation`
    : st.kind === "review" ? "Reviewed again"
    : st.kind === "fixup" ? (st.merge ? "Fixed up and queued to merge" : "Fixed up")
    : st.pr ? "Closed in the conversation" : `Closed as ${st.reason === "completed" ? "completed" : "not planned"} in the conversation`;
  return { kind: "handled", decision: d.id, summary, stamp: await decisionStamp(db, d), fromClose: true };
}

/**
 * One resolution as the model wrote it, checked against the item, or why it is dropped. Rules: at most one comment step and one
 * close or duplicate step, which comes last; with an open decision the card settles it (a lone comment step may leave it open: the
 * "ask" card); a close, duplicate, transfer, review or fixup step settles it as handled; an answer whose option already writes to GitHub
 * takes no close, duplicate, transfer, reopen, reviewer, review or fixup step, and a comment only when the answer merges (an issue, label or assignee step is fine);
 * the one exception is a scope answer that keeps the PR in core (take, small-extra) with a fixup step: the answer is recorded before the fix-up runs, so the review and the merge see the PR in core;
 * without an open decision there is no settlement. At most one step of each kind except label and unlabel; close, duplicate and
 * transfer end the item (at most one, last); reopen comes first and only on a closed item; a fixup that merges needs an open merge or scope decision on a PR.
 */
async function validateResolution(db: Db, repo: string, n: number, c: Record<string, unknown>, drop: ReadonlySet<string>): Promise<{ card: NewCard } | { note: string }> {
  if (!Array.isArray(c.steps) || c.steps.length > MAX_STEPS) return { note: "dropped a resolution without a list of steps" };
  const steps: Step[] = [];
  const removing = c.steps.flatMap((x) => (x && (x as { kind?: unknown }).kind === "unlabel" && typeof (x as { label?: unknown }).label === "string" ? [(x as { label: string }).label] : []));
  for (const raw of c.steps) {
    const st = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    let r: Checked<Step>;
    switch (st.kind) {
      case "comment": r = { value: { kind: "comment" } }; break;
      case "label": r = await labelStep(db, repo, n, st.label, removing); break;
      case "close": r = await closeStep(db, repo, n, st.reason); break;
      case "duplicate": r = await duplicateStep(db, repo, n, st.of); break;
      case "unlabel": r = await unlabelStep(db, repo, n, st.label); break;
      case "reopen": r = await reopenStep(db, repo, n); break;
      case "open_issue": r = await openIssueStep(db, st, drop); break;
      case "transfer": r = await transferStep(db, repo, n, st.to); break;
      case "assign": r = await assignStep(db, repo, n, st.login); break;
      case "request_reviewers": r = await reviewersStep(db, repo, n, st.logins); break;
      case "review": case "fixup": r = await pipelineStep(db, repo, n, st); break;
      default: r = { note: `dropped a resolution with unknown step "${String(st.kind).slice(0, 40)}"` };
    }
    if ("note" in r) return r;
    steps.push(r.value);
  }
  if (steps.some((x) => PUBLIC_TEXT_STEPS.has(x.kind)) && (await loadQuiet(db, [`${repo}#${n}`])).size > 0) return { note: "dropped a resolution that posts text on a quiet pull request" };
  const labels = steps.flatMap((x) => (x.kind === "label" ? [x.label] : []));
  if (new Set(labels).size !== labels.length) return { note: "dropped a resolution that adds the same label twice" };
  if (labels.filter(isTypeLabel).length > 1) return { note: "dropped a resolution that adds more than one type label" };
  const unlabels = steps.flatMap((x) => (x.kind === "unlabel" ? [x.label] : []));
  if (new Set(unlabels).size !== unlabels.length) return { note: "dropped a resolution that removes the same label twice" };
  if (unlabels.some((l) => labels.includes(l))) return { note: "dropped a resolution that adds and removes the same label" };
  const count = (k: Step["kind"]) => steps.filter((x) => x.kind === k).length;
  for (const k of ["comment", "reopen", "open_issue", "assign", "request_reviewers", "review", "fixup"] as const) if (count(k) > 1) return { note: `dropped a resolution with more than one ${k} step` };
  if (count("review") + count("fixup") > 1) return { note: "dropped a resolution with both a review and a fixup step" };
  if ((count("review") || count("fixup")) && (count("close") || count("duplicate"))) return { note: "dropped a resolution that closes the PR and also reviews or fixes it up" };
  const closing = steps.filter((x): x is Extract<Step, { kind: "close" | "duplicate" | "transfer" }> => x.kind === "close" || x.kind === "duplicate" || x.kind === "transfer");
  if (closing.length > 1) return { note: "dropped a resolution that ends the item twice (close, duplicate or transfer)" };
  if (closing.length === 1 && steps[steps.length - 1] !== closing[0]) return { note: "dropped a resolution whose close, duplicate or transfer step is not last" };
  if (count("reopen") === 1 && steps[0]!.kind !== "reopen") return { note: "dropped a resolution whose reopen step is not first" };
  if (count("reopen") === 1 && closing.length === 1) return { note: "dropped a resolution that reopens and ends the item" };
  let text: string | null = null;
  if (count("comment") === 1) {
    const t = commentText(c.text, drop);
    if ("note" in t) return t;
    text = t.value;
  } else if (c.text !== undefined && c.text !== null && c.text !== "") return { note: "dropped a resolution with a comment text but no comment step" };

  const d = await openDecision(db, repo, n);
  let settle: Settle | null = null;
  if (c.settle !== undefined && c.settle !== null) {
    if (!d) return { note: "dropped a resolution: the item has no open decision to settle" };
    const s = await settleOf(db, d, c.settle);
    if ("note" in s) return s;
    settle = s.value;
  }
  const fix = steps.find((x) => x.kind === "fixup");
  if (fix?.kind === "fixup" && fix.merge && (!d || (d.kind !== "merge" && d.kind !== "scope" && d.kind !== "hold"))) return { note: "dropped a resolution: a fixup that merges needs an open merge, scope or hold decision on the PR" };
  const settling = steps.find(isSettling);
  if (settling) {
    const keeps = settling.kind === "fixup" && d?.kind === "scope" && settle?.kind === "answer" && KEEP_IN_CORE.includes(settle.option);
    if (settle && settle.kind !== "handled" && !keeps) return { note: `dropped a resolution that has a ${settling.kind} step and settles the question another way than handled` };
    if (d && !settle) settle = await closeSettle(db, repo, d, settling);
  }
  if (settle?.kind === "answer") {
    const effect = await decisionWrite(db, settle.decision, settle.option);
    // Merging takes a comment too (posted before the answer); closing options use their reason as the comment.
    const merges = /\bmerges\b/.test(effect ?? "");
    if (effect && steps.some((x) => ["close", "duplicate", "transfer", "reopen", "request_reviewers", "review", "fixup", ...(merges ? [] : ["comment"])].includes(x.kind))) {
      return { note: `dropped a resolution: the answer already writes to GitHub, so it takes only ${merges ? "comment, " : ""}label, assign and open_issue steps` };
    }
  }
  if (d && !settle && !(steps.length === 1 && steps[0]!.kind === "comment")) return { note: "dropped a resolution that leaves the open decision unsettled" };
  if (!settle && steps.length === 0) return { note: "dropped a resolution without steps or settlement" };
  const params: CardParams = { kind: "resolution", steps, settle };
  return { card: { params, text, description: await describe(db, repo, n, params) } };
}

/** One card as the model wrote it, checked against the item, or why it is dropped. Only resolutions are accepted. */
export async function validateCard(db: Db, repo: string, n: number, raw: unknown, drop: ReadonlySet<string> = new Set()): Promise<{ card: NewCard } | { note: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a card that is not an object" };
  const c = raw as Record<string, unknown>;
  if (c.kind !== "resolution") return { note: `dropped a card with unknown action "${String(c.kind).slice(0, 40)}"` };
  return await validateResolution(db, repo, n, c, drop);
}

/** The "ask and keep the question open" card: a lone comment step on an item with an open decision. */
const isLegacyAsk = (c: NewCard): boolean => c.params.kind === "resolution" && !c.params.settle;

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

/** Resolutions per reply beyond one per option of the decision: outcomes no option covers (handled, a close, a step-only action). */
const MAX_EXTRA = 2;
const LEGACY_FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

/** The cleaned text of each public text of a reply (a comment, an issue's body), with its field (`cards[i].text`, `cards[i].steps[j].body`, i the position in the actions block), for the reference checks. */
export function commentTexts(reply: string): { field: string; text: string }[] {
  const m = LEGACY_FENCE.exec(reply.trimEnd());
  if (!m) return [];
  let list: unknown;
  try { list = JSON.parse(m[1]!); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).flatMap((c: { kind?: unknown; text?: unknown; steps?: unknown; settle?: { reason?: unknown } | null }, i) => {
    if (!c || c.kind !== "resolution") return [];
    const out: { field: string; text: string }[] = [];
    const text = typeof c.text === "string" ? cleanComment(c.text) : "";
    if (text) out.push({ field: `cards[${i}].text`, text });
    const reason = typeof c.settle?.reason === "string" ? cleanComment(c.settle.reason) : "";
    if (reason) out.push({ field: `cards[${i}].settle.reason`, text: reason });
    if (Array.isArray(c.steps)) c.steps.forEach((st: { kind?: unknown; body?: unknown; title?: unknown }, j) => {
      if (!st || st.kind !== "open_issue") return;
      const body = typeof st.body === "string" ? cleanComment(st.body) : "", title = typeof st.title === "string" ? cleanComment(st.title).replace(/\s+/g, " ") : "";
      if (body) out.push({ field: `cards[${i}].steps[${j}].body`, text: body });
      if (title) out.push({ field: `cards[${i}].steps[${j}].title`, text: title });
    });
    return out;
  });
}

/** The reply's text and its valid cards. A reply with no text gets null. `drop`: cleaned comment texts the reply lint still flagged after the fix turn; their cards are dropped. */
export async function parseReply(db: Db, repo: string, n: number, reply: string, drop: ReadonlySet<string> = new Set()): Promise<Parsed | null> {
  const m = LEGACY_FENCE.exec(reply.trimEnd());
  const text = (m ? reply.trimEnd().slice(0, m.index) : reply).trim();
  if (!text) return null;
  const notes: string[] = [];
  const cards: NewCard[] = [];
  if (m) {
    let list: unknown;
    try { list = JSON.parse(m[1]!); } catch { list = null; }
    if (!Array.isArray(list)) notes.push("dropped the actions block: it is not a JSON list");
    else {
      const hasDecision = !!await openDecision(db, repo, n);
      let asks = 0, extras = 0;
      const options = new Set<string>();
      for (const raw of list.slice(0, 20)) {
        const v = await validateCard(db, repo, n, raw, drop);
        if (!("card" in v)) { notes.push(v.note); continue; }
        if (hasDecision && isLegacyAsk(v.card)) {
          if (asks++ >= 1) notes.push("dropped a second card that only asks and keeps the question open");
          else cards.push(v.card);
        } else {
          const s = v.card.params.kind === "resolution" ? v.card.params.settle : null;
          const option = s?.kind === "answer" ? s.option : s?.kind === "backlog" ? "backlog" : null;
          if (option !== null) {
            if (options.has(option)) notes.push("dropped a second resolution for the same option");
            else { options.add(option); cards.push(v.card); }
          } else if (extras++ >= MAX_EXTRA) notes.push(`dropped a resolution beyond the ${MAX_EXTRA} extra outcomes allowed per reply`);
          else cards.push(v.card);
        }
      }
      if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
    }
  }
  return { text, cards, notes };
}

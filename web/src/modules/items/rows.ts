/** Items rows: one compact row per item, one inline expansion, and the selection that decides which
    row is open. Pure functions only; the page owns the URL and the selected row's GETs. */
import { itemPath } from "../../lib/links.ts";
import { eventTime } from "../../lib/format.ts";
import type { Classification, Classifier, Decision, ExecState, Item, ItemKind, ItemListRow, ItemState, ItemStatus, ItemChecks, ItemStatusRow, QueueSlot, Settled, SettledStatus, Snippet, Stage, TimelineEntry } from "../../api/types.ts";

/** The approved selection key: `open=repo#number`. */
export interface OpenRef { repo: string; number: number }

export interface Selection {
  /** The row to open, when the link names one that parses. */
  open: OpenRef | null;
  /** The raw value, kept for an honest unavailable message. */
  openRaw?: string;
  /** A legacy `peek` value that was replaced by `open`, kept for the footer note. */
  ignoredPeek?: string;
  /** A legacy `peek` value that still needs its replace-normalisation to `open`. */
  aliasPeek?: OpenRef;
  /** A `peek` that does not parse; reported as an unavailable selection, never opened. */
  malformedPeek?: string;
}

const REF = /^([a-zA-Z0-9_.-]+)#([1-9][0-9]*)$/;

export function parseRef(value: string | undefined): OpenRef | null {
  const match = REF.exec(value ?? "");
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? { repo: match[1]!, number } : null;
}

export const refKey = (ref: OpenRef): string => `${ref.repo}#${ref.number}`;

/** `open` wins; a valid `peek` is an alias to be replaced, a conflicting one is reported. */
export function parseSelection(search: string): Selection {
  const params = new URLSearchParams(search);
  const hasOpen = params.has("open");
  const openRaw = params.get("open") ?? undefined;
  const peekRaw = params.get("peek") ?? undefined;
  const open = parseRef(openRaw);
  const peek = parseRef(peekRaw);
  const selection: Selection = { open, openRaw };
  if (peekRaw !== undefined) {
    if (!peek) selection.malformedPeek = peekRaw;
    // A canonical `open` wins by presence: a valid legacy peek may only stand in when `open` is
    // absent, so an empty or malformed primary keeps its explicit unavailable state.
    else if (!hasOpen) selection.aliasPeek = peek;
    else if (open && refKey(peek) === refKey(open)) selection.aliasPeek = peek;
    else if (open) selection.ignoredPeek = peekRaw;
  }
  return selection;
}

/** The replace target for a legacy `peek` link: `open` set, `peek` gone, every other key kept. */
export function aliasToOpenHref(search: string, ref: OpenRef): string {
  const params = new URLSearchParams(search);
  params.delete("peek");
  params.set("open", refKey(ref));
  const query = params.toString();
  return `/items${query ? `?${query}` : ""}`;
}

/** Toggling a row: the new URL search for opening or closing it (push by the caller). */
export function selectionPatch(ref: OpenRef | null): Record<string, string | null> {
  return { open: ref ? refKey(ref) : null, peek: null };
}

export const STAGE_LABEL: Record<Stage, string> = {
  classified: "Classified", labeled: "Labelled", reviewed: "Reviewed", take: "Taken", hold: "Held", close: "To close", "needs-decision": "Waiting for a decision",
  batched: "In a batch", merged: "Merged by the pipeline", closed: "Closed by the pipeline", "fixed-by-us": "Fixed by us",
  "verify-planned": "Being verified", "verify-ci-enough": "CI is enough", "verify-error": "Verification not planned", "verify-unavailable": "Not verified",
  verified: "Verified", "verify-failed": "Verification failed",
};

export type ClassificationTone = "ok" | "warn" | "bad" | "neutral";
export interface Token { text: string; tone: ClassificationTone }

/** The one classification token the compact strip shows, or why there is none (never a fake label). */
export function classificationToken(settled: Settled): Token {
  // The approved reference's tones: a settled label is plain (neutral), and every unsettled
  // classification is amber. Security keeps its own bad tone, separately.
  if (settled.status === "settled") return { text: settled.label ?? "Settled", tone: "neutral" };
  if (settled.status === "waiting") return { text: "Waiting for a second opinion", tone: "warn" };
  if (settled.status === "disagree") return { text: "Classifiers disagree", tone: "warn" };
  return { text: "Not classified", tone: "warn" };
}

/** Real provenance for the expansion: who classified it, with confidence where the DTO has one. */
export function classificationDetail(settled: Settled, earlierRecords = 0): string {
  const pct = settled.confidence !== null ? ` ${settled.confidence.toFixed(2)}` : "";
  const status: Record<SettledStatus, string> = {
    settled: "",
    waiting: "Waiting for a second opinion",
    disagree: "Classifiers disagree",
    unclassified: earlierRecords > 0
      ? "The latest classification run settled nothing. Earlier classifier records exist; the reason beside them is quoted above."
      : "No classifier has run. Not classified is not “no label applies”.",
  };
  const parts: string[] = [];
  if (settled.status === "waiting") parts.push(`Jev ${settled.jevLabel ?? "no label"}${pct}`);
  if (settled.status === "waiting" && settled.haikuLabel) parts.push(`Haiku ${settled.haikuLabel}`);
  if (settled.status === "disagree") {
    parts.push(`Jev ${settled.jevLabel ?? "no label"}${pct}`);
    if (settled.haikuLabel) parts.push(`Haiku ${settled.haikuLabel}`);
    if (settled.referee) parts.push(`Sonnet ${settled.referee.label}, ${settled.referee.sure ? "sure" : `unsure: ${settled.referee.reason}`}`);
  }
  if (settled.status === "settled") parts.push(settled.source === "jev" ? `Jev${pct}` : settled.source === "haiku" ? `Jev unsure${pct}, Haiku agrees` : "Sonnet settled it");
  const head = status[settled.status];
  return [head, parts.join(" · ")].filter(Boolean).join(". ");
}

export interface RowFacts {
  key: string;
  repo: string;
  number: number;
  kind: ItemKind;
  state: ItemState;
  title: string;
  updatedAt: string;
  /** Normal lists: the classification the list endpoint returned. Phase lists do not have one. */
  settled?: Settled;
  /** Phase lists: where the item is, what it waits for. */
  status?: ItemStatus;
  stage?: Stage | null;
  queue?: QueueSlot | null;
  flags: string[];
  author?: string;
  /** Upstream phase rows carry the same checks as the merge queue and closing issue refs. */
  checks?: ItemChecks | null;
  closes?: number[];
  snippet?: Snippet | null;
  mergedHow?: ItemListRow["mergedHow"];
  mergedAt?: string | null;
  /** Normal lists only: messages in watched Discord channels that name the item. */
  discord?: number;
  /** True for the phase list: classification, queue slot and row metadata are not in that payload. */
  phaseScoped: boolean;
}

export function factsFromListRow(row: ItemListRow): RowFacts {
  return {
    key: refKey(row), repo: row.repo, number: row.number, kind: row.kind, state: row.state, title: row.title, updatedAt: row.updatedAt,
    settled: row.settled, stage: row.stage, queue: row.queue ?? null, flags: row.settled.flags, author: row.author,
    snippet: row.snippet ?? null, mergedHow: row.mergedHow ?? null, mergedAt: row.mergedAt ?? null, discord: row.discord, phaseScoped: false,
  };
}

export function factsFromStatusRow(row: ItemStatusRow): RowFacts {
  return {
    key: refKey(row), repo: row.repo, number: row.number, kind: row.kind, state: row.state, title: row.title, updatedAt: row.updatedAt,
    status: row.status, stage: null, queue: null, flags: [], author: row.author ?? undefined, checks: row.checks, closes: row.closes, phaseScoped: true,
  };
}

/** The strip's status word: the pipeline stage, else what the item waits for. */
/** The strip's word, or null when the row has no stage, queue or phase fact to name. */
export function rowWord(facts: RowFacts): string | null {
  return facts.stage || facts.queue || facts.status ? statusWord(facts) : null;
}

export function statusWord(facts: RowFacts): string {
  if (facts.stage) return STAGE_LABEL[facts.stage] ?? facts.stage;
  if (facts.queue) return QUEUE_TEXT(facts.queue);
  if (facts.status) return facts.status.waiting ?? facts.status.next ?? "No wait recorded";
  return "No pipeline stage";
}

export const QUEUE_TEXT = (queue: QueueSlot): string => `${queue.stage} · place ${queue.place}`;

/** Last events: newest first, capped, from the selected expansion's real timeline. */
export function lastEvents(timeline: TimelineEntry[] | undefined, cap = 3): TimelineEntry[] {
  return [...(timeline ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, cap);
}

export interface DetailFact { label: string; value: string }
const FLAG_TEXT = (flag: string) => (flag === "needs decision" ? "Needs a decision" : flag === "security" ? "Security" : flag);

/** Old row metadata kept readable inside the expansion rather than crowding the row. */
export function detailFacts(facts: RowFacts, item?: Item | null): DetailFact[] {
  const out: DetailFact[] = [];
  const add = (label: string, value: string | null | undefined) => { if (value) out.push({ label, value }); };
  add("Author", facts.author ?? item?.author);
  add("Kind", `${facts.kind === "pr" ? "Pull request" : "Issue"} · ${facts.state}`);
  if (facts.flags.length) add("Flags", facts.flags.map(FLAG_TEXT).join(", "));
  const discord = facts.discord ?? item?.discord?.count;
  add("Discord", discord ? `${discord} ${discord === 1 ? "message" : "messages"}` : undefined);
  add("Labels", item?.labels.length ? item.labels.join(", ") : undefined);
  if (!facts.phaseScoped) {
    if (facts.mergedHow) add("Merged", `${facts.mergedHow === "rule" ? "By rule" : facts.mergedHow === "operator" ? "On approval" : "In a batch"}${facts.mergedAt ? ` · ${facts.mergedAt}` : ""}`);
    if (facts.snippet) add("Matched", facts.snippet.text.replace(/\u0002|\u0003/g, ""));
  }
  add("Stage", facts.stage ? STAGE_LABEL[facts.stage] ?? facts.stage : undefined);
  add("Queue", facts.queue ? QUEUE_TEXT(facts.queue) : item?.queue ? QUEUE_TEXT(item.queue) : facts.phaseScoped ? undefined : "Not queued");
  if (facts.status) {
    add("Phase", facts.status.phase);
    add("Waiting for", facts.status.waiting ?? undefined);
    add("Next", facts.status.next ?? undefined);
    add("In this phase since", eventTime(facts.status.since));
  }
  return out;
}

/** True when the link's selection does not name a row of the loaded cohort. */
export function selectionOutside(selection: Selection, keys: Iterable<string>): boolean {
  if (!selection.open) return false;
  for (const key of keys) if (key === refKey(selection.open)) return false;
  return true;
}

export interface SelectionProblem { title: string; message: string; href?: string }

/** What to say when the link's selection cannot become a row (never a fabricated match). */
export function selectionProblem(selection: Selection, keys: Iterable<string>): SelectionProblem | null {
  const loaded = [...keys];
  if (selection.openRaw !== undefined && !selection.open) {
    return { title: "This item link is invalid", message: "The link's open value is not a repo#number, so no row can be opened. Close it to go back to the list." };
  }
  if (selection.open && !loaded.includes(refKey(selection.open))) {
    return { title: "That item is not in these results", message: "Filters or paging may hide it. Close the selection or open the full task.", href: itemPath(selection.open.repo, selection.open.number) };
  }
  if (selection.malformedPeek) {
    return { title: "The old preview link is invalid", message: "Its peek value is not a repo#number; the browser left it in the URL untouched." };
  }
  return null;
}

const CLASSIFIER_LABEL: Record<Classifier, string> = { jev: "Jev", haiku: "Haiku", sonnet: "Sonnet", owner: "Owner" };

/** "What the pipeline read": the classifier's own reason, with who said it and when. */
export interface PipelineRead {
  /** The classifier's reason, verbatim; empty string when the role gets it redacted. */
  text: string;
  /** The classifier's display name. */
  classifier: string;
  at: string;
  /** True when this is the record that produced the settled label; false when it is the latest available. */
  matchedSource: boolean;
}

/**
 * The reference's `why`, from the item's own classification record (api.item -> Item.classifications).
 * `classificationsOf` returns the latest record per classifier, not sorted by time, so: prefer the
 * record from the source that settled the label, else the newest available, and say which it is.
 * The caller shows an explicit empty state for a redacted or absent reason; nothing is substituted.
 */
export function pipelineRead(item: Pick<Item, "classifications"> | null | undefined, settled: Settled | undefined): PipelineRead | null {
  const records = item?.classifications ?? [];
  if (!records.length) return null;
  const newest = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]!;
  const matched = settled?.source ? records.find((record) => record.classifier === settled.source) : undefined;
  const chosen: Classification = matched ?? newest;
  return { text: (chosen.reason ?? "").trim(), classifier: CLASSIFIER_LABEL[chosen.classifier] ?? chosen.classifier, at: chosen.at, matchedSource: !!matched };
}

/** A phase row's own payload has no classification; the selected row's item GET does. */
export function effectiveSettled(facts: RowFacts, item: Item | null | undefined): Settled | undefined {
  return facts.settled ?? item?.settled;
}

/** A read's data is usable only when it is not loading, not failed, and names this row. */
export function receipt<T extends { repo: string; number: number }>(data: T | undefined | null, state: { loading: boolean; error?: string }, ref: OpenRef): T | null {
  if (!data || state.loading || state.error) return null;
  return data.repo === ref.repo && data.number === ref.number ? data : null;
}

/**
 * A decision receipt: the item's own decision must match this row; a batch decision (number null)
 * is accepted because the endpoint already resolved it to this item by membership.
 */
export function decisionReceipt<T extends { repo: string; number: number | null }>(data: T | null | undefined, state: { loading: boolean; error?: string }, ref: OpenRef): T | null {
  if (state.loading || state.error) return null;
  if (!data) return null;
  return data.number == null || (data.repo === ref.repo && data.number === ref.number) ? data : null;
}

/* ---- event timestamps (absolute, Items-local) -------------------------------------------------
   The reference prints an event's absolute time (`atAbs`, "Today 08:20"), not a relative one. The
   shared `eventTime` stays as it is for row ages and other surfaces. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `Today 08:20`, `Yesterday 14:05`, `Nov 3 14:32`, `Nov 3 2025 14:32`; "Time unknown" for an unparseable value. */
export function absoluteEventTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Time unknown";
  const d = new Date(t);
  const n = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? `${md} ${clock}` : `${md} ${d.getFullYear()} ${clock}`;
}

/** The machine-readable companion of the printed time; absent when the value is not a date. */
export function eventDateTime(iso: string): string | undefined {
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

/* ---- execution of an answer (separate from classification) ------------------------------------ */

export interface AnswerFacts {
  /** The answer is recorded; this is its execution state in words. */
  state: string;
  tone: "ok" | "warn" | "bad" | "neutral";
  reason: string | null;
  appliedAt: string | null;
  /** True when the answer is disputed and therefore held: the pipeline ignores it until kept or undone. */
  disputed: boolean;
}

/**
 * The reference shows execution separately when the selected item's decision has an answer, and
 * "Answer exists · <state>" in Queue place. Our fields are `Decision.answer`, `exec.state`
 * (pending / waiting-token / waiting-permission / done / failed, with a reason) and `appliedAt`;
 * there is no "held" state in this DTO, so it is never invented.
 */
export function answerFacts(decision: Pick<Decision, "answer" | "exec" | "appliedAt" | "dispute"> | null | undefined): AnswerFacts | null {
  if (!decision?.answer) return null;
  const exec = decision.exec ?? null;
  // An applied answer is applied, whatever anyone disputed afterwards.
  if (decision.appliedAt) return { state: "Answer applied", tone: "ok", reason: null, appliedAt: decision.appliedAt, disputed: false };
  // A disputed, unapplied answer is held: `Decision.dispute` says the pipeline ignores it until the
  // answerer or an operator keeps it or undoes it. That is the reference's "held", and it outranks
  // any write state the answer had before the dispute (a pending write the pipeline is ignoring).
  if (decision.dispute) {
    return { state: "Answer held", tone: "warn", reason: decision.dispute.reason?.trim() || null, appliedAt: null, disputed: true };
  }
  const state: Record<ExecState, AnswerFacts> = {
    done: { state: "Answer applied", tone: "ok", reason: null, appliedAt: decision.appliedAt ?? null, disputed: false },
    failed: { state: "Answer failed", tone: "bad", reason: exec?.reason ?? null, appliedAt: null, disputed: false },
    pending: { state: "Answer pending", tone: "warn", reason: exec?.reason ?? null, appliedAt: null, disputed: false },
    "waiting-token": { state: "Answer waiting for sign-in", tone: "warn", reason: exec?.reason ?? null, appliedAt: null, disputed: false },
    "waiting-permission": { state: "Answer waiting for permission", tone: "warn", reason: exec?.reason ?? null, appliedAt: null, disputed: false },
  };
  return exec ? state[exec.state] : { state: "Answer recorded, not applied yet", tone: "neutral", reason: null, appliedAt: null, disputed: false };
}

/** The ignored-peek note, built once; views hold it scoped to its own conflict selection. */
export function conflictNote(peek: string): string {
  return `The link's old peek (${peek}) was ignored; open wins.`;
}

/** Queue place for an answered decision: the reference says "Held — disputed" for a held answer. */
export function answerQueueText(answer: AnswerFacts): string {
  return answer.disputed ? "Held — disputed" : answer.state;
}

/**
 * The list payload carries the reader it was fetched for. A payload from another login or role is
 * discarded, so the previous reader's rows — which can carry reasons the server redacts per role —
 * never render while the new scope's own read is pending or after it failed. A filter change keeps
 * the same scope, so the previous rows stay visible while the new ones load (the accepted behaviour).
 */
export function scopedPayload<T>(receipt: { scope: string; payload: T } | undefined, scope: string): T | undefined {
  return receipt && receipt.scope === scope ? receipt.payload : undefined;
}

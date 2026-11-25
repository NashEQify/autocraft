// A model reading of text the command parser could not read, on every surface. When parse() gives `ambiguous` and the sender may
// send commands on the items, Haiku translates the text into one command in the parser's words: on the sender's own Task Runner
// first (a bound call, outside its slots), else on any Task Runner's Interactive slots, never on pipeline slots. The command must
// parse in full and name no item the message does not; Jev then scores whether the message asks for exactly it (Haiku's own
// confidence when Jev gives no answer). At READ_RUN_SCORE or more it runs through runCommand as if the sender had typed it, unless
// the text hedges (a hold runs anyway); below, the reply proposes it. With no reading (no Task Runner took the call, it failed or
// timed out, or the model found it unclear) the reply is the parser's own. The text goes only into the calls, whose recorded
// texts are deleted when they end; each reading is logged as a `read` event with the text's hash.
import { createHash } from "node:crypto";
import { runModelStep, type ClaudeStep, type JevStep } from "../agents/step.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { removeRunTexts } from "../data/inference/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { loadWorkflowHistory, recordEvents } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { actRefusal } from "../github/identity.ts";
import { t } from "../i18n/index.ts";
import { ownerOf } from "../owners.ts";
import { JEV_PROMPTS } from "../prompts/index.ts";
import { runCommand, type Actor, type CommandInput, type CommandResult } from "./apply.ts";
import { parse, type ParseOptions } from "./parse.ts";
import { jevExact, parseTranslation, READ_ITEMS_MAX, READ_TEXT_CHARS, scoreState, type ReadAsk, type ReadItem, type ScoreAsk } from "./read-ask.ts";
import { isLive } from "./resolve.ts";
import { recommendationText } from "./status.ts";
import { openRecommendation, type ItemRef, type Parsed, type Surface } from "./types.ts";

/** The score from which a command read from a message runs without asking. */
export const READ_RUN_SCORE = 0.9;
/** The longest a reading may take, from the first call to the score; past it the parser's own reply goes out. */
export const READ_WAIT_MS = 90_000;
/** How long each translate call waits in the queue for a Task Runner to take it. */
export const READ_TAKE_WAIT_MS = 8_000;
/** The step the calls are recorded under; their texts are deleted when they end. */
const READ_STEP = "command-read";
/** Words and marks that negate, hedge or ask: such a text never runs a reading directly, unless it is a hold. */
const HEDGE = /(?<![\w-])(?:not|don't|dont|never|maybe|unless|perhaps)(?![\w-])|n't(?![\w-])|\?/i;

export type Translation = { command: string | null; confidence: number };
export type Reading = { command: string; parsed: Parsed; score: number; source: "jev" | "haiku" };

/** What tests replace: the translate call (null: no answer) and Jev's score (null: no answer). */
export type ReadDeps = {
  translate?: (db: Db, ask: ReadAsk, login: string) => Promise<Translation | null>;
  score?: (db: Db, ask: ScoreAsk) => Promise<number | null>;
};

export type ReadText = {
  /** What the person wrote, as the model reads it. */
  text: string;
  /** The items the message was written on, or names. */
  own: readonly ItemRef[];
  /** The command must name its items (a surface with no item of its own): each one among `own`. Otherwise it names none or only those. */
  named: boolean;
  /** How the command read is parsed (the item's repo for a bare #n). */
  parse?: ParseOptions;
  /** Settles what the command needs before it runs (GitHub: the PR head at the comment), or a line saying why it cannot run. */
  pin?: (p: Parsed) => Promise<Partial<CommandInput> | string>;
  deps?: ReadDeps;
};

const lower = (s: string): string => s.toLowerCase();
const nameOf = (repo: string): string => lower(repo.split("/").pop()!);

const sameRef = (a: ItemRef, b: ItemRef): boolean => a.number === b.number && nameOf(a.repo) === nameOf(b.repo);

/** Items a text names, each once: `owner/name#n`, `name#n`, a GitHub URL, and with `repo` a bare `#n`. */
export function refsIn(text: string, repo?: string): ItemRef[] {
  const out: ItemRef[] = [];
  const add = (r: ItemRef): void => { if (!out.some((o) => sameRef(o, r))) out.push(r); };
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gi)) add({ repo: m[2]!, number: Number(m[3]) });
  for (const m of text.matchAll(/(?<![\w./#-])(?:[\w.-]+\/)?([\w.-]+)#(\d+)(?!\d)/g)) add({ repo: m[1]!, number: Number(m[2]) });
  if (repo) for (const m of text.matchAll(/(?<![\w./#-])#(\d+)(?!\d)/g)) add({ repo, number: Number(m[1]) });
  return out;
}

/** The command's items and every item its words name (a duplicate's original, an autorepin target) are the message's own. */
function namesOwn(p: Parsed, command: string, read: ReadText): boolean {
  if (p.kind === "ambiguous") return false;
  const items = p.items ?? [];
  if (read.named && !items.length) return false;
  const allowed = [...read.own, ...refsIn(read.text, read.parse?.repo)];
  const home = read.parse?.repo ?? read.own[0]?.repo ?? "";
  const originals = p.kind === "commands" ? p.parts.flatMap((x) => (x.word === "close" && x.reason?.as === "duplicate" ? [{ repo: x.reason.of.repo ?? home, number: x.reason.of.number }] : [])) : [];
  // A bare #n in the command's words is a plan part or an item the parse already resolved; named items are checked by name.
  return [...items, ...originals, ...refsIn(command)].every((i) => allowed.some((o) => sameRef(i, o)));
}

/** The sender may send commands on every item: a tracked repo, and the act rule (actRefusal) lets them. */
async function mayRead(db: Db, actor: Actor, own: readonly ItemRef[]): Promise<boolean> {
  if (!own.length || !actor.login) return false;
  const tracked = await loadTrackedRepos(db);
  for (const i of own) {
    const [owner, name] = i.repo.includes("/") ? i.repo.split("/", 2) as [string, string] : [null, i.repo];
    if (!tracked.has(name) || (owner !== null && lower(owner) !== lower(ownerOf(name)))) return false;
    if (await actRefusal(db, actor, name)) return false;
  }
  return true;
}

/** The call's input: the text, and each item's kind, AutoCraft's work on it and an open question with its plan parts (left out on a quiet item). */
async function askOf(db: Db, read: ReadText): Promise<ReadAsk> {
  const refs = read.own.slice(0, READ_ITEMS_MAX).map((i) => ({ repo: i.repo.split("/").pop()!, number: i.number }));
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  const [items, history, quiet] = await Promise.all([loadItems(db, refs, "pr"), loadWorkflowHistory(db, refs), loadQuiet(db, keys)]);
  const out: ReadItem[] = [];
  for (const key of keys) {
    const it = items.get(key as never);
    if (!it) continue;
    const all = history.get(key) ?? [];
    const wf = all.findLast((w) => isLive(w)) ?? all.at(-1) ?? null;
    const rec = isLive(wf) ? openRecommendation(wf) : null;
    const veiled = quiet.has(key);
    out.push({
      ref: key, kind: it.kind === "pr" ? "pull request" : "issue", work: wf ? wf.state : "not started",
      ...(rec && !veiled ? { question: recommendationText(rec), parts: wf!.plan.filter((p) => p.state !== "dropped").map((p) => ({ n: p.n, title: p.title })) } : {}),
    });
  }
  return { ...(keys[0] ? { ref: keys[0] } : {}), message: read.text.slice(0, READ_TEXT_CHARS), items: out };
}

const TRANSLATE = (id: "command.read" | "interactive.command-read"): ClaudeStep<ReadAsk, Translation> => ({
  provider: "claude", id,
  toPrompt: (a) => [a],
  parse: async (text) => {
    const v = parseTranslation(text);
    return v === null ? null : { value: v };
  },
});
const SCORE: JevStep<ScoreAsk, number> = {
  provider: "jev", id: "command.read.jev",
  request: (a) => ({ item: { ref: "command" }, body: JSON.stringify({ ...JEV_PROMPTS["command.read.jev"].request, state: scoreState(a) }) }),
  parse: (answers, _a, ctx) => {
    const p = ctx.code === 0 ? jevExact(answers) : null;
    return p === null ? null : { value: p };
  },
};

/** One translate call; null when no Task Runner took it in time or it gave no answer. */
async function translateOn(db: Db, id: "command.read" | "interactive.command-read", a: ReadAsk, forLogin?: string): Promise<Translation | null> {
  try {
    const r = await runModelStep(db, TRANSLATE(id), a, { maxWaitMs: READ_TAKE_WAIT_MS, ...(forLogin ? { forLogin } : {}) });
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/** The sender's own Task Runner first; when it gives no answer, any Task Runner with a free Interactive slot. */
async function translate(db: Db, a: ReadAsk, login: string): Promise<Translation | null> {
  try {
    return await translateOn(db, "command.read", a, login) ?? await translateOn(db, "interactive.command-read", a);
  } finally {
    await removeRunTexts(db, { steps: [READ_STEP], finishedOnly: true }).catch(() => 0);
  }
}

async function score(db: Db, a: ScoreAsk): Promise<number | null> {
  try {
    const r = await runModelStep(db, SCORE, a);
    return r.ok ? r.value : null;
  } catch {
    return null;
  } finally {
    await removeRunTexts(db, { steps: [READ_STEP], finishedOnly: true }).catch(() => 0);
  }
}

/** The command a model reads in the text, checked by the parser and scored; null when there is none. */
export async function readCommand(db: Db, login: string, read: ReadText): Promise<Reading | null> {
  const ask = await askOf(db, read);
  const tr = await (read.deps?.translate ?? translate)(db, ask, login);
  if (!tr?.command) return null;
  const parsed = parse(tr.command, read.parse);
  if (!namesOwn(parsed, tr.command, read)) return null;
  const p = await (read.deps?.score ?? score)(db, { message: ask.message, command: tr.command });
  return p === null ? { command: tr.command, parsed, score: tr.confidence, source: "haiku" } : { command: tr.command, parsed, score: p, source: "jev" };
}

/** Resolves after `ms` with null, or with the promise's value; a rejection is null. */
const within = <T>(ms: number, p: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
};

const isHold = (p: Parsed): boolean => p.kind === "commands" && p.parts.length > 0 && p.parts.every((x) => x.word === "hold");

/** Whether a reading runs without asking: a score at READ_RUN_SCORE or more, and no hedge in the text unless it is a hold. */
export const readingRuns = (r: Reading, text: string): boolean => r.score >= READ_RUN_SCORE && (isHold(r.parsed) || !HEDGE.test(text));

/** Adds the note to every item's line and to the reply. */
function noted(res: CommandResult, note: string): CommandResult {
  const items = res.items.map((o) => ({ ...o, line: `${o.line} ${note}` }));
  return { items, lines: items.length === 1 ? [items[0]!.line] : [...res.lines, note] };
}

/**
 * Runs text the way every surface does: through runCommand. Text the parser could not read, from a sender who may send commands
 * on `read.own`, is read by a model first (see the file comment). `read` null: no reading on this path.
 */
export async function runText(db: Db, actor: Actor, via: Surface, input: CommandInput, read: ReadText | null): Promise<CommandResult> {
  if (input.parsed.kind !== "ambiguous" || !read || !actor.login || !await mayRead(db, actor, read.own)) return await runCommand(db, actor, via, input);
  const reading = await within(READ_WAIT_MS, readCommand(db, actor.login, read));
  if (!reading) return await runCommand(db, actor, via, input);
  const runs = readingRuns(reading, read.text);
  const hash = createHash("sha256").update(read.text).digest("hex").slice(0, 16);
  const line = t("Read “{command}” from a message ({hash}): {source} {score}, {outcome}.", { command: reading.command, hash, source: reading.source === "jev" ? "Jev" : "Haiku", score: reading.score.toFixed(2), outcome: runs ? t("run") : t("proposed") });
  const at = input.at ?? new Date().toISOString();
  // Logged before the command's own event, which stays the item's latest.
  await recordEvents(db, read.own.map((i) => ({ workflowId: null, repo: i.repo.split("/").pop()!, number: i.number, login: actor.login!, via, kind: "read" as const, parsed: reading.parsed, line, at })));
  const items = input.items.length ? input.items : [...read.own];
  if (!runs) return await runCommand(db, actor, via, { ...input, items, proposed: reading.command });
  const note = t("Read from your words as `{command}`.", { command: reading.command });
  const pinned = read.pin ? await read.pin(reading.parsed) : {};
  if (typeof pinned === "string") {
    return noted({ items: items.map((x) => ({ repo: x.repo, number: x.number, outcome: "refused", line: pinned, workflowId: null })), lines: [pinned] }, note);
  }
  const parsed = read.named || reading.parsed.kind === "ambiguous" ? reading.parsed : { ...reading.parsed, items: [] };
  return noted(await runCommand(db, actor, via, { ...input, ...pinned, items, parsed }), note);
}

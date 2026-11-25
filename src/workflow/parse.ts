// Free text to commands, the same on every surface: a GitHub comment, the Discord slash command, the agent's tools and the
// dashboard's text box. Deterministic and without a model call. Anything it cannot read in full comes back `ambiguous` with
// what it did read, and nothing runs from it; resolve.ts then applies the item's state.
//
//   fix-up and merge, urgent         combined commands; a weight word anywhere (urgent, high, low, or weight <1-10>)
//   fix 1 and 2, drop 3, then merge  an answer naming plan parts by number
//   drop export dialog               a part named by words from its title (resolve.ts matches them)
//   merge: photocraft#12 #15         a list of items after a colon; a bare number takes the repo before it
//   review photocraft#12 urgent      items written inline: repo#n, owner/repo#n, a GitHub link, or #n after one (or in an item's context)
//   close as duplicate of #12        a close with its reason: completed, not planned, or duplicate of an item
//   yes / lgtm / go                  runs the open recommendation
//   stop / no, wait / hold for now   a message that only says to hold, with nothing else asked for, is a hold
import { commentLines } from "../github/comment-lines.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { WEIGHT_MAX, WEIGHT_MIN, WEIGHT_WORDS, type CloseReason, type CommandPart, type ItemRef, type Parsed, type WeightWord } from "./types.ts";
import { commandOf, COMMANDS, HOLD_WORDS, weightWord, YES_TRAILERS, YES_WORDS } from "./vocab.ts";

export type ParseOptions = {
  /** The app's slug, and its mention name when set: a leading `@<slug>` (or `@<slug>[bot]`) is not part of the command. */
  slug?: string | readonly string[];
  /** The repo of the item the text was written on: a bare number before any `repo#n` in a list, or an inline `#n`, takes it. */
  repo?: string;
};

/** GitHub caps a comment body at 65536 characters. */
const BODY_MAX = 65_536;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (names: readonly string[]): RegExp => new RegExp(`^@(?:${names.map(escape).join("|")})(?:\\[bot\\])?(?=[\\s,:]|$)[\\s,:]*`, "i");
const isWeightWord = (w: string): w is WeightWord => Object.hasOwn(WEIGHT_WORDS, w);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A close's reason as a command writes it: `as not planned`, `as duplicate of photocraft#12`. */
export const closeText = (r: CloseReason): string =>
  r.as === "duplicate" ? `as duplicate of ${r.of.repo ?? ""}#${r.of.number}` : r.as === "not-planned" ? "as not planned" : "as completed";

const CLOSE_RE = /^close\s+(?:as\s+)?(?:(completed)|(not[-\s]planned)|(?:a\s+)?duplicate\s+of\s+(\S+))$/i;

/** The reason after `close`, or null for anything else. */
function readClose(seg: string): CloseReason | null {
  const m = CLOSE_RE.exec(seg);
  if (!m) return null;
  if (m[1]) return { as: "completed" };
  if (m[2]) return { as: "not-planned" };
  const short = /^#(\d+)$/.exec(m[3]!);
  const ref = short ? { repo: null, number: Number(short[1]) } : refOf(m[3]!);
  return ref && Number.isSafeInteger(ref.number) && ref.number > 0 ? { as: "duplicate", of: { repo: ref.repo, number: ref.number } } : null;
}

/** The canonical text of parts and items, as an ambiguous reply quotes what was understood: `fix 1, merge, urgent: photocraft#12`. */
export function describe(parts: readonly CommandPart[], items: readonly ItemRef[] = []): string {
  const words = parts.map((p) => {
    if ("part" in p) return `${p.word} ${p.part}`;
    if ("weight" in p) return weightWord(p.weight) ?? `weight ${p.weight}`;
    if (p.word === "close") return p.reason ? `close ${closeText(p.reason)}` : "close";
    return p.args ? `${p.word} ${p.args}` : p.word;
  }).join(", ");
  const refs = items.map((i) => `${i.repo}#${i.number}`).join(" ");
  return items.length ? (words ? `${words}: ${refs}` : refs) : words;
}

/** Reads text written to AutoCraft. */
export function parse(text: string, opts: ParseOptions = {}): Parsed {
  let s = text.trim();
  const names = [opts.slug ?? []].flat().filter(Boolean);
  if (names.length) s = s.replace(mentionRe(names), "");
  // The list form: the command, a colon, then the items. A colon that starts `://` belongs to a URL.
  const list = /^([^:\n]+?):(?!\/\/)([\s\S]*)$/.exec(s);
  const head = list ? list[1]! : s;
  const inline = pullItems(head, opts.repo);
  const marked = pullItems(head, opts.repo, true);
  let items = inline.items;
  s = inline.text;
  // The items an ambiguous reply may quote: not those that stood inside words it could not read.
  const named = (r: Read, all: ItemRef[]): ItemRef[] => {
    const lost = [...r.tainted].map((id) => marked.marks[id]!.ref);
    return all.filter((i) => !lost.some((l) => l.repo === i.repo && l.number === i.number) || !inline.items.some((x) => x.repo === i.repo && x.number === i.number));
  };
  if (list) {
    const read = readItems(list[2]!, inline.last ?? opts.repo);
    items = addItems(items, read.items);
    if (read.bad.length || !read.items.length) {
      const r = readWords(marked.text, marked.marks);
      return { kind: "ambiguous", understood: describe(r.parts, named(r, items)), rest: [...r.unknown, ...read.bad].join(" ") };
    }
  }
  const yes = readYes(s);
  if (yes) return { kind: "yes", ...(items.length ? { items } : {}), ...(yes.weight === null ? {} : { weight: yes.weight }) };
  if (saysHold(s)) return { kind: "commands", items, parts: [{ word: "hold" }] };
  const r = readWords(marked.text, marked.marks);
  if (r.unknown.length || r.conflict || !r.parts.length) return { kind: "ambiguous", understood: describe(r.parts, named(r, items)), rest: r.unknown.join(", ") };
  return { kind: "commands", items, parts: r.parts, ...(r.yes ? { yes: true } : {}) };
}

/**
 * The command in a GitHub comment, or null when no line of it is addressed to the app. A command starts on a line of its own with
 * `@<slug>`; quoted, fenced, indented and HTML-commented lines never count (commentLines). In the list form, the lines after
 * `@<slug> merge:` up to the next blank or hidden line are the items. Several addressed lines are read as one text, so an unclear
 * mix is ambiguous rather than half run. A command whose comment goes on with a condition ("merge", then "after CI is green") is
 * ambiguous too; a hold stands, whatever the comment says about it.
 */
export function parseComment(body: unknown, slug: string | readonly string[], opts: Omit<ParseOptions, "slug"> = {}): Parsed | null {
  const names = [slug].flat().filter(Boolean);
  if (typeof body !== "string" || !names.length) return null;
  const lines = commentLines(body.slice(0, BODY_MAX));
  const mention = mentionRe(names);
  const texts: string[] = [];
  let condition: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!mention.test(line)) continue;
    let text = line.replace(mention, "");
    if (/^[^:]+:(?!\/\/)/.test(text)) {
      while (i + 1 < lines.length && lines[i + 1] && !mention.test(lines[i + 1]!)) text += `\n${lines[++i]}`;
    }
    texts.push(text);
    condition ??= conditionIn(lines.slice(i + 1), mention);
  }
  if (!texts.length) return null;
  const p = parse(texts.join("\n"), opts);
  if (condition === null || (p.kind === "commands" && p.parts.every((x) => x.word === "hold"))) return p;
  if (p.kind === "ambiguous") return { ...p, rest: [p.rest, condition].filter(Boolean).join(", ") };
  return { kind: "ambiguous", understood: p.kind === "yes" ? "yes" : describe(p.parts, p.items), rest: condition };
}

/** Words that open a condition on what was said before. */
const CONDITION = /^(?:if|unless|but|wait|after|when|until|not)$/;
/** Words a condition may start with before its own ("please only merge it when ..."). */
const LEAD_IN = new Set(["and", "so", "then", "only", "just", "please", "pls", "also", "though", "maybe", "perhaps", "thanks", "ok", "okay", "yes", "no", "let", "us", "lets", "let's", "i", "i'd", "we", "we'd", "would", "should", "do", "go", "land", "merge", "it", "this", "that", "the"]);

/**
 * The sentence with a condition in what follows an addressed line, up to the end of the next paragraph, or null. A condition opens its line or
 * clause ("but wait for CI", "only merge it when CI is green"); the same word inside another sentence ("it crashed when a file was empty") is a reason.
 * `don't` counts as `do not`; unless and until count anywhere.
 */
function conditionIn(after: readonly string[], mention: RegExp): string | null {
  let gaps = 0, text = false;
  for (const line of after) {
    if (mention.test(line)) return null;
    if (!line) { gaps += text || gaps === 0 ? 1 : 0; text = false; if (gaps > 2) return null; continue; }
    text = true;
    if (gaps > 1) return null;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      for (const clause of sentence.toLowerCase().replace(/\u2019/g, "'").replace(/\bdon'?t\b/g, "do not").split(/[,;:()]|\s[-\u2013\u2014]\s/)) {
        const words = clause.replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/^[\s-]+/, "").split(/\s+/).filter(Boolean);
        if (CONDITION.test(words.find((w) => !LEAD_IN.has(w)) ?? "") || words.some((w) => w === "unless" || w === "until")) return sentence.replace(/[.!]+$/, "").slice(0, 200);
      }
    }
  }
  return null;
}

type Read = { parts: CommandPart[]; unknown: string[]; conflict: boolean; /** A yes-word stood beside the commands ("yes, merge"). */ yes: boolean; /** Inline items that stood inside words that were not read. */ tainted: ReadonlySet<number> };

/** A yes-word with nothing else but a weight and politeness: `yes`, `lgtm, thanks`, `go ahead, urgent`. */
function readYes(s: string): { weight: number | null } | null {
  let weight: number | null = null;
  let bad = false;
  const setW = (w: number) => { if (weight !== null && weight !== w) bad = true; weight = w; };
  let t = norm(s.replace(/[,.!;]+/g, " "));
  t = t.replace(/(^| )weight (\d+)(?= |$)/g, (_m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) bad = true;
    else setW(w);
    return pre;
  });
  const words = t.split(" ").filter((w) => {
    if (!isWeightWord(w)) return true;
    setW(WEIGHT_WORDS[w]);
    return false;
  });
  let rest = words.join(" ");
  for (let again = true; again;) {
    again = false;
    for (const tr of YES_TRAILERS) if (rest.endsWith(` ${tr}`)) { rest = rest.slice(0, -tr.length - 1); again = true; }
  }
  return !bad && YES_WORDS.includes(rest) ? { weight } : null;
}

/**
 * Filler a maintainer writes around a command word: "please merge it now", "ok go ahead and merge", "yes, merge the PR". A small
 * explicit list; words that change a meaning (don't, not, no, wait, hold, later, unless, but, if, instead) are never in it, so such
 * a reply stays unread.
 */
const FILLER = /(?<![\w-])(?:thank you|the pull request|the pr|the rest|go ahead|sounds good|lgtm|yes|yep|yeah|ok|okay|sure|please|pls|thanks|thx|now|it|this|that)(?![\w-])/gi;
const stripFiller = (seg: string): string => seg.replace(FILLER, " ").replace(/\s+/g, " ").trim();
const saysYes = (seg: string): boolean => (seg.match(FILLER) ?? []).some((w) => YES_WORDS.includes(w.toLowerCase()));

const any = (words: readonly string[]): string => words.map(escape).sort((a, b) => b.length - a.length).join("|");
/** Nothing but a hold word and what people write around one: "no, stop", "let's wait", "hold the merge for now". */
const HOLD_ONLY = new RegExp(`^(?:(?:no|oh|ok|okay|sorry|actually|please|pls|just|let'?s|let us|we should) )*(?:${any(HOLD_WORDS)})(?: (?:${any([...HOLD_WORDS, "please", "pls", "thanks", "thank you", "thx", "for now", "right now", "now", "for a moment", "a moment", "a minute", "a sec", "the merge", "merging", "it", "this", "that", "everything"])}))*$`);
/** What a text beside a hold word may not hold: another command, a yes, or a condition. */
const ASKS = new RegExp(`(?<![\\w-])(?:${any([...COMMANDS.filter((c) => c.word !== "hold").flatMap((c) => [c.word, ...c.aliases]), ...YES_WORDS, "merging", "if", "unless", "until", "but", "after", "when", "then", "not", "instead", "only"])})(?![\\w-])|n't(?![\\w-])`, "i");

/** The message only says to hold: hold words first, and after them nothing that asks for anything ("stop. I will look"). */
function saysHold(s: string): boolean {
  const sentences = s.replace(/\u2019/g, "'").split(/[.!;\n]+/).map((x) => norm(x.replace(/,/g, " "))).filter(Boolean);
  for (let k = sentences.length; k > 0; k--) {
    if (HOLD_ONLY.test(sentences.slice(0, k).join(" "))) return !sentences.slice(k).some((x) => ASKS.test(x));
  }
  return false;
}

/** Commands, separated by commas, semicolons, new lines, `and` or `then`. */
function readWords(src: string, marks: readonly { tok: string }[] = []): Read {
  const tainted = new Set<number>();
  const parts: CommandPart[] = [];
  const unknown: string[] = [];
  const weights: { text: string; w: number }[] = [];
  let yes = false;
  let s = src.trim().replace(/[.!]+$/, "");
  s = s.replace(/(^|[\s,;])weight\s+(\d+)(?=$|[\s,;])/gi, (m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(m.trim());
    else weights.push({ text: m.trim(), w });
    return `${pre} `;
  });
  const takeWeights = (tokens: string[]): string[] => tokens.filter((tok) => {
    const low = tok.toLowerCase();
    if (!isWeightWord(low)) return true;
    weights.push({ text: tok, w: WEIGHT_WORDS[low] });
    return false;
  });
  const push = (p: CommandPart) => {
    const key = JSON.stringify(p);
    if (!parts.some((q) => JSON.stringify(q) === key)) parts.push(p);
  };
  const readSeg = (text: string): void => {
    const before = unknown.length;
    const ids = [...text.matchAll(MARK_RE)].map((m) => Number(m[1]));
    readOne(text.replace(MARK_RE, " "));
    if (unknown.length === before || !ids.length) return;
    // An item named inside words that were not read is part of those words, not a target.
    for (const id of ids) tainted.add(id);
    unknown[unknown.length - 1] = [unknown[unknown.length - 1], ...ids.map((id) => marks[id]?.tok)].filter(Boolean).join(" ");
  };
  const readOne = (raw: string): void => {
    let seg = raw.trim().replace(/\s+/g, " ").replace(/^(?:(?:and then|then|and|please) )+/i, "").replace(/(?: (?:and|&))+$/i, "").trim();
    if (!seg) return;
    if (!/^auto[-\s]?repin(?:\s|$)/i.test(seg)) {
      const bare = stripFiller(seg);
      yes ||= saysYes(seg);
      if (!bare) return;
      // "yes?" asks, so what is left of it says nothing: the words as written are what was not understood.
      if (!/[\p{L}\p{N}]/u.test(bare)) { unknown.push(seg); return; }
      seg = bare;
    }
    const repin = /^auto[-\s]?repin(?:\s+(.+))?$/i.exec(seg);
    if (repin) {
      const args = repin[1]?.trim().replace(/\s+/g, " ") ?? "";
      if (validRepin(args)) push({ word: "autorepin", args });
      else unknown.push(seg);
      return;
    }
    const reason = readClose(seg);
    if (reason) { push({ word: "close", reason }); return; }
    const named = /^(drop|fix)\s+(.+)$/i.exec(seg);
    if (named && !/^fix\s+up(?:\s|$)/i.test(seg)) {
      const word = named[1]!.toLowerCase() as "drop" | "fix";
      const tokens = named[2]!.split(/\s+/);
      const rest = takeWeightsIfNumbers(tokens, weights);
      if (rest) for (const n of rest) push({ word, part: n });
      else push({ word, part: named[2]!.trim().replace(/\s+/g, " ") });
      return;
    }
    if (/^#?\d+(?:\s+#?\d+)*$/.test(seg)) {
      // "fix 1 and 2": a bare number continues the fix or drop before it.
      const last = parts[parts.length - 1];
      if (last && (last.word === "fix" || last.word === "drop") && typeof last.part === "number") {
        for (const n of seg.split(/\s+/)) push({ word: last.word, part: Number(n.replace("#", "")) });
      } else unknown.push(seg);
      return;
    }
    const tokens = takeWeights(seg.split(/\s+/));
    if (!tokens.length) return;
    const text = norm(tokens.join(" "));
    const legacy = /^merge[- ]?queue (\d{1,2})$/.exec(text);
    if (legacy) {
      const w = Number(legacy[1]);
      if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(seg);
      else { weights.push({ text: legacy[1]!, w }); push({ word: "merge" }); }
      return;
    }
    const c = commandOf(text);
    if (c && c.word !== "drop" && c.word !== "fix" && c.word !== "autorepin") push({ word: c.word });
    else unknown.push(seg);
  };
  for (const raw of s.split(/\s*[,;\n]\s*|\s+(?:and\s+then|then|and|&)\s+/i)) readSeg(raw);
  const distinct = [...new Set(weights.map((w) => w.w))];
  const conflict = distinct.length > 1;
  if (conflict) unknown.push(...weights.map((w) => w.text));
  else if (distinct.length) push({ word: "weight", weight: distinct[0]! });
  return { parts, unknown, conflict, yes, tainted };
}

/** The part numbers when the tokens are numbers (with `part`, `finding` or `change` before them, and weight words), else null. */
function takeWeightsIfNumbers(tokens: string[], weights: { text: string; w: number }[]): number[] | null {
  const ns: number[] = [];
  const ws: { text: string; w: number }[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (isWeightWord(low)) ws.push({ text: tok, w: WEIGHT_WORDS[low] });
    else if (/^#?\d+$/.test(tok) && Number(tok.replace("#", "")) > 0) ns.push(Number(tok.replace("#", "")));
    else if (!["part", "parts", "finding", "findings", "change", "changes"].includes(low)) return null;
  }
  if (!ns.length) return null;
  weights.push(...ws);
  return ns;
}

/** `<pull request> [via <branch>]` or `off`, as the existing autorepin command takes them. */
function validRepin(args: string): boolean {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args);
  if (!m) return false;
  if (m[1]!.toLowerCase() === "off") return m[2] === undefined;
  return !!parsePrRef(m[1]!) && (m[2] === undefined || !!parseBranch(m[2]));
}

const URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]\S*)?$/i;
const FULL_RE = /^((?:[\w.-]+\/)?[\w.-]+)#(\d+)$/;

/** The item a token names: a GitHub link or `[owner/]repo#n`; null for anything else. */
function refOf(tok: string): ItemRef | null {
  const url = URL_RE.exec(tok);
  const full = FULL_RE.exec(tok);
  const ref = url ? { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) } : full ? { repo: full[1]!, number: Number(full[2]) } : null;
  return ref && Number.isSafeInteger(ref.number) && ref.number > 0 ? ref : null;
}

const addItems = (into: ItemRef[], more: readonly ItemRef[]): ItemRef[] => {
  for (const r of more) if (!into.some((i) => i.repo === r.repo && i.number === r.number)) into.push(r);
  return into;
};

/** Wraps the index of an item taken out of the text, so the reader can tell which words an item stood in. */
const MARK = "\u0001";
const MARK_RE = /\u0001(\d+)\u0001/g;

/**
 * Items written inline, taken out of the text: `[owner/]repo#n` and GitHub links anywhere, and `#n` when a repo is known (the last
 * one written before it, else `repo`). A `#n` after `drop` or `fix` stays a plan part, and the arguments of autorepin and of a close
 * as a duplicate stay their own. With `mark`, each item leaves a marker in the text instead of nothing.
 */
function pullItems(text: string, repo: string | undefined, mark = false): { text: string; items: ItemRef[]; last: string | null; marks: { tok: string; ref: ItemRef }[] } {
  const items: ItemRef[] = [];
  const marks: { tok: string; ref: ItemRef }[] = [];
  let last = repo ?? null;
  const out = text.replace(/(^|[\s,;(])(https?:\/\/[^\s,;]+|(?:[\w.-]+\/)?[\w.-]*#\d+)(?=$|[\s,;)!?]|\.(?:\s|$))/g, (m, pre: string, raw: string, at: number) => {
    const before = text.slice(0, at + pre.length);
    if (/auto[-\s]?repin\s*$/i.test(before) || /\bduplicate\s+of\s*$/i.test(before)) return m;
    const tok = raw.replace(/[.)!?]+$/, "");
    let ref = refOf(tok);
    if (!ref && /^#\d+$/.test(tok)) {
      if (!last || /\b(?:drop|fix)(?:\s+(?:parts?|findings?|changes?))?(?:(?:\s*[,;]\s*|\s+and\s+|\s+)#?\d+)*(?:\s*[,;]\s*|\s+and\s+|\s+)$/i.test(before)) return m;
      ref = { repo: last, number: Number(tok.slice(1)) };
      if (!Number.isSafeInteger(ref.number) || ref.number < 1) return m;
    }
    if (!ref) return m;
    last = ref.repo;
    addItems(items, [ref]);
    if (!mark) return `${pre} `;
    marks.push({ tok, ref });
    return `${pre} ${MARK}${marks.length - 1}${MARK} `;
  });
  return { text: out, items, last, marks };
}

/** Items in a list: `owner/name#12`, `name#12`, a GitHub URL, or a bare `#12`/`12` taking the repo before it. */
function readItems(text: string, repo: string | undefined): { items: ItemRef[]; bad: string[] } {
  const items: ItemRef[] = [];
  const bad: string[] = [];
  let last = repo ?? null;
  for (const raw of text.split(/[\s,;]+/)) {
    const tok = raw.replace(/[.)]+$/, "");
    if (!tok || /^(?:and|&)$/i.test(tok)) continue;
    const short = /^#?(\d+)$/.exec(tok);
    const ref = refOf(tok) ?? (short && last ? { repo: last, number: Number(short[1]) } : null);
    if (!ref || !Number.isSafeInteger(ref.number) || ref.number < 1) { bad.push(tok); continue; }
    last = ref.repo;
    if (!items.some((i) => i.repo === ref.repo && i.number === ref.number)) items.push(ref);
  }
  return { items, bad };
}

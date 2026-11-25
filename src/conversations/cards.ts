// Action cards: what Opus may propose, checked by our code, and the plain lines a person reads. A card is a registered command
// (src/workflow/vocab.ts) that a press runs as the presser, a comment, or a label. Opus writes resolutions of steps; each step becomes
// the card that carries it out. Descriptions are built here from the parameters; the model never writes them.
import { ownerOf, splitSlug } from "../owners.ts";
import { REFERENCE_LEAK } from "../review/opus-parse.ts";
import { ALL_LABELS, isTypeLabel, sameLabel } from "../labels/set.ts";
import { LOGIN } from "../access.ts";
import { loadAuthoredIn, loadItems } from "../data/mirror/index.ts";
import { loadPermissions, permKey } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import type { NewCard as StoredCard } from "../data/conversations/index.ts";
import { COMMENT_MAX, ISSUE_TITLE_MAX } from "./types.ts";
import type { Db } from "../db/index.ts";

/** An issue a merging command opens once the PR merged (src/conversations/held.ts). */
export type FollowUp = { repo: string; title: string; body: string };

/** A command of the registry: a press runs its text (commandText) through the workflow's runCommand as the presser. */
export type RegistryCommand =
  | { word: "review" }
  | { word: "fix-up"; merge: boolean; followups?: FollowUp[] }
  | { word: "merge"; followups?: FollowUp[] }
  | { word: "backlog" }
  /** `duplicateOf`: the item it duplicates, shown on the card. */
  | { word: "close"; pr: boolean; duplicateOf?: number };

/** Actions with no registered command: the card shows them and a press refuses (actionRefusal). */
export type OtherAction =
  | { word: "reopen" }
  | { word: "open_issue"; repo: string; title: string; body: string }
  | { word: "transfer"; to: string }
  | { word: "assign"; login: string }
  | { word: "request_reviewers"; logins: string[] };

export type Command = RegistryCommand | OtherAction;

/** The comment card's text is the card's `text`. */
export type CardParams = { kind: "command"; command: Command } | { kind: "comment" } | { kind: "label"; label: string; remove: boolean };

export type NewCard = { params: CardParams; text: string | null; description: string };

const REGISTRY = new Set(["review", "fix-up", "merge", "backlog", "close"]);
export const isRegistry = (c: Command): c is RegistryCommand => REGISTRY.has(c.word);

/** The text a press runs: registry words, read by src/workflow/parse.ts. */
export function commandText(c: RegistryCommand): string {
  return c.word === "fix-up" && c.merge ? "fix-up and merge" : c.word;
}

/** Why a press of an action without a registered command runs nothing. */
export const actionRefusal = (c: OtherAction): string =>
  `AutoCraft has no command to ${actionVerb[c.word]}; do it on GitHub`;
const actionVerb: Record<OtherAction["word"], string> = {
  reopen: "reopen an item", open_issue: "open an issue", transfer: "move an issue", assign: "assign someone", request_reviewers: "request reviewers",
};

/** The stored form of a card. */
export const storedCard = (c: NewCard): StoredCard => ({ kind: c.params.kind, params: JSON.stringify(c.params), text: c.text, description: c.description });

/** The card's parameters, or null for a card stored by the retired decision system (or unreadable). */
export function readParams(kind: string, params: string): CardParams | null {
  if (kind !== "command" && kind !== "comment" && kind !== "label") return null;
  try {
    const p = JSON.parse(params) as CardParams;
    return p && typeof p === "object" && p.kind === kind ? p : null;
  } catch { return null; }
}

const followupsOf = (p: CardParams): FollowUp[] =>
  p.kind === "command" && (p.command.word === "merge" || p.command.word === "fix-up") ? p.command.followups ?? [] : [];

/** Whether the press holds issues until the merge: a merging command with follow-ups. */
export const holdsIssues = (p: CardParams): boolean => followupsOf(p).length > 0;

/** One plain line for a command. */
export function commandLine(c: Command): string {
  switch (c.word) {
    case "review": return "Review the PR again";
    case "fix-up": return c.merge ? "Fix up the PR, then merge it if the review and CI pass" : "Fix up the PR";
    case "merge": return "Approve the merge";
    case "backlog": return "Move the item to the Backlog";
    case "close": return c.duplicateOf !== undefined ? `Close as a duplicate of #${c.duplicateOf}` : c.pr ? "Close the PR" : "Close the issue";
    case "reopen": return "Reopen it";
    case "open_issue": return `Open an issue in ${c.repo}: "${c.title}"`;
    case "transfer": return `Move the issue to ${c.to}`;
    case "assign": return `Assign ${c.login}`;
    case "request_reviewers": return `Ask ${c.logins.join(", ")} for a review`;
  }
}

/** What runs, one plain line each. */
export function cardLines(p: CardParams): string[] {
  if (p.kind === "comment") return ["Post the comment below"];
  if (p.kind === "label") return [p.remove ? `Remove the label "${p.label}"` : `Add the label "${p.label}"`];
  return [commandLine(p.command), ...followupsOf(p).map((f) => `After the merge: open an issue in ${f.repo}: "${f.title}"`)];
}

/** The primary button's label. */
export function buttonLabel(p: CardParams): string {
  if (p.kind === "comment") return "Post comment";
  if (p.kind === "label") return p.remove ? "Remove label" : "Add label";
  const c = p.command;
  switch (c.word) {
    case "review": return "Review again";
    case "fix-up": return c.merge ? "Fix up and merge" : "Fix up";
    case "merge": return "Merge";
    case "backlog": return "Move to Backlog";
    case "close": return c.duplicateOf !== undefined ? "Close as duplicate" : c.pr ? "Close PR" : "Close issue";
    case "reopen": return "Reopen";
    case "open_issue": return "Open issue";
    case "transfer": return "Move issue";
    case "assign": return "Assign";
    case "request_reviewers": return "Ask for review";
  }
}

/** The card's first line: the button's action with its key parameter. */
export function headline(p: CardParams): string {
  if (p.kind !== "command") return buttonLabel(p);
  const c = p.command;
  if (c.word === "close" && c.duplicateOf !== undefined) return `Close as duplicate of #${c.duplicateOf}`;
  if (c.word === "transfer") return `Move issue to ${c.to}`;
  if (c.word === "open_issue") return `Open issue in ${c.repo}`;
  return buttonLabel(p);
}

/** The GitHub write the command leads to after the press, or null. */
export function cardEffect(p: CardParams): string | null {
  if (p.kind !== "command") return null;
  const c = p.command;
  if (c.word === "close") return c.pr ? "closes the PR on GitHub" : "closes the issue on GitHub";
  if (c.word === "merge" || (c.word === "fix-up" && c.merge)) return "merges the PR on GitHub once the review and CI pass";
  if (c.word === "transfer") return `moves the issue to ${c.to} on GitHub`;
  return null;
}

/** The one-line description stored with a card. */
export const describe = (repo: string, n: number, p: CardParams): string => `On ${repo}#${n}: ${cardLines(p).join("; ")}`;

/** Whether the card posts text drafted from the item as it was: refused after a push until Opus writes it again. */
export const dependsOnCode = (p: CardParams): boolean =>
  p.kind === "comment" || holdsIssues(p) || (p.kind === "command" && p.command.word === "open_issue");

/** Whether the card puts model-written text on GitHub: refused on a quiet pull request until its fix is published. */
export const postsText = (p: CardParams): boolean =>
  p.kind === "comment" || holdsIssues(p) || (p.kind === "command" && (p.command.word === "open_issue" || p.command.word === "transfer"));

/** The repos a card writes to: its item's, and where it moves the item or opens an issue. */
export function cardRepos(repo: string, p: CardParams | null): string[] {
  const more = !p || p.kind !== "command" ? [] : p.command.word === "transfer" ? [p.command.to] : p.command.word === "open_issue" ? [p.command.repo] : followupsOf(p).map((f) => f.repo);
  return [...new Set([repo, ...more])];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", num: "#", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", colon: ":", sol: "/", period: ".", excl: "!", bsol: "\\" };

/** Decodes numeric and the common named HTML entities, also when encoded twice (`&amp;#64;`). */
export function decodeEntities(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,8}));?/gi, (m, d: string | undefined, h: string | undefined, name: string | undefined) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? m;
      const cp = d ? Number(d) : parseInt(h!, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Model text for a public comment, cleaned like the Act step's comments: entities decoded first (so `&#64;user` cannot notify),
 * then raw HTML, images, links (Markdown, autolinks and bare URLs, keeping a Markdown link's text), cross-repo references and every
 * @ removed. A person who edits a card may add links back.
 */
export function cleanComment(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = decodeEntities(t)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "")
      .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
      .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "")
      .replace(/<\/?[a-z!][^>]*>/gi, "")
      .replace(/<?\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>]*>?/gi, "")
      .replace(/\b[\w.-]+\/[\w.-]+#\d+/g, "")
      .replace(/[@＠﹫]/g, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- checking what Opus proposed ------------------------------------------------------------------------------------

/** What the checks read about the item and the names a reply mentions, loaded once per reply (loadCardFacts). */
export type CardFacts = {
  repo: string;
  n: number;
  item: { kind: string; state: string; author: string | null; labels: string[] } | null;
  quiet: boolean;
  tracked: ReadonlySet<string>;
  /** Numbers of the repo's items the mirror has, among those asked for. */
  known: ReadonlySet<number>;
  /** Logins (lower case), among those asked for, known to write to the repo: a cached write permission, or an owner, member or collaborator association there. */
  writers: ReadonlySet<string>;
};

const labelsOf = (raw: string | null): string[] => {
  try { const l = JSON.parse(raw ?? "[]") as unknown; return Array.isArray(l) ? l.map(String) : []; } catch { return []; }
};

const WRITE = new Set(["write", "maintain", "admin"]);

/** The facts the checks of one item read, in one wave. `numbers` and `logins`: the other items and the people a reply names. */
export async function loadCardFacts(db: Db, repo: string, n: number, want: { numbers?: number[]; logins?: string[] } = {}): Promise<CardFacts> {
  const ref = `${repo}#${n}`;
  const numbers = [...new Set((want.numbers ?? []).filter((x) => Number.isInteger(x) && x > 0 && x !== n))];
  const logins = [...new Set((want.logins ?? []).filter((l) => LOGIN.test(l)).map((l) => l.toLowerCase()))];
  const [items, quiet, tracked, perms, authored] = await db.together(() => Promise.all([
    loadItems(db, [{ repo, number: n }, ...numbers.map((number) => ({ repo, number }))], "card"),
    loadQuiet(db, [ref]),
    loadTrackedRepos(db),
    loadPermissions(db, logins.map((login) => ({ login, repo }))),
    loadAuthoredIn(db, repo, logins, ["OWNER", "MEMBER", "COLLABORATOR"]),
  ]));
  const it = items.get(ref);
  return {
    repo, n, quiet: quiet.size > 0, tracked: new Set(tracked.keys()),
    item: it ? { kind: it.kind, state: it.state, author: it.author, labels: labelsOf(it.labels) } : null,
    known: new Set(numbers.filter((x) => items.has(`${repo}#${x}`))),
    writers: new Set(logins.filter((l) => WRITE.has(perms.get(permKey(l, repo))?.permission ?? "") || authored.has(l))),
  };
}

export type Checked<T> = { value: T } | { note: string };

/** Model text for a comment, cleaned and checked. */
export function commentText(raw: unknown, drop: ReadonlySet<string>): Checked<string> {
  const text = typeof raw === "string" ? cleanComment(raw) : "";
  if (!text) return { note: "dropped a resolution whose comment step has no text" };
  if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a resolution whose comment mentions the reference folder or its documentation" };
  if (text.length > COMMENT_MAX) return { note: `dropped a resolution whose comment is longer than ${COMMENT_MAX} characters` };
  return { value: text };
}

/** Model text for an issue title (one line) or body, cleaned like a comment. */
function issueText(raw: unknown, max: number, what: string, drop: ReadonlySet<string>, oneLine: boolean): Checked<string> {
  const t = typeof raw === "string" ? (oneLine ? cleanComment(raw).replace(/\s+/g, " ") : cleanComment(raw)) : "";
  if (!t) return { note: `dropped a resolution whose open_issue step has no ${what}` };
  if (REFERENCE_LEAK.test(t) || drop.has(t)) return { note: `dropped a resolution whose issue ${what} mentions the reference folder or its documentation` };
  if (t.length > max) return { note: `dropped a resolution whose issue ${what} is longer than ${max} characters` };
  return { value: t };
}

/** A repository name as the model wrote it, without a leading `owner/` of the repo's own owner. */
const bareRepo = (v: unknown): unknown => {
  if (typeof v !== "string" || !v.includes("/")) return v;
  const { owner, name } = splitSlug(v);
  return owner.toLowerCase() === ownerOf(name).toLowerCase() ? name : v;
};

const isPr = (f: CardFacts): boolean => f.item?.kind === "pr";
const isOpen = (f: CardFacts): boolean => f.item?.state === "OPEN";
const sameLogin = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

/** The managed label the model named, or a note. */
function labelOf(raw: unknown): Checked<string> {
  const l = typeof raw === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, raw)) : undefined;
  return l ? { value: l.name } : { note: `dropped a resolution: "${String(raw).slice(0, 40)}" is not a label the pipeline manages` };
}

/** The type label the item has besides `label` (type labels are exclusive), or null. */
export function otherTypeLabel(have: readonly string[], label: string, removing: readonly string[] = []): string | null {
  if (!isTypeLabel(label)) return null;
  return have.find((l) => isTypeLabel(l) && !sameLabel(l, label) && !removing.some((r) => sameLabel(r, l))) ?? null;
}

/** The step kinds that can pass the checks for the item as it is now (the item block's `steps`); "fixup with merge" is listed apart. */
export function applicableSteps(f: CardFacts): string[] {
  if (!f.item || !isOpen(f)) return [];
  const out = ["comment", "label"];
  if (f.item.labels.some((l) => ALL_LABELS.some((x) => sameLabel(x.name, l)))) out.push("unlabel");
  out.push("close", "duplicate");
  if (isPr(f)) out.push("review", "fixup", "fixup with merge", "open_issue");
  return f.quiet ? out.filter((k) => k !== "comment" && k !== "open_issue") : out;
}

const MAX_STEPS = 8;

/** One step as the model wrote it, checked; `merging`: an open_issue step becomes a follow-up of the merge. */
function checkStep(f: CardFacts, st: Record<string, unknown>, removing: readonly string[], drop: ReadonlySet<string>): Checked<Command | { kind: "comment" } | { kind: "label"; label: string; remove: boolean } | FollowUp> {
  const open = isOpen(f), ref = `${f.repo}#${f.n}`;
  switch (st.kind) {
    case "comment": return { value: { kind: "comment" } };
    case "label": case "unlabel": {
      const l = labelOf(st.label);
      if ("note" in l) return l;
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      const remove = st.kind === "unlabel";
      const have = f.item?.labels ?? [];
      if (remove && !have.some((x) => sameLabel(x, l.value))) return { note: `dropped a resolution: the item does not have the label "${l.value}"` };
      const other = remove ? null : otherTypeLabel(have, l.value, removing);
      if (other) return { note: `dropped a resolution: the item already has the type label "${other}" and an item has one type label` };
      return { value: { kind: "label", label: l.value, remove } };
    }
    case "close":
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      return { value: { word: "close", pr: isPr(f) } };
    case "duplicate": {
      const of = st.of;
      if (!Number.isInteger(of) || of === f.n) return { note: "dropped a resolution whose duplicate step names no other item number" };
      if (!f.known.has(of as number)) return { note: `dropped a resolution: ${f.repo}#${of as number} is not in the mirror` };
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      return { value: { word: "close", pr: isPr(f), duplicateOf: of as number } };
    }
    case "review": case "fixup":
      if (!isPr(f) || !open) return { note: `dropped a resolution: a ${String(st.kind)} step needs an open PR` };
      if (st.kind === "review") return { value: { word: "review" } };
      if (st.merge !== undefined && typeof st.merge !== "boolean") return { note: "dropped a resolution whose fixup merge is not true or false" };
      return { value: { word: "fix-up", merge: st.merge === true } };
    case "reopen":
      if (f.item?.state !== "CLOSED") return { note: `dropped a resolution: ${ref} is not closed` };
      return { value: { word: "reopen" } };
    case "open_issue": {
      const repo = bareRepo(st.repo);
      if (typeof repo !== "string" || !f.tracked.has(repo)) return { note: `dropped a resolution: "${String(st.repo).slice(0, 40)}" is not a tracked repository` };
      const title = issueText(st.title, ISSUE_TITLE_MAX, "title", drop, true);
      if ("note" in title) return title;
      const body = issueText(st.body, COMMENT_MAX, "body", drop, false);
      if ("note" in body) return body;
      return { value: { repo, title: title.value, body: body.value } };
    }
    case "transfer": {
      const to = bareRepo(st.to);
      if (isPr(f)) return { note: "dropped a resolution: only an issue can be moved to another repository" };
      if (typeof to !== "string" || !f.tracked.has(to) || to === f.repo) return { note: `dropped a resolution: "${String(to).slice(0, 40)}" is not another tracked repository` };
      if (ownerOf(to).toLowerCase() !== ownerOf(f.repo).toLowerCase()) return { note: "dropped a resolution: an issue moves only between repositories of one owner" };
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      return { value: { word: "transfer", to } };
    }
    case "assign": {
      const login = st.login;
      if (typeof login !== "string" || !LOGIN.test(login)) return { note: "dropped a resolution whose assign step has no GitHub login" };
      if (!sameLogin(f.item?.author, login) && !f.writers.has(login.toLowerCase())) return { note: `dropped a resolution: ${login} is neither the author nor known to have write access to ${f.repo}` };
      return { value: { word: "assign", login } };
    }
    case "request_reviewers": {
      if (!isPr(f)) return { note: "dropped a resolution: reviewers can be requested on a PR only" };
      const raw = st.logins;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 || raw.some((x) => typeof x !== "string" || !LOGIN.test(x))) return { note: "dropped a resolution whose request_reviewers step does not list one to three GitHub logins" };
      const logins = raw as string[];
      if (new Set(logins.map((x) => x.toLowerCase())).size !== logins.length) return { note: "dropped a resolution that requests the same reviewer twice" };
      const bad = logins.find((x) => sameLogin(f.item?.author, x) || !f.writers.has(x.toLowerCase()));
      if (bad) return { note: `dropped a resolution: ${bad} is the PR's author or not known to have write access to ${f.repo}` };
      return { value: { word: "request_reviewers", logins } };
    }
    default:
      return { note: `dropped a resolution with unknown step "${String(st.kind).slice(0, 40)}"` };
  }
}

const isFollowUp = (v: object): v is FollowUp => "title" in v && "body" in v && !("word" in v);
const isCommand = (v: object): v is Command => "word" in v;

/**
 * One resolution as the model wrote it, checked against the item, as the cards that carry out its steps (comments and labels first,
 * then the commands), or why it is dropped. Rules: at most one step of each kind except label and unlabel; close, duplicate and transfer
 * end the item (at most one, last); reopen comes first and not with an ending step; no review or fixup with an ending step. An open_issue
 * step of a resolution that merges (a fixup that merges, or a merge settlement) is held until the merge. A settlement of `merge` or `backlog`
 * becomes that command; any other settlement is dropped with a note.
 */
export function validateResolution(f: CardFacts, c: Record<string, unknown>, drop: ReadonlySet<string>, notes: string[]): Checked<NewCard[]> {
  if (!Array.isArray(c.steps) || c.steps.length > MAX_STEPS) return { note: "dropped a resolution without a list of steps" };
  const raws = c.steps.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {}));
  const removing = raws.flatMap((x) => (x.kind === "unlabel" && typeof x.label === "string" ? [x.label] : []));
  const kinds = raws.map((x) => String(x.kind));
  const checked: (Command | FollowUp | { kind: "comment" } | { kind: "label"; label: string; remove: boolean })[] = [];
  for (const st of raws) {
    const r = checkStep(f, st, removing, drop);
    if ("note" in r) return r;
    checked.push(r.value);
  }
  const count = (k: string) => kinds.filter((x) => x === k).length;
  for (const k of ["comment", "reopen", "open_issue", "assign", "request_reviewers", "review", "fixup"]) if (count(k) > 1) return { note: `dropped a resolution with more than one ${k} step` };
  if (count("review") + count("fixup") > 1) return { note: "dropped a resolution with both a review and a fixup step" };
  const ending = kinds.filter((k) => k === "close" || k === "duplicate" || k === "transfer").length;
  if (ending > 1) return { note: "dropped a resolution that ends the item twice (close, duplicate or transfer)" };
  if (ending === 1 && !["close", "duplicate", "transfer"].includes(kinds[kinds.length - 1]!)) return { note: "dropped a resolution whose close, duplicate or transfer step is not last" };
  if (ending === 1 && (count("review") || count("fixup"))) return { note: "dropped a resolution that closes the PR and also reviews or fixes it up" };
  if (count("reopen") === 1 && (kinds[0] !== "reopen" || ending === 1)) return { note: "dropped a resolution whose reopen step is not first or that also ends the item" };
  const labels = checked.flatMap((x) => ("kind" in x && x.kind === "label" ? [x] : []));
  const added = labels.filter((x) => !x.remove).map((x) => x.label), removed = labels.filter((x) => x.remove).map((x) => x.label);
  if (new Set(added).size !== added.length || new Set(removed).size !== removed.length) return { note: "dropped a resolution that adds or removes the same label twice" };
  if (added.filter(isTypeLabel).length > 1) return { note: "dropped a resolution that adds more than one type label" };
  if (added.some((l) => removed.includes(l))) return { note: "dropped a resolution that adds and removes the same label" };
  if (f.quiet && kinds.some((k) => k === "comment" || k === "open_issue" || k === "transfer")) return { note: "dropped a resolution that posts text on a quiet pull request" };
  let text: string | null = null;
  if (count("comment") === 1) {
    const t = commentText(c.text, drop);
    if ("note" in t) return t;
    text = t.value;
  } else if (c.text !== undefined && c.text !== null && c.text !== "") return { note: "dropped a resolution with a comment text but no comment step" };

  const commands = checked.filter((x): x is Command => isCommand(x));
  const issues = checked.filter((x): x is FollowUp => isFollowUp(x));
  const s = c.settle && typeof c.settle === "object" && !Array.isArray(c.settle) ? c.settle as Record<string, unknown> : null;
  const fix = commands.find((x): x is Extract<RegistryCommand, { word: "fix-up" }> => x.word === "fix-up");
  if (s?.kind === "answer" && s.option === "merge" && !fix) {
    if (!isPr(f) || !isOpen(f) || ending) return { note: "dropped a resolution: a merge needs an open PR" };
    commands.push({ word: "merge" });
  } else if (s?.kind === "answer" && s.option === "merge" && fix) fix.merge = true;
  else if (s?.kind === "backlog") commands.push({ word: "backlog" });
  else if (s) notes.push("dropped a settlement: questions are answered with commands now");
  const merging = commands.find((x): x is Extract<RegistryCommand, { word: "merge" | "fix-up" }> => x.word === "merge" || (x.word === "fix-up" && x.merge));
  if (issues.length && merging) merging.followups = issues;
  else commands.push(...issues.map((i): Command => ({ word: "open_issue", ...i })));
  const params: CardParams[] = [
    ...(text !== null ? [{ kind: "comment" } as const] : []),
    ...labels.map((l): CardParams => ({ kind: "label", label: l.label, remove: l.remove })),
    ...commands.map((command): CardParams => ({ kind: "command", command })),
  ];
  if (!params.length) return { note: "dropped a resolution without steps" };
  return { value: params.map((p) => ({ params: p, text: p.kind === "comment" ? text : null, description: describe(f.repo, f.n, p) })) };
}

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

/** Cards per reply. */
const MAX_CARDS = 8;
const FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

const listOf = (reply: string): { m: RegExpExecArray | null; list: unknown } => {
  const m = FENCE.exec(reply.trimEnd());
  if (!m) return { m, list: undefined };
  try { return { m, list: JSON.parse(m[1]!) }; } catch { return { m, list: null }; }
};

/** The cleaned text of each public text of a reply (a comment, an issue's title and body), with its field, for the reference checks. */
export function commentTexts(reply: string): { field: string; text: string }[] {
  const { list } = listOf(reply);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).flatMap((c: { kind?: unknown; text?: unknown; steps?: unknown }, i) => {
    if (!c || c.kind !== "resolution") return [];
    const out: { field: string; text: string }[] = [];
    const text = typeof c.text === "string" ? cleanComment(c.text) : "";
    if (text) out.push({ field: `cards[${i}].text`, text });
    if (Array.isArray(c.steps)) c.steps.forEach((st: { kind?: unknown; body?: unknown; title?: unknown }, j) => {
      if (!st || st.kind !== "open_issue") return;
      const body = typeof st.body === "string" ? cleanComment(st.body) : "", title = typeof st.title === "string" ? cleanComment(st.title).replace(/\s+/g, " ") : "";
      if (body) out.push({ field: `cards[${i}].steps[${j}].body`, text: body });
      if (title) out.push({ field: `cards[${i}].steps[${j}].title`, text: title });
    });
    return out;
  });
}

/** The item numbers and logins the reply's steps name, so one load reads them all. */
function namesOf(list: unknown[]): { numbers: number[]; logins: string[] } {
  const numbers: number[] = [], logins: string[] = [];
  for (const c of list) {
    const steps = (c as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const st of steps as Record<string, unknown>[]) {
      if (!st || typeof st !== "object") continue;
      if (st.kind === "duplicate" && typeof st.of === "number") numbers.push(st.of);
      if (st.kind === "assign" && typeof st.login === "string") logins.push(st.login);
      if (st.kind === "request_reviewers" && Array.isArray(st.logins)) logins.push(...st.logins.filter((x): x is string => typeof x === "string"));
    }
  }
  return { numbers, logins };
}

/** The reply's text and its cards, checked against `f`. A reply with no text gets null. `drop`: cleaned texts the reply lint still flagged; their resolutions are dropped. */
export function parseReplyWith(f: CardFacts, reply: string, drop: ReadonlySet<string> = new Set()): Parsed | null {
  const { m, list } = listOf(reply);
  const text = (m ? reply.trimEnd().slice(0, m.index) : reply).trim();
  if (!text) return null;
  const notes: string[] = [];
  const cards: NewCard[] = [];
  if (m && !Array.isArray(list)) notes.push("dropped the actions block: it is not a JSON list");
  else if (Array.isArray(list)) {
    const seen = new Set<string>();
    for (const raw of list.slice(0, 20)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { notes.push("dropped a card that is not an object"); continue; }
      const c = raw as Record<string, unknown>;
      if (c.kind !== "resolution") { notes.push(`dropped a card with unknown action "${String(c.kind).slice(0, 40)}"`); continue; }
      const v = validateResolution(f, c, drop, notes);
      if ("note" in v) { notes.push(v.note); continue; }
      for (const card of v.value) {
        const key = card.params.kind === "command" ? `command:${card.params.command.word}` : card.params.kind === "label" ? `label:${card.params.label.toLowerCase()}` : `comment:${card.text}`;
        if (seen.has(key)) { notes.push(`dropped a second card that does the same: ${card.description}`); continue; }
        if (cards.length >= MAX_CARDS) { notes.push(`dropped the cards beyond the ${MAX_CARDS}th`); break; }
        seen.add(key);
        cards.push(card);
      }
    }
    if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
  }
  return { text, cards, notes };
}

/** parseReplyWith over the facts of the item and of the names the reply mentions, loaded in one wave. */
export async function parseReply(db: Db, repo: string, n: number, reply: string, drop: ReadonlySet<string> = new Set()): Promise<Parsed | null> {
  const { list } = listOf(reply);
  return parseReplyWith(await loadCardFacts(db, repo, n, Array.isArray(list) ? namesOf(list) : {}), reply, drop);
}

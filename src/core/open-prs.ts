// What the Implement stage and the planner read about open PRs and issue text from the local tables.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";

/** Setting that marks a repo without a Rust workspace at its root, set by the step when it finds out. */
export const notRustKey = (repo: string): string => `fixissue_not_rust:${repo}`;

export const textHash = (title: string, body: string): string => createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 16);

/** A closing or addressing keyword followed by a same-repo issue number. */
const CLOSING = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|address(?:es|ed)?)\s*:?\s+#(\d+)/gi;
const MENTION = /(?<![\w/])#(\d+)/g;

/** Text without links: a reference inside a URL, an HTML link or a markdown link (dependabot's release notes) is not a reference to the repo's own issue. */
const withoutLinks = (t: string): string => t.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ").replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ");

/** The open PR that holds an issue: `closes` when it has a closing-issue link or a Fixes/Closes/Resolves/Addresses #n, else it only mentions the issue. */
export type OpenPr = { number: number; closes: boolean };

/**
 * The issue numbers a PR's title and body name, as stored in `items.text_refs`: JSON [closes, mentions], each in first-match order without repeats.
 * `closes` follow a closing or addressing keyword; `mentions` are every #n (closes included).
 */
export function textRefs(title: string | null, body: string | null): string {
  const text = withoutLinks(`${title ?? ""}\n${body ?? ""}`);
  const closes = new Set<number>(), mentions = new Set<number>();
  for (const m of text.matchAll(CLOSING)) closes.add(Number(m[1]));
  for (const m of text.matchAll(MENTION)) mentions.add(Number(m[1]));
  return JSON.stringify([[...closes], [...mentions]]);
}

/** text_refs of a PR with none: no reference in its text. */
const NO_REFS = JSON.stringify([[], []]);

// Open PRs that can hold an issue. The text is read only where text_refs is missing (a writer other than sync, or a row written before the column existed).
const openPrs = (db: Db) => db.k.selectFrom("items")
  .select((eb) => ["repo", "number", "author", "closing_issues", "text_refs",
    eb.case().when("text_refs", "is", null).then(eb.ref("title")).end().as("title"),
    eb.case().when("text_refs", "is", null).then(eb.ref("body")).end().as("body")])
  .where("kind", "=", "pr").where("state", "=", "OPEN")
  .where((eb) => eb.or([eb("text_refs", "is", null), eb("text_refs", "<>", NO_REFS), eb.and([eb("closing_issues", "is not", null), eb("closing_issues", "<>", "[]")])]));

/**
 * Issues an open PR in the repo closes or addresses (any author), and issues a person's open PR mentions by number
 * (a bot's PR, such as a dependency update, is not asked about its mentions). A PR that closes an issue wins over one that mentions it.
 */
export async function issuesWithOpenPr(db: Db, repo: string): Promise<Map<number, OpenPr>> {
  return openPrMap(await db.all(openPrs(db).where("repo", "=", repo).orderBy("number", "desc")));
}

/** issuesWithOpenPr() for every repo, from one reading of the open PRs. */
export async function issuesWithOpenPrAll(db: Db): Promise<(repo: string) => Map<number, OpenPr>> {
  const by = new Map<string, OpenPrRow[]>();
  for (const p of await db.all(openPrs(db).orderBy("repo").orderBy("number", "desc")))
    (by.get(p.repo) ?? by.set(p.repo, []).get(p.repo)!).push(p);
  return (repo) => openPrMap(by.get(repo) ?? []);
}

type OpenPrRow = { number: number; author: string | null; closing_issues: string | null; text_refs: string | null; title: string | null; body: string | null };

const parseRefs = (s: string): [number[], number[]] => {
  try {
    const v = JSON.parse(s) as unknown;
    if (Array.isArray(v) && Array.isArray(v[0]) && Array.isArray(v[1])) return [v[0].filter((n) => typeof n === "number"), v[1].filter((n) => typeof n === "number")];
  } catch { /* computed from the text below */ }
  return [[], []];
};

function openPrMap(prs: OpenPrRow[]): Map<number, OpenPr> {
  const out = new Map<number, OpenPr>();
  for (const p of prs) {
    const [textCloses, mentions] = parseRefs(p.text_refs ?? textRefs(p.title, p.body));
    const closes = new Set<number>();
    try {
      for (const n of JSON.parse(p.closing_issues ?? "[]") as unknown[]) if (typeof n === "number") closes.add(n);
    } catch { /* fall through to the text */ }
    for (const n of textCloses) closes.add(n);
    for (const n of closes) out.set(n, { number: p.number, closes: true });
    if (/\[bot\]$/i.test(p.author ?? "")) continue;
    for (const n of mentions) if (!out.has(n)) out.set(n, { number: p.number, closes: false });
  }
  return out;
}

/** Whether an open PR in the repo closes issue `n` or a person's open PR mentions it. */
export const hasOpenPr = async (db: Db, repo: string, n: number): Promise<boolean> => (await issuesWithOpenPr(db, repo)).has(n);

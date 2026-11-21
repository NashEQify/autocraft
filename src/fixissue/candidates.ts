// What the Fix stage reads about issues from the local tables. Which issues it works on is the Plans' (core/decide-item.ts).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ATTEMPT_STATES = ["retry", "testing", "passed", "pr-opened", "skipped", "failed"] as const;

export type IssueCandidate = { repo: string; number: number; title: string; body: string; hash: string; score: number | null };

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
const OPEN_PRS = `SELECT repo, number, author, closing_issues, text_refs,
    CASE WHEN text_refs IS NULL THEN title END AS title, CASE WHEN text_refs IS NULL THEN body END AS body
  FROM items WHERE kind = 'pr' AND state = 'OPEN' AND (text_refs IS NULL OR text_refs <> '${NO_REFS}' OR (closing_issues IS NOT NULL AND closing_issues <> '[]'))`;

/**
 * Issues an open PR in the repo closes or addresses (any author), and issues a person's open PR mentions by number
 * (a bot's PR, such as a dependency update, is not asked about its mentions). A PR that closes an issue wins over one that mentions it.
 */
export function issuesWithOpenPr(db: DatabaseSync, repo: string): Map<number, OpenPr> {
  return openPrMap(db.prepare(`${OPEN_PRS} AND repo = ? ORDER BY number DESC`).all(repo) as OpenPrRow[]);
}

/** issuesWithOpenPr() for every repo, from one reading of the open PRs. */
export function issuesWithOpenPrAll(db: DatabaseSync): (repo: string) => Map<number, OpenPr> {
  const by = new Map<string, OpenPrRow[]>();
  for (const p of db.prepare(`${OPEN_PRS} ORDER BY repo, number DESC`).all() as (OpenPrRow & { repo: string })[])
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
export const hasOpenPr = (db: DatabaseSync, repo: string, n: number): boolean => issuesWithOpenPr(db, repo).has(n);

/** Writes text_refs of the open PRs without one, in batches so other processes can write between them. */
export function fillTextRefs(db: DatabaseSync): void {
  const sel = db.prepare("SELECT repo, number, title, body FROM main.items WHERE kind = 'pr' AND state = 'OPEN' AND text_refs IS NULL LIMIT 2000");
  const upd = db.prepare("UPDATE main.items SET text_refs = ? WHERE repo = ? AND number = ? AND text_refs IS NULL");
  for (;;) {
    const rows = sel.all() as { repo: string; number: number; title: string | null; body: string | null }[];
    if (!rows.length) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) upd.run(textRefs(r.title, r.body), r.repo, r.number);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

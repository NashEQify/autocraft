// What a pull request review post says about the review at a head. A carried review has no text of its own: the post uses the
// text, claims and model of the review the carry came from.
import { CARRIED } from "./carry.ts";
import { parsePublic, storedClaims, type PublicReview } from "./opus-parse.ts";
import type { Db } from "../db/index.ts";

type Row = { head_oid: string; at: string; model: string | null; mode: string | null; base_head: string | null; verdict: string; sure: number | null; public_review: string | null; claims: string | null };
const COLS = "head_oid, at, model, mode, base_head, verdict, sure, public_review, claims";
const MAX_STEPS = 20;

export type PostSource = {
  /** The verdict at the head (a carried review's is take). */
  verdict: string; sure: boolean;
  /** The verdict of the review the text comes from. */
  sourceVerdict: string;
  /** The parsed public text; null when the stored text does not parse. Empty text (no summary, no points) when the row has none. */
  public: PublicReview | null;
  hasPublic: boolean;
  claims: ReturnType<typeof storedClaims>;
  model: string | null;
  /** The head the text was written at. */
  reviewedAt: string;
  /** The head a carried review sits at (the fix-up's head); null when the review is not carried. */
  fixedIn: string | null;
  /** The `at` of the review at the head. */
  at: string;
};

const isCarried = (r: Pick<Row, "model" | "mode">) => r.model === CARRIED || r.mode === CARRIED;

const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return null; }
};

/** The review to post at `head`, or null when the head has none. */
export async function postSource(db: Db, repo: string, number: number, head: string): Promise<PostSource | null> {
  const get = db.prepare(`SELECT ${COLS} FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1`);
  return await sourceFrom(async (h) => await get.get(repo, number, h) as Row | undefined, head);
}

/** postSource() for the given PRs ("repo#number"), with their reviews read once. */
export async function postSourcesOf(db: Db, refs: readonly string[]): Promise<(repo: string, number: number, head: string) => Promise<PostSource | null>> {
  const rows = new Map<string, Row>();
  const pairs = refs.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))]);
  if (pairs.length) {
    for (const r of await db.prepare(`SELECT o.repo || '#' || o.number || '@' || o.head_oid AS k, ${COLS.split(", ").map((c) => `o.${c}`).join(", ")} FROM json_each(?) j
      JOIN opus_reviews o ON o.repo = j.value ->> 0 AND o.number = j.value ->> 1 WHERE o.verdict IS NOT NULL ORDER BY o.at DESC, o.rowid DESC`).all(JSON.stringify(pairs)) as (Row & { k: string })[]) {
      const { k, ...row } = r;
      if (!rows.has(k)) rows.set(k, row);
    }
  }
  return async (repo, number, head) => await sourceFrom(async (h) => rows.get(`${repo}#${number}@${h}`), head);
}

async function sourceFrom(get: (head: string) => Promise<Row | undefined>, head: string): Promise<PostSource | null> {
  const o = await get(head);
  if (!o) return null;
  let src = o;
  for (let i = 0; i < MAX_STEPS && isCarried(src) && src.base_head; i++) {
    const next = await get(src.base_head);
    if (!next) break;
    src = next;
  }
  const carried = src !== o && !isCarried(src);
  // A walk that ends on a carried row (chain over the cap, or a missing base row) has no model to name.
  const hasPublic = src.public_review !== null;
  return {
    verdict: o.verdict, sure: o.sure !== 0, sourceVerdict: src.verdict,
    public: hasPublic ? parsePublic(safeJson(src.public_review!)) : { summary: "", points: [] },
    hasPublic, claims: storedClaims(safeJson(src.claims ?? "[]")),
    model: isCarried(src) ? null : src.model, reviewedAt: carried ? src.head_oid : o.head_oid, fixedIn: carried ? o.head_oid : null, at: o.at,
  };
}

// What a pull request review post says about the review at a head. A carried review has no text of its own: the post uses the
// text, claims and model of the review the carry came from.
import { CARRIED } from "./carry.ts";
import { parsePublic, storedClaims, type PublicReview } from "./opus-parse.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

type Row = { head_oid: string; at: string; model: string | null; mode: string | null; base_head: string | null; verdict: string; sure: number | null; public_review: string | null; claims: string | null };
const COLS = ["head_oid", "at", "model", "mode", "base_head", "verdict", "sure", "public_review", "claims"] as const;
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
  const get = (h: string) => db.get(db.k.selectFrom("opus_reviews").select(COLS).$narrowType<{ verdict: string }>()
    .where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", h).where("verdict", "is not", null)
    .orderBy("at", "desc").orderBy(kx.rowid("opus_reviews"), "desc").limit(1));
  return await sourceFrom(get, head);
}

/** postSource() for the given PRs ("repo#number"), with their reviews read once. */
export async function postSourcesOf(db: Db, refs: readonly string[]): Promise<(repo: string, number: number, head: string) => Promise<PostSource | null>> {
  const rows = new Map<string, Row>();
  if (refs.length) {
    for (const r of await db.all(db.k.selectFrom(kx.refPairs(db, refs, "j")).innerJoin("opus_reviews as o", (jn) => jn.onRef("o.repo", "=", "j.repo").onRef("o.number", "=", "j.number"))
      .select(["o.repo", "o.number", ...COLS.map((c) => `o.${c}` as const)]).$narrowType<{ verdict: string }>().where("o.verdict", "is not", null)
      .orderBy("o.at", "desc").orderBy(kx.rowid("opus_reviews", "o"), "desc"))) {
      const { repo, number, ...row } = r;
      const k = `${repo}#${number}@${row.head_oid}`;
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

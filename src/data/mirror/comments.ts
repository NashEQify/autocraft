// Comment loaders (M01 mirror-a).
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { parseSearch } from "../../db/search.ts";
import type { KeySource } from "../keys.ts";
import { joinKeys, keyChunks, refKey, qualified, type AnyQ } from "./shared.ts";
import type { CommentFilter, CommentHit, CommentOut, CommentStats, RefKey, ReviewFact, SnippetMarks } from "./types.ts";

type Filter = Omit<CommentFilter, "order" | "body">;

const COMMENT_COLUMNS = kx.cols("comments").filter((c) => c !== "body");

/** The filter's conditions on the comments table aliased `a`. */
function conditions(db: Db, eb: kx.AnyEb, a: string, f: Filter): Expression<SqlBool>[] {
  const c: Expression<SqlBool>[] = [];
  if (f.kinds) c.push(kx.inList(db, `${a}.kind`, f.kinds));
  if (f.counted) c.push(eb(`${a}.counted`, "=", 1));
  if (f.after !== undefined) c.push(eb(`${a}.created_at`, ">", f.after));
  if (f.authors) c.push(kx.inList(db, `${a}.author`, f.authors));
  if (f.excludeBots) c.push(eb.or([eb(`${a}.author`, "is", null), eb.not(kx.like(db, `${a}.author`, eb.val("%[bot]")))]));
  return c;
}

/** Comments of each item, filtered and ordered as asked. The body is read only with `body: true`. */
export async function loadComments(db: Db, keys: KeySource, f: CommentFilter = { order: "rowid" }): Promise<Map<RefKey, CommentOut[]>> {
  const q = queryDb(db);
  const cols = qualified("c", f.body ? [...COMMENT_COLUMNS, "body"] : COMMENT_COLUMNS);
  const parts = await Promise.all(keyChunks(keys).map((k) => {
    const base = (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ).select(cols as never).where((eb: kx.AnyEb) => eb.and(conditions(db, eb, "c", f)));
    const ordered = f.order === "created" ? base.orderBy("c.created_at", (o: any) => o.asc().nullsFirst()).orderBy(kx.rowid("comments", "c")) : base.orderBy(kx.rowid("comments", "c"));
    return q.all(ordered, { label: "mirror.loadComments" });
  }));
  const out = new Map<RefKey, CommentOut[]>();
  for (const rows of parts) for (const r of rows as CommentOut[]) {
    const k = refKey(r.repo, r.number);
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
}

/** Count, newest time, total length, link presence and authors of each item's comments. */
export async function loadCommentStats(db: Db, keys: KeySource, f: Filter = {}): Promise<Map<RefKey, CommentStats>> {
  const q = queryDb(db);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ)
      .select((eb: kx.AnyEb) => [
        eb.ref("c.repo").as("repo"), eb.ref("c.number").as("number"), eb.fn.countAll<number>().as("n"),
        eb.fn.max<string | null>("c.created_at").as("newest"),
        eb.fn.sum<number | null>(eb.fn<number>("length", [eb.fn.coalesce("c.body", eb.val(""))])).as("length"),
        eb.fn.sum<number>(eb.case().when("c.url", "is not", null).then(eb.lit(1)).else(eb.lit(0)).end()).as("urls"),
        kx.jsonRows(db, eb.selectFrom("comments as a").select("a.author").distinct().whereRef("a.repo", "=", "c.repo").whereRef("a.number", "=", "c.number")
          .where("a.author", "is not", null).where((e: kx.AnyEb) => e.and(conditions(db, e, "a", f)))).as("authors"),
      ] as never)
      .where((eb: kx.AnyEb) => eb.and(conditions(db, eb, "c", f))).groupBy(["c.repo", "c.number"]), { label: "mirror.loadCommentStats" })));
  const out = new Map<RefKey, CommentStats>();
  for (const rows of parts) for (const r of rows as { repo: string; number: number; n: number; newest: string | null; length: number | null; urls: number; authors: string | null }[])
    out.set(refKey(r.repo, r.number), {
      n: Number(r.n), newest: r.newest, length: Number(r.length ?? 0), hasUrls: Number(r.urls) > 0,
      authors: kx.parseJsonRows<{ author: string }>(r.authors).map((a) => a.author),
    });
  return out;
}

// The review states that count as a reviewer's opinion (COMMENTED does not); the same list as merge's FORMAL_STATES.
const FORMAL_STATES = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

/** Formal review entries (kind review, author set, formal state) of open PRs in row order. */
export async function loadFormalReviews(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewFact[]>> {
  const q = queryDb(db);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ)
      .innerJoin("items as i", (j: any) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "c.number").on("i.kind", "=", "pr").on("i.state", "=", "OPEN"))
      .select(["c.repo", "c.number", "c.id", "c.author", "c.author_association as association", "c.review_state as state", "c.created_at as at"] as never)
      .where("c.kind", "=", "review").where("c.author", "is not", null).where(kx.inList(db, "c.review_state", FORMAL_STATES))
      .orderBy(kx.rowid("comments", "c")), { label: "mirror.loadFormalReviews" })));
  const out = new Map<RefKey, ReviewFact[]>();
  for (const rows of parts) for (const r of rows as (ReviewFact & { repo: string; number: number })[]) {
    const k = refKey(r.repo, r.number);
    (out.get(k) ?? out.set(k, []).get(k)!).push({ id: r.id, author: r.author, association: r.association, state: r.state, at: r.at });
  }
  return out;
}

/** Logins (as given) with an item or a comment in the repo; the match ignores case. */
export async function loadActivityByLogins(db: Db, repo: string, logins: string[]): Promise<Set<string>> {
  if (!logins.length) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("items").select("author").where("repo", "=", repo).where(kx.inList(db, "author", logins, "citext"))
    .union(q.k.selectFrom("comments").select("author").where("repo", "=", repo).where(kx.inList(db, "author", logins, "citext"))), { label: "mirror.loadActivityByLogins" });
  const found = new Set(rows.map((r) => (r.author ?? "").toLowerCase()));
  return new Set(logins.filter((l) => found.has(l.toLowerCase())));
}

const MARKS: SnippetMarks = { open: "\u0002", close: "\u0003", words: 24 };

/** Full-text comment search, best first (lower score); `limit` defaults to 20. */
export async function searchComments(db: Db, search: string, opts: { repos?: string[]; limit?: number; snippets?: boolean }): Promise<CommentHit[]> {
  const s = parseSearch(search);
  if (!s || (opts.repos && !opts.repos.length)) return [];
  const q = queryDb(db);
  const hits = kx.commentHits(db, s, { score: true, ...(opts.snippets ? { snippet: MARKS } : {}) }, "h");
  const rows = await q.all((q.k.selectFrom(hits) as AnyQ).select(["h.repo", "h.number", "h.id", "h.author", "h.score", ...(opts.snippets ? ["h.snippet"] : [])] as never)
    .$if(!!opts.repos, (b: AnyQ) => b.where(kx.inList(db, "h.repo", opts.repos!)))
    .orderBy("h.score").orderBy("h.repo").orderBy("h.number").orderBy("h.id").limit(opts.limit ?? 20), { label: "mirror.searchComments" });
  return (rows as { repo: string; number: number; id: string; author: string | null; score: number; snippet?: string | null }[]).map((r) => ({
    ref: refKey(r.repo, r.number), id: r.id, author: r.author, score: r.score, ...(opts.snippets && r.snippet ? { snippet: r.snippet } : {}),
  }));
}

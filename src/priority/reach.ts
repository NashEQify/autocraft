// Reach signals of open items, read from the mirror in a few set-wide queries
// (about 21,000 items): no per-item query.
import { parseRef } from "../classify/parse.ts";
import { latestRun, settledTable } from "../classify/settled.ts";
import type { Reach } from "./score.ts";
import type { Db } from "../db/index.ts";

const key = (repo: string, n: number) => `${repo}#${n}`;

/** Confirmed duplicates per canonical item, from the duplicates stage's `duplicate_pairs` table. Empty when the table or a column is missing. */
export async function duplicateCounts(db: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // A Postgres database always has the whole schema; an old SQLite file may not.
  if (db.dialect === "sqlite") {
    const table = (await db.k.introspection.getTables()).find((t) => t.name === "duplicate_pairs");
    if (!table) return out;
    const cols = new Set(table.columns.map((c) => c.name));
    if (!["repo", "canonical", "verdict"].every((c) => cols.has(c))) return out;
  }
  const rows = await db.all(db.k.selectFrom("duplicate_pairs").select(["repo", "canonical"]).where("verdict", "=", "duplicate").where("canonical", "is not", null));
  for (const r of rows) {
    // The canonical item is a number in the pair's repo, or a "repo#number" ref.
    const ref = typeof r.canonical === "number" || /^\d+$/.test(String(r.canonical)) ? { repo: r.repo, number: Number(r.canonical) } : parseRef(String(r.canonical));
    if (ref) out.set(key(ref.repo, ref.number), (out.get(key(ref.repo, ref.number)) ?? 0) + 1);
  }
  return out;
}

/** Reach of every open item that has a priority row. */
export async function reachOfOpenItems(db: Db, nowMs: number = Date.now()): Promise<Map<string, Reach>> {
  const commenters = new Map<string, number>();
  for (const r of await db.all(db.k.selectFrom("comments").select(["repo", "number", (eb) => eb.fn.count<number>("author").distinct().as("n")]).where("kind", "=", "comment").groupBy(["repo", "number"])))
    commenters.set(key(r.repo, r.number), r.n);
  const security = new Set<string>();
  const run = await latestRun(db);
  await settledTable(db, run);
  for (const r of await db.all(db.k.selectFrom("item_settled").select(["repo", "number"]).where("run", "=", run ?? "").where("security", "=", 1)))
    security.add(key(r.repo, r.number));
  // A PR that closes issues counts for the PR and for each issue.
  const linked = new Map<string, number>();
  const bump = (k: string) => linked.set(k, (linked.get(k) ?? 0) + 1);
  for (const r of await db.all(db.k.selectFrom("items").select(["repo", "number", "closing_issues"]).where("kind", "=", "pr").where("state", "=", "OPEN")
    .where("closing_issues", "is not", null).where("closing_issues", "<>", "[]").$narrowType<{ closing_issues: string }>())) {
    let nums: unknown;
    try { nums = JSON.parse(r.closing_issues); } catch { continue; }
    if (!Array.isArray(nums)) continue;
    for (const n of nums) if (typeof n === "number") { bump(key(r.repo, n)); bump(key(r.repo, r.number)); }
  }
  const dups = await duplicateCounts(db);
  const out = new Map<string, Reach>();
  const rows = await db.all(db.k.selectFrom("items as i")
    .innerJoin("item_priority as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.comments_count", "i.created_at"]).where("i.state", "=", "OPEN"));
  for (const r of rows) {
    const k = key(r.repo, r.number), created = r.created_at ? Date.parse(r.created_at) : NaN;
    out.set(k, {
      comments: r.comments_count ?? 0, commenters: commenters.get(k) ?? 0, linked: linked.get(k) ?? 0, duplicates: dups.get(k) ?? 0,
      security: security.has(k), ageDays: Number.isNaN(created) ? 0 : Math.max(0, (nowMs - created) / 86_400_000),
    });
  }
  return out;
}

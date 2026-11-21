// The commits our pipeline pushed to a PR between two heads, for the review prompt and for carrying a verdict over our own fix-up.
import type { Db } from "../db/index.ts";

export type OurCommit = { kind: "fix-up" | "pre-merge fix" | "operator fix-up" | "CI fix" | "base merge" | "carry"; sha: string; note: string; fixes_meant: string[]; from: string };

type Row = { from: string; kind: OurCommit["kind"]; note: string | null; source?: string | null };

/** What a carry commit holds: parts of the closed duplicates, named with their authors. */
async function carriedNote(db: Db, repo: string, decision: string | null): Promise<string> {
  const rows = decision ? await db.prepare("SELECT g.number, i.author FROM dupe_group_items g LEFT JOIN items i ON i.repo = ? AND i.number = g.number WHERE g.decision_id = ? AND g.kind = 'pr' AND g.role = 'close' ORDER BY g.number").all(repo, decision) as { number: number; author: string | null }[] : [];
  return rows.length ? `parts carried from the closed duplicate PRs ${rows.map((x) => `#${x.number}${x.author ? ` by ${x.author}` : ""}`).join(", ")}: code written by those authors, not by the pipeline` : "parts carried from closed duplicate PRs: code written by their authors, not by the pipeline";
}

type Pushes = {
  a?: { f: string; reason: string | null; source: string | null; carry_decision: string | null };
  // Read only when the earlier kinds found none.
  b: () => Promise<{ f: string; reason: string | null; kind: string } | undefined>;
  c: () => Promise<{ f: string; reason: string | null } | undefined>;
  d: () => Promise<{ f: string } | undefined>;
};

/** The commit of ours that made `head`, or null when no push of ours ended there (a contributor's commit). */
async function madeBy(db: Db, repo: string, number: number, head: string): Promise<Row | null> {
  return await madeFrom(db, repo, {
    a: await db.prepare("SELECT from_head AS f, reason, source, carry_decision FROM fixups WHERE repo = ? AND number = ? AND to_head = ? AND state = 'pushed' ORDER BY rowid DESC").get(repo, number, head) as Pushes["a"],
    b: async () => await db.prepare("SELECT head AS f, reason, kind FROM ci_fixes WHERE repo = ? AND number = ? AND to_head = ? AND state = 'pushed' ORDER BY rowid DESC").get(repo, number, head) as Awaited<ReturnType<Pushes["b"]>>,
    c: async () => await db.prepare("SELECT from_head AS f, reason FROM conflict_merges WHERE repo = ? AND number = ? AND to_head = ? AND state = 'merged' ORDER BY rowid DESC").get(repo, number, head) as Awaited<ReturnType<Pushes["c"]>>,
    d: async () => await db.prepare("SELECT from_head AS f FROM dupe_carries WHERE repo = ? AND number = ? AND to_head = ? AND outcome LIKE 'pushed%' AND from_head IS NOT NULL").get(repo, number, head) as Awaited<ReturnType<Pushes["d"]>>,
  });
}

/** madeBy() from the pushes that ended at the head: a fix-up, else a CI fix, else a base merge, else a carry-over. */
async function madeFrom(db: Db, repo: string, p: Pushes): Promise<Row | null> {
  const a = p.a;
  if (a?.source === "carry") return { from: a.f, kind: "carry", note: await carriedNote(db, repo, a.carry_decision), source: a.source };
  if (a) return { from: a.f, kind: a.source === "premerge" ? "pre-merge fix" : a.source === "operator" ? "operator fix-up" : "fix-up", note: a.reason, source: a.source };
  const b = await p.b();
  if (b) return { from: b.f, kind: "CI fix", note: b.reason ?? `fix for the failing ${b.kind} check` };
  const c = await p.c();
  if (c) return { from: c.f, kind: "base merge", note: c.reason ?? "merged the base branch into the PR" };
  const d = await p.d();
  if (d) return { from: d.f, kind: "carry", note: "carried parts of closed duplicates onto the PR" };
  return null;
}

/** The fixes the review at `head` asked for, as "file: change". */
async function fixesAsked(db: Db, repo: string, number: number, head: string): Promise<string[]> {
  const r = await db.prepare("SELECT fixes FROM opus_review_history WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1").get(repo, number, head) as { fixes: string | null } | undefined;
  try {
    const v = JSON.parse(r?.fixes ?? "[]") as { file?: unknown; change?: unknown }[];
    return v.filter((x) => typeof x.file === "string" && typeof x.change === "string").slice(0, 8).map((x) => `${x.file}: ${x.change}`);
  } catch { return []; }
}

/**
 * Our commits that lead from `earlier` to `head`, oldest first. `complete` is false when the way back from `head` meets a commit that
 * is not ours before it reaches `earlier` (a contributor pushed in between), so the list then holds only the newest part.
 */
export async function ourCommitsSince(db: Db, repo: string, number: number, earlier: string, head: string): Promise<OurPath> {
  return await walk(db, async (h) => await madeBy(db, repo, number, h), repo, number, earlier, head);
}

type OurPath = { commits: OurCommit[]; complete: boolean; sources: (string | null | undefined)[] };

/** ourCommitsSince() for many PRs: the pushes of every PR are read once, on first use. */
export function ourCommitsLoader(db: Db): (repo: string, number: number, earlier: string, head: string) => Promise<OurPath> {
  let maps: { a: Map<string, Pushes["a"]>; b: Map<string, Awaited<ReturnType<Pushes["b"]>>>; c: Map<string, Awaited<ReturnType<Pushes["c"]>>>; d: Map<string, Awaited<ReturnType<Pushes["d"]>>> } | undefined;
  // The row each per-head read would give first: the newest for a, b and c, the first stored for d.
  const firstBy = async <T>(sql: string): Promise<Map<string, T>> => {
    const m = new Map<string, T>();
    for (const r of await db.prepare(sql).all() as (T & { k: string })[]) if (!m.has(r.k)) { const { k, ...rest } = r; m.set(k, rest as T); }
    return m;
  };
  const load = async () => (maps ??= {
    a: await firstBy("SELECT repo || '#' || number || '@' || to_head AS k, from_head AS f, reason, source, carry_decision FROM fixups WHERE state = 'pushed' AND to_head IS NOT NULL ORDER BY rowid DESC"),
    b: await firstBy("SELECT repo || '#' || number || '@' || to_head AS k, head AS f, reason, kind FROM ci_fixes WHERE state = 'pushed' AND to_head IS NOT NULL ORDER BY rowid DESC"),
    c: await firstBy("SELECT repo || '#' || number || '@' || to_head AS k, from_head AS f, reason FROM conflict_merges WHERE state = 'merged' AND to_head IS NOT NULL ORDER BY rowid DESC"),
    d: await firstBy("SELECT repo || '#' || number || '@' || to_head AS k, from_head AS f FROM dupe_carries WHERE outcome LIKE 'pushed%' AND from_head IS NOT NULL AND to_head IS NOT NULL ORDER BY rowid"),
  });
  return async (repo, number, earlier, head) => await walk(db, async (h) => {
    const m = await load(), k = `${repo}#${number}@${h}`;
    return await madeFrom(db, repo, { a: m.a.get(k), b: async () => m.b.get(k), c: async () => m.c.get(k), d: async () => m.d.get(k) });
  }, repo, number, earlier, head);
}

async function walk(db: Db, madeBy: (head: string) => Promise<Row | null>, repo: string, number: number, earlier: string, head: string): Promise<OurPath> {
  const commits: OurCommit[] = [], sources: (string | null | undefined)[] = [];
  let h = head, complete = false;
  for (let i = 0; i < 20 && h !== earlier; i++) {
    const row = await madeBy(h);
    if (!row) break;
    commits.unshift({ kind: row.kind, sha: h, from: row.from, note: row.note ?? "", fixes_meant: row.kind === "fix-up" ? await fixesAsked(db, repo, number, row.from) : [] });
    sources.unshift(row.source);
    h = row.from;
  }
  complete = h === earlier;
  return { commits, complete, sources };
}

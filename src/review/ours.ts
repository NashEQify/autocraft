// The commits our pipeline pushed to a PR between two heads, for the review prompt and for carrying a verdict over our own fix-up.
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type OurCommit = { kind: "fix-up" | "pre-merge fix" | "operator fix-up" | "CI fix" | "base merge" | "carry"; sha: string; note: string; fixes_meant: string[]; from: string };

type Row = { from: string; kind: OurCommit["kind"]; note: string | null; source?: string | null };

/** What a carry commit holds: parts of the closed duplicates, named with their authors. */
async function carriedNote(db: Db, repo: string, decision: string | null): Promise<string> {
  const rows = decision ? await db.all(db.k.selectFrom("dupe_group_items as g").leftJoin("items as i", (j) => j.on("i.repo", "=", repo).onRef("i.number", "=", "g.number"))
    .select(["g.number", "i.author"]).where("g.decision_id", "=", decision).where("g.kind", "=", "pr").where("g.role", "=", "close").orderBy("g.number")) : [];
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
    a: await db.get(db.k.selectFrom("fixups").select(["from_head as f", "reason", "source", "carry_decision"])
      .where("repo", "=", repo).where("number", "=", number).where("to_head", "=", head).where("state", "=", "pushed").orderBy(kx.rowid("fixups"), "desc").limit(1)),
    b: async () => await db.get(db.k.selectFrom("ci_fixes").select(["head as f", "reason", "kind"])
      .where("repo", "=", repo).where("number", "=", number).where("to_head", "=", head).where("state", "=", "pushed").orderBy(kx.rowid("ci_fixes"), "desc").limit(1)),
    c: async () => await db.get(db.k.selectFrom("conflict_merges").select(["from_head as f", "reason"])
      .where("repo", "=", repo).where("number", "=", number).where("to_head", "=", head).where("state", "=", "merged").orderBy(kx.rowid("conflict_merges"), "desc").limit(1)),
    d: async () => await db.get(db.k.selectFrom("dupe_carries").select(["from_head as f"]).$narrowType<{ f: string }>()
      .where("repo", "=", repo).where("number", "=", number).where("to_head", "=", head).where((eb) => kx.like(db, "outcome", eb.val("pushed%"))).where("from_head", "is not", null)
      .orderBy(kx.rowid("dupe_carries")).limit(1)),
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
  const r = await db.get(db.k.selectFrom("opus_review_history").select("fixes").where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "is not", null)
    .orderBy("at", "desc").orderBy(kx.rowid("opus_review_history"), "desc").limit(1));
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
  const firstBy = <R extends { repo: string; number: number; to_head: string | null }>(rows: R[]): Map<string, Omit<R, "repo" | "number" | "to_head">> => {
    const m = new Map<string, Omit<R, "repo" | "number" | "to_head">>();
    for (const r of rows) {
      const k = `${r.repo}#${r.number}@${r.to_head}`;
      if (!m.has(k)) { const { repo, number, to_head, ...rest } = r; m.set(k, rest); }
    }
    return m;
  };
  const load = async () => (maps ??= {
    a: firstBy(await db.all(db.k.selectFrom("fixups").select(["repo", "number", "to_head", "from_head as f", "reason", "source", "carry_decision"])
      .where("state", "=", "pushed").where("to_head", "is not", null).orderBy(kx.rowid("fixups"), "desc"))),
    b: firstBy(await db.all(db.k.selectFrom("ci_fixes").select(["repo", "number", "to_head", "head as f", "reason", "kind"])
      .where("state", "=", "pushed").where("to_head", "is not", null).orderBy(kx.rowid("ci_fixes"), "desc"))),
    c: firstBy(await db.all(db.k.selectFrom("conflict_merges").select(["repo", "number", "to_head", "from_head as f", "reason"])
      .where("state", "=", "merged").where("to_head", "is not", null).orderBy(kx.rowid("conflict_merges"), "desc"))),
    d: firstBy(await db.all(db.k.selectFrom("dupe_carries").select(["repo", "number", "to_head", "from_head as f"]).$narrowType<{ f: string }>()
      .where((eb) => kx.like(db, "outcome", eb.val("pushed%"))).where("from_head", "is not", null).where("to_head", "is not", null).orderBy(kx.rowid("dupe_carries")))),
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

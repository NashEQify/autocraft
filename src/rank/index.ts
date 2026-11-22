// autocraft-server rank [show <repo> <n>]: the work rank of open items (src/rank/score.ts).
//
// Reads the stored priority, the settled classification and the size; calls no model. The rank step
// writes the item_rank row of an open item in a tracked repo only when it is new or its score or breakdown changed
// (computed_at is the time the score last changed) and removes the rows of the others.
import { latestRun, settledLookup } from "../classify/settled.ts";
import { BULK_ROWS, bulkWrites } from "../core/plan-changes.ts";
import type { Level } from "../priority/score.ts";
import { isSize, rankOf, sizeOfLines, type RankBreakdown, type RankInput, type Size } from "./score.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { excluded } from "../db/kx.ts";

const now = () => new Date().toISOString();

/** Size of an item: the fix triage's estimate for an issue, the changed lines for a PR. */
export function sizeOfItem(kind: string, lines: number | null, fixSize: string | null): Pick<RankInput, "size" | "sizeSource"> {
  if (kind === "issue") return isSize(fixSize) ? { size: fixSize, sizeSource: "triage" } : { size: null, sizeSource: "default" };
  return lines === null ? { size: null, sizeSource: "default" } : { size: sizeOfLines(lines), sizeSource: "lines" };
}

/** Recomputes the rank of every open item in a tracked repo. Returns the number of rows written. */
export async function runRank(db: Db, nowMs: number = Date.now()): Promise<{ items: number; changed: number; removed: number }> {
  const settled = settledLookup(db, await latestRun(db));
  const rows = await db.all(db.k.selectFrom("items as i").innerJoin("tracked_repos as t", "t.name", "i.repo")
    .leftJoin("item_priority as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .leftJoin("fix_attempts as f", (j) => j.onRef("f.repo", "=", "i.repo").onRef("f.number", "=", "i.number"))
    .select((eb) => ["i.repo", "i.number", "i.kind",
      eb.case().when(eb.and([eb("i.kind", "=", "pr"), eb.or([eb("i.additions", "is not", null), eb("i.deletions", "is not", null)])]))
        .then(eb(eb.fn.coalesce("i.additions", eb.lit(0)), "+", eb.fn.coalesce("i.deletions", eb.lit(0)))).end().as("lines"),
      "p.impact as level", "p.score as reach", "f.size as fix_size"])
    .where("i.state", "=", "OPEN")
    .$narrowType<{ level: Level | null }>());
  const old = new Map((await db.all(db.k.selectFrom("item_rank").select(["repo", "number", "score", "breakdown"])))
    .map((r) => [`${r.repo}#${r.number}`, r]));
  const at = new Date(nowMs).toISOString();
  const keep = new Set<string>();
  const puts: [string, number, number, string][] = [];
  for (const r of rows) {
    const s = await settled(r.repo, r.number);
    const { score, breakdown } = rankOf({ level: r.level, reach: r.reach, label: s.label, security: s.flags.includes("security"), ...sizeOfItem(r.kind, r.lines, r.fix_size) });
    const k = `${r.repo}#${r.number}`, json = JSON.stringify(breakdown);
    keep.add(k);
    const prev = old.get(k);
    if (prev && prev.score === score && prev.breakdown === json) continue;
    puts.push([r.repo, r.number, score, json]);
  }
  const dels = [...old].filter(([k]) => !keep.has(k)).map(([, r]) => r);
  return await db.write(async () => {
    const write = async (): Promise<void> => {
      for (const [repo, number, score, json] of puts) {
        await db.run(db.k.insertInto("item_rank").values({ repo, number, score, breakdown: json, computed_at: at })
          .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["score", "breakdown", "computed_at"]))));
      }
      for (const r of dels) await db.run(db.k.deleteFrom("item_rank").where("repo", "=", r.repo).where("number", "=", r.number));
    };
    // Many changed rows (a first ranking, a new formula): one full-pass mark instead of a log row per item.
    if (puts.length + dels.length >= BULK_ROWS) await bulkWrites(db, "rank", write); else await write();
    const changed = puts.length;
    const removed = dels.length;
    return { items: rows.length, changed, removed };
  });
}

export type RankRow = { repo: string; number: number; score: number; breakdown: RankBreakdown; computedAt: string };

export async function rankOfItem(db: Db, repo: string, number: number): Promise<RankRow | null> {
  const r = await db.get(db.k.selectFrom("item_rank").select(["score", "breakdown", "computed_at"]).where("repo", "=", repo).where("number", "=", number));
  return r ? { repo, number, score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown, computedAt: r.computed_at } : null;
}

export const commands = {
  rank: {
    summary: "rank [show <repo> <n>]: recompute the work rank of open items; show prints one item's key and its parts",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      if (args[0] === "show") {
        const repo = args[1], n = Number(args[2]);
        if (!repo || !Number.isInteger(n)) throw new Error("usage: rank show <repo> <n>");
        const r = await rankOfItem(db, repo, n);
        if (!r) { console.log(`${repo}#${n}: no rank (not open, or the rank step has not run)`); return; }
        console.log(`${repo}#${n}: ${r.score} (changed ${r.computedAt})`);
        const b = r.breakdown;
        console.log(`  level     ${b.level}${b.security ? " (raised by the security flag)" : ""}${b.rated ? "" : " (not rated yet)"}`);
        console.log(`  type      ${b.type ?? "not settled"}`);
        console.log(`  size      ${b.size} (${b.sizeSource})`);
        console.log(`  reach     ${b.reach}`);
        return;
      }
      if (args.length) throw new Error("usage: rank | rank show <repo> <n>");
      const r = await runRank(db);
      console.log(`${r.items} open items ranked, ${r.changed} changed, ${r.removed} removed`);
    },
  },
};

export type { Size };

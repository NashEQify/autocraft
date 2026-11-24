// Candidate pairs: for each open item that is new or whose text changed (its
// stored embed_hash differs from the one at its last scan), its nearest
// neighbours in the same repo from the vector index.
import { notOwnIntegrationExpr } from "./held.ts";
import { quietExprFor } from "../security/quiet.ts";
import { excluded } from "../db/kx.ts";
import type { VectorIndex } from "../embed/vectors.ts";
import type { Db } from "../db/index.ts";

/**
 * Cosine similarity of the embedding model (bge-small) from which a neighbour becomes a candidate pair. The same bug in other
 * words can score in the 0.7s, and the pair check that follows is cheap; below 0.75 Jev finds almost no duplicates.
 * Changing it rescans every item once (src/db.ts).
 */
export const SIM_THRESHOLD = 0.75;
/** Most neighbours kept per scanned item. */
export const MAX_NEIGHBOURS = 3;
/** Neighbours looked up per item before the filters; the filters drop some. */
const LOOKUP = 20;
export const CLOSED_WINDOW_DAYS = 365;
const DAY = 86_400_000;

export type ScanItem = {
  repo: string; number: number; kind: string; state: string; embed_hash: string;
  closed_at: string | null; merged_at: string | null; closing_issues: string | null;
};
const COLS = ["i.repo", "i.number", "i.kind", "i.state", "i.embed_hash", "i.closed_at", "i.merged_at", "i.closing_issues"] as const;

const issuesOf = (i: ScanItem): number[] => {
  try { const v = JSON.parse(i.closing_issues ?? "[]") as unknown; return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : []; } catch { return []; }
};

/** One is a PR that closes the other. */
export function linked(x: ScanItem, y: ScanItem): boolean {
  return (x.kind === "pr" && issuesOf(x).includes(y.number)) || (y.kind === "pr" && issuesOf(y).includes(x.number));
}

/** Whether `other` may be compared with `item`: not itself, not linked to it, the same kind, and open or closed within the last year. */
export function comparable(item: ScanItem, other: ScanItem, nowMs: number): boolean {
  if (item.repo !== other.repo || item.number === other.number || linked(item, other) || item.kind !== other.kind) return false;
  if (other.state === "OPEN") return true;
  const at = Date.parse(other.merged_at ?? other.closed_at ?? "");
  return Number.isFinite(at) && nowMs - at <= CLOSED_WINDOW_DAYS * DAY;
}

export type Pair = { repo: string; a: number; b: number; a_hash: string; b_hash: string; similarity: number };

export async function neighbourPairs(db: Db, index: VectorIndex, item: ScanItem, nowMs: number, threshold = SIM_THRESHOLD, cap = MAX_NEIGHBOURS): Promise<Pair[]> {
  const v = await index.vectorOf(db, item.repo, item.number);
  if (!v) return [];
  // A quiet pull request is never paired: a duplicate close or group question would name it on GitHub.
  if (await db.get(db.k.selectNoFrom((eb) => eb.lit(1).as("q")).where((eb) => quietExprFor(db, eb, eb.val(item.repo), eb.val(item.number))))) return [];
  const out: Pair[] = [];
  for (const h of await index.nearest(db, v, LOOKUP, `${item.repo}#${item.number}`, item.repo)) {
    if (h.score < threshold || out.length >= cap) break;
    const row = await db.get(db.k.selectFrom("items as i").select(COLS).where("i.repo", "=", h.repo).where("i.number", "=", h.number)
      .where((eb) => eb.and([notOwnIntegrationExpr(db, eb, "i"), eb.not(quietExprFor(db, eb, "i.repo", "i.number"))])));
    if (!row || !row.embed_hash) continue;
    const o: ScanItem = { ...row, embed_hash: row.embed_hash };
    if (!comparable(item, o, nowMs)) continue;
    const [x, y] = item.number < o.number ? [item, o] : [o, item];
    out.push({ repo: item.repo, a: x.number, b: y.number, a_hash: x.embed_hash, b_hash: y.embed_hash, similarity: Math.round(h.score * 10000) / 10000 });
  }
  return out;
}

/** Stores the item's new pairs and marks it scanned. Pairs already checked at these hashes, and pairs an operator ruled on, are not added again. Returns the number added. */
export async function scanItem(db: Db, index: VectorIndex, item: ScanItem, now: Date): Promise<number> {
  // A planned item whose text changed after planning has no hash until it is embedded again; it is scanned then.
  if (!item?.embed_hash) return 0;
  const pairs = await neighbourPairs(db, index, item, now.getTime());
  let added = 0;
  await db.write(async () => {
    for (const p of pairs) {
      if (await db.get(db.k.selectFrom("duplicate_pairs").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("a", "=", p.a).where("b", "=", p.b).where("by_operator", "=", 1))) continue;
      added += (await db.run(db.k.insertInto("duplicate_pairs").values({ repo: p.repo, a: p.a, b: p.b, a_hash: p.a_hash, b_hash: p.b_hash, similarity: p.similarity, created_at: now.toISOString() })
        .onConflict((oc) => oc.doNothing()))).changes;
    }
    await db.run(db.k.insertInto("duplicate_scans").values({ repo: item.repo, number: item.number, hash: item.embed_hash, at: now.toISOString() })
      .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["hash", "at"]))));
  });
  return added;
}

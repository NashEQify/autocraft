// Which item of a duplicate group stays. In order:
//   1. an item that is closed or merged (the open ones duplicate something already done or decided);
//   2. an issue that a merged PR fixes;
//   3. the one with clearly more activity: ACTIVITY_MARGIN more comments;
//   4. the older one;
//   5. the lower number.
import type { Db } from "../db/index.ts";

export const ACTIVITY_MARGIN = 5;

export type CanonInfo = { number: number; state: string; created_at: string | null; comments: number; fixedByMerged: boolean };

const closed = (i: CanonInfo) => i.state !== "OPEN";

/** Negative when `x` is the better one to keep. */
export function compareCanonical(x: CanonInfo, y: CanonInfo): number {
  if (closed(x) !== closed(y)) return closed(x) ? -1 : 1;
  if (x.fixedByMerged !== y.fixedByMerged) return x.fixedByMerged ? -1 : 1;
  if (Math.abs(x.comments - y.comments) >= ACTIVITY_MARGIN) return y.comments - x.comments;
  if (x.created_at !== y.created_at) return x.created_at === null ? 1 : y.created_at === null ? -1 : x.created_at < y.created_at ? -1 : 1;
  return x.number - y.number;
}

/** CanonInfo of the items, keyed by `repo#number`, in one query; an item not in the database has no entry. */
export async function canonInfoAll(db: Db, items: { repo: string; number: number }[]): Promise<Map<string, CanonInfo>> {
  // The issues merged PRs of these repos close, with each PR's list parsed once.
  const rows = await db.prepare(`WITH fixed AS MATERIALIZED (SELECT DISTINCT p.repo, f.value AS number FROM items p,
      json_each(CASE WHEN json_valid(p.closing_issues) THEN p.closing_issues ELSE '[]' END) f
      WHERE p.kind = 'pr' AND p.state = 'MERGED' AND p.repo IN (SELECT value ->> 0 FROM json_each(?1)))
    SELECT i.repo || '#' || i.number AS k, i.number, i.state, i.created_at, COALESCE(i.comments_count, 0) AS comments,
      EXISTS (SELECT 1 FROM fixed x WHERE x.repo = i.repo AND x.number = i.number) AS fixed
    FROM json_each(?1) j JOIN items i ON i.repo = j.value ->> 0 AND i.number = j.value ->> 1`).all(JSON.stringify(items.map((x) => [x.repo, x.number]))) as
    { k: string; number: number; state: string; created_at: string | null; comments: number; fixed: number }[];
  return new Map(rows.map((r) => [r.k, { number: r.number, state: r.state, created_at: r.created_at, comments: r.comments, fixedByMerged: r.fixed === 1 }]));
}

export function canonInfo(db: Db, repo: string, numbers: number[], known: Map<string, CanonInfo> = canonInfoAll(db, numbers.map((number) => ({ repo, number })))): CanonInfo[] {
  return numbers.map((n) => {
    const r = known.get(`${repo}#${n}`);
    if (!r) throw new Error(`${repo}#${n} is not in the database`);
    return r;
  });
}

/** The item to keep, and a short reason for the decision card. */
export function pickCanonical(db: Db, repo: string, numbers: number[], known?: Map<string, CanonInfo>): { number: number; why: string } {
  const sorted = canonInfo(db, repo, numbers, known).sort(compareCanonical);
  const [best, next] = sorted as [CanonInfo, CanonInfo | undefined];
  const why = !next ? "the only one"
    : closed(best) !== closed(next) ? `it is already ${best.state === "MERGED" ? "merged" : "closed"}`
    : best.fixedByMerged !== next.fixedByMerged ? "a merged PR fixes it"
    : Math.abs(best.comments - next.comments) >= ACTIVITY_MARGIN ? "it has much more discussion"
    : "it is the older one";
  return { number: best.number, why };
}

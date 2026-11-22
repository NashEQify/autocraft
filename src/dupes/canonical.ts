// Which item of a duplicate group stays. In order:
//   1. an item that is closed or merged (the open ones duplicate something already done or decided);
//   2. an issue that a merged PR fixes;
//   3. the one with clearly more activity: ACTIVITY_MARGIN more comments;
//   4. the older one;
//   5. the lower number.
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

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
  const rows = await db.all(db.k.with((cte) => cte("fixed").materialized(), (qb) => qb.selectFrom("items as p")
    .crossJoin((eb) => kx.jsonEach(db, eb.case().when(kx.jsonValid(db, "p.closing_issues")).then(eb.ref("p.closing_issues")).else(eb.val("[]")).end(), "f", "bigint"))
    .select(["p.repo", "f.value as number"]).distinct()
    .where("p.kind", "=", "pr").where("p.state", "=", "MERGED").where(kx.inList(db, "p.repo", items.map((x) => x.repo))))
    .selectFrom(kx.refPairs(db, items.map((x) => [x.repo, x.number] as const), "j"))
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "j.repo").onRef("i.number", "=", "j.number"))
    .select((eb) => ["i.repo", "i.number", "i.state", "i.created_at", eb.fn.coalesce("i.comments_count", eb.lit(0)).as("comments"),
      eb.case().when(eb.exists(eb.selectFrom("fixed as x").select(eb.lit(1).as("one")).whereRef("x.repo", "=", "i.repo").whereRef("x.number", "=", "i.number"))).then(eb.lit(1)).else(eb.lit(0)).end().as("fixed")]));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, { number: r.number, state: r.state, created_at: r.created_at, comments: r.comments, fixedByMerged: r.fixed === 1 }]));
}

export async function canonInfo(db: Db, repo: string, numbers: number[], known?: Map<string, CanonInfo>): Promise<CanonInfo[]> {
  if (known === undefined) known = await canonInfoAll(db, numbers.map((number) => ({ repo, number })));
  return numbers.map((n) => {
    const r = known.get(`${repo}#${n}`);
    if (!r) throw new Error(`${repo}#${n} is not in the database`);
    return r;
  });
}

/** The item to keep, and a short reason for the decision card. */
export async function pickCanonical(db: Db, repo: string, numbers: number[], known?: Map<string, CanonInfo>): Promise<{ number: number; why: string }> {
  const sorted = (await canonInfo(db, repo, numbers, known)).sort(compareCanonical);
  const [best, next] = sorted as [CanonInfo, CanonInfo | undefined];
  const why = !next ? "the only one"
    : closed(best) !== closed(next) ? `it is already ${best.state === "MERGED" ? "merged" : "closed"}`
    : best.fixedByMerged !== next.fixedByMerged ? "a merged PR fixes it"
    : Math.abs(best.comments - next.comments) >= ACTIVITY_MARGIN ? "it has much more discussion"
    : "it is the older one";
  return { number: best.number, why };
}

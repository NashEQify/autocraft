// The order the Act step works in: the item's priority level (security raised, as the work rank holds it), then the time of the answer, oldest first.
import { DEFAULT_BAND } from "../rank/level.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type TargetKey = { band: number; at: string };

/** `band` (4 for P0 down to 0 for P4) and answer time of each decision, in one query. */
export async function targetKeys(db: Db, targets: { decisionId: string; repo: string; number: number }[]): Promise<Map<string, TargetKey>> {
  const out = new Map<string, TargetKey>();
  if (!targets.length) return out;
  const rows = await db.all(db.k.selectFrom("main.decisions as d")
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "d.repo").onRef("r.number", "=", "d.number"))
    .select((eb) => ["d.id", eb.fn.coalesce("d.answered_at", eb.val("")).as("at"), eb.fn.coalesce(eb("r.score", "/", eb.lit(10000)), eb.lit(DEFAULT_BAND)).as("band")])
    .where(kx.inList(db, "d.id", targets.map((t) => t.decisionId))));
  for (const r of rows) out.set(r.id, { band: Math.min(4, Math.floor(r.band)), at: r.at });
  return out;
}

const cmp = (a: TargetKey | undefined, b: TargetKey | undefined): number => {
  const x = a ?? { band: DEFAULT_BAND, at: "" }, y = b ?? { band: DEFAULT_BAND, at: "" };
  return y.band - x.band || (x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
};

/** Orders targets by level then answer time; ties by repo and number. */
export async function orderTargets<T extends { decisionId: string; repo: string; number: number }>(db: Db, targets: T[]): Promise<T[]> {
  const key = await targetKeys(db, targets);
  return [...targets].sort((a, b) => cmp(key.get(a.decisionId), key.get(b.decisionId)) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number));
}

export { cmp as compareKeys };

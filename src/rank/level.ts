// The urgency band of an item for queue ordering: the priority level after the security raise, from the stored work rank
// (src/rank/score.ts keeps the level in the ten-thousands digit). Higher is more urgent; an unrated item counts as P2.
import { LEVELS } from "../priority/score.ts";
import type { Db } from "../db/index.ts";

export const DEFAULT_BAND = LEVELS.length - 1 - LEVELS.indexOf("P2");

/** 4 for P0 down to 0 for P4. */
export async function levelBand(db: Db, repo: string | null | undefined, number: number | null | undefined): Promise<number> {
  if (!repo || number === null || number === undefined) return DEFAULT_BAND;
  const r = await db.get(db.k.selectFrom("main.item_rank").select("score").where("repo", "=", repo).where("number", "=", number));
  return r ? Math.floor(r.score / 10000) : DEFAULT_BAND;
}

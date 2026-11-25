// Item rank (M08 triage-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { RankItemRow, RankPut, RankRow, RefKey } from "./types.ts";
import type { Ref } from "../keys.ts";

/** Score, breakdown and compute time. */
export async function loadRanks(db: Db, keys: KeySource): Promise<Map<RefKey, RankRow>> {
  throw new Error("not built: triage.loadRanks");
}

/** Scores only; the weight from `item_workflows` is added by the caller. */
export async function loadRankScores(db: Db, k: KeySource | { repos: string[] }): Promise<Map<RefKey, number>> {
  throw new Error("not built: triage.loadRankScores");
}

/** Three `alone` loads: open tracked items with priority, `item_settled` rows, every `item_rank` row. After `ensureSettled`. */
export async function loadRankInputs(db: Db, run: string): Promise<{ items: RankItemRow[]; old: Map<RefKey, { score: number; breakdown: RankRow["breakdown"] }> }> {
  throw new Error("not built: triage.loadRankInputs");
}

/** Upsert one statement per 500 puts plus one delete per 500; the caller wraps it in `planner.bulkWrites` for large batches. */
export async function saveRanks(db: Db, puts: RankPut[], dels: Ref[]): Promise<{ changed: number; removed: number }> {
  throw new Error("not built: triage.saveRanks");
}

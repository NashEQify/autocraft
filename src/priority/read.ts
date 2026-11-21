import type { PriorityInfo } from "../../web/src/api/types.ts";
import type { Level } from "./score.ts";
import type { Db } from "../db/index.ts";

/** The badge data for one item, or null before it was rated. */
export async function priorityOf(db: Db, repo: string, number: number): Promise<PriorityInfo | null> {
  const r = await db.prepare("SELECT impact, model, reason FROM item_priority WHERE repo = ? AND number = ?").get(repo, number) as
    { impact: Level; model: string; reason: string | null } | undefined;
  return r ? { level: r.impact, model: r.model, reason: r.reason } : null;
}

import type { PriorityInfo } from "../../web/src/api/types.ts";
import type { Level } from "./score.ts";
import type { Db } from "../db/index.ts";

/** The badge data for one item, or null before it was rated. */
export async function priorityOf(db: Db, repo: string, number: number): Promise<PriorityInfo | null> {
  const r = await db.get(db.k.selectFrom("item_priority").select(["impact", "model", "reason"]).where("repo", "=", repo).where("number", "=", number)
    .$narrowType<{ impact: Level }>());
  return r ? { level: r.impact, model: r.model, reason: r.reason } : null;
}

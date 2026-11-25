// Item priority and reach (M08 triage-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { PriorityRow, RefKey } from "./types.ts";
import type { Ref } from "../keys.ts";

/** Stored priority rows. */
export async function loadPriorities(db: Db, keys: KeySource): Promise<Map<RefKey, PriorityRow>> {
  throw new Error("not built: triage.loadPriorities");
}

/** Batched upsert, one statement per 500 rows; joins the caller's transaction. */
export async function savePriorities(db: Db, rows: PriorityRow[]): Promise<Set<RefKey>> {
  throw new Error("not built: triage.savePriorities");
}

/** Rereads duplicate counts, comment stats and open PR links in one wave and rewrites the changed scores with `updateFrom`; returns the number changed. */
export async function rescoreReach(db: Db, nowMs?: number): Promise<number> {
  throw new Error("not built: triage.rescoreReach");
}

/** Canonical duplicate counts per item. */
export async function loadDuplicateCounts(db: Db): Promise<Map<RefKey, number>> {
  throw new Error("not built: triage.loadDuplicateCounts");
}

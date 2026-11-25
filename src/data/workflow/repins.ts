// Autorepin (M11 workflow-b).
import type { Db } from "../../db/index.ts";
import type { RepinKey, RepinPatch, RepinRequest, RepinRow, RepinState, RefKey } from "./types.ts";

/** Off-marker upsert, cancel of locking rows (`RETURNING task_id`) and row upsert; one `db.write`. */
export async function requestRepin(db: Db, r: RepinRequest): Promise<{ result: "set" | "off"; cancelledTasks: number[] }> {
  throw new Error("not built: workflow.requestRepin");
}

/** The `due()` predicate, reading `build.build_tasks` and `mirror.items`. */
export async function loadRepinsDue(db: Db, now: Date): Promise<RepinRow[]> {
  throw new Error("not built: workflow.loadRepinsDue");
}

/** Existence probe for the runner tick. */
export async function hasRepinDue(db: Db, now: Date): Promise<boolean> {
  throw new Error("not built: workflow.hasRepinDue");
}

/** The own-push chain and the off marker. */
export async function loadRepins(db: Db, refs: { repo: string; number: number }[], o?: { states?: RepinState[]; offsAfter?: boolean }): Promise<Map<RefKey, RepinRow[]>> {
  throw new Error("not built: workflow.loadRepins");
}

/** Batched compare-and-set update, one statement per distinct patch column set. */
export async function saveRepins(db: Db, rows: { key: RepinKey; expectState?: RepinState; patch: RepinPatch }[]): Promise<number> {
  throw new Error("not built: workflow.saveRepins");
}

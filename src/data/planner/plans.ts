// Stored plans and their history (`item_plans`, `item_plans_rev`, `plan_history`).
import type { Db } from "../../db/index.ts";
import type { ActionKind, ItemKeys, PlanFilter, PlanHistoryEntry, PlanHistoryRow, PlanRow, PlanVersion, RefKey, StoredPlan, StoredPlans } from "./types.ts";

/** The plan revision, and the stored rows when the per-connection memo is stale. */
export async function loadStoredPlans(db: Db): Promise<StoredPlans> { throw new Error("not built: planner.loadStoredPlans"); }
/**
 * Diffs `planned` against the stored rows, keeps `since` while phase and wait are unchanged, writes history for changed state or wait
 * and a `gone` row per exit, upserts changed rows in chunks, deletes exited rows. Joins the pass's transaction; a quiet pass writes nothing.
 */
export async function savePlans(db: Db, planned: PlanRow[], plannedAt: string, stored?: StoredPlans): Promise<{ written: number; deleted: number }> { throw new Error("not built: planner.savePlans"); }
/** Stored plans of `keys`. 1 statement. */
export async function loadPlans(db: Db, keys: ItemKeys): Promise<Map<RefKey, StoredPlan>> { throw new Error("not built: planner.loadPlans"); }
/** Stored plans matching `filter`. 1 statement. */
export async function listPlans(db: Db, filter: PlanFilter): Promise<StoredPlan[]> { throw new Error("not built: planner.listPlans"); }
/** Refs that can be due for `kind`: plans holding an action of it, logged changes, items with no plan; null when no plan is stored. */
export async function loadDueRefs(db: Db, kind: ActionKind, side: "item" | "pr", repo?: string): Promise<RefKey[] | null> { throw new Error("not built: planner.loadDueRefs"); }
/** Plan history per ref, newest first. */
export async function loadPlanHistory(db: Db, keys: RefKey[], opts?: { limit?: number }): Promise<Map<RefKey, PlanHistoryRow[]>> { throw new Error("not built: planner.loadPlanHistory"); }
/** Plan history rows for the activity feed. */
export async function listPlanHistory(db: Db, opts: { afterId?: number; since?: string; limit: number }): Promise<PlanHistoryEntry[]> { throw new Error("not built: planner.listPlanHistory"); }
/** Deletes history older than `keepMs`. Returns the rows removed. */
export async function prunePlanHistory(db: Db, keepMs: number, nowMs?: number): Promise<number> { throw new Error("not built: planner.prunePlanHistory"); }
/** Plan and history fingerprints per ref for the item page's change probe. */
export async function loadPlanVersions(db: Db, keys: RefKey[]): Promise<Map<RefKey, PlanVersion>> { throw new Error("not built: planner.loadPlanVersions"); }

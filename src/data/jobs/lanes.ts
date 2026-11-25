// Lane lists, lane state and the planner's gate inputs (M07 jobs).
import type { Db } from "../../db/index.ts";
import type { LaneInputs, LaneStateKind, LaneStateRow, LaneStatePut, StoredLaneItems } from "./types.ts";

/** One load per planner pass: eight statements in one `together`, joined into the pass's wave. */
export async function loadLaneInputs(db: Db, nowMs: number): Promise<LaneInputs> {
  throw new Error("not built: jobs.loadLaneInputs");
}

/** One upsert of the changed lanes and one delete of lanes no longer present; one `db.write`. */
export async function saveLanes(db: Db, lanes: { lane: string; total: number; items: string[]; at: string }[], keepOthers?: boolean): Promise<void> {
  throw new Error("not built: jobs.saveLanes");
}

/** The stored lane lists. */
export async function loadLanes(db: Db, names?: string[]): Promise<StoredLaneItems> {
  throw new Error("not built: jobs.loadLanes");
}

/** One upsert for everything a pass or an apply writes: fingerprints, resets, cursors, marks. */
export async function saveLaneState(db: Db, rows: LaneStatePut[]): Promise<void> {
  throw new Error("not built: jobs.saveLaneState");
}

/** Deletes state rows. */
export async function removeLaneState(db: Db, keys: { kind: LaneStateKind; step: string; repo?: string }[]): Promise<number> {
  throw new Error("not built: jobs.removeLaneState");
}

/** Marks and cursors outside a pass, keyed "kind|step|repo". */
export async function loadLaneState(db: Db, kinds?: LaneStateKind[]): Promise<Map<string, LaneStateRow>> {
  throw new Error("not built: jobs.loadLaneState");
}

/** Compare-and-set on a `lane_state` row of kind `mark`: sets the time only when the stored one is older than `minGapMs`; true when this caller won. */
export async function claimMark(db: Db, name: string, nowMs: number, minGapMs: number): Promise<boolean> {
  throw new Error("not built: jobs.claimMark");
}

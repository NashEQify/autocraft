// The liveness check result (`liveness_items`, `liveness_state`).
import type { Db } from "../../db/index.ts";
import type { Liveness, LivenessInput, RefKey } from "./types.ts";

/** Stored plans of open items not `Pipeline off`, `Merged` or `Closed`, and the refs of live workflows in `recommending` or `blocked`. 2 statements in one wave. */
export async function loadLivenessInputs(db: Db): Promise<LivenessInput> { throw new Error("not built: planner.loadLivenessInputs"); }
/** When the check last ran and the open count; null before the first run. Joins the pass's wave. */
export async function loadLivenessState(db: Db): Promise<{ checkedAt: string; open: number } | null> { throw new Error("not built: planner.loadLivenessState"); }
/** Replaces the whole table and upserts the state row in one transaction. */
export async function saveLiveness(db: Db, res: Liveness): Promise<void> { throw new Error("not built: planner.saveLiveness"); }
/** The stored result. 2 statements in one wave. */
export async function loadLiveness(db: Db): Promise<Liveness | null> { throw new Error("not built: planner.loadLiveness"); }
/** The refs among `keys` with verdict `stuck`. */
export async function loadStuck(db: Db, keys: RefKey[]): Promise<Set<RefKey>> { throw new Error("not built: planner.loadStuck"); }

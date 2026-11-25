// reads: build.build_tasks
import type { Db } from "../../db/index.ts";
import type { CheckShape } from "./types.ts";

/**
 * The run times in ms of the repo's last `limit` successful checks of `shape`. Joins `model_checks` to the task's start and end
 * times and applies `state = 'done'` before the limit, so it cannot be two loads.
 */
export async function loadCheckDurations(db: Db, repo: string, shape: CheckShape, limit: number): Promise<number[]> {
  throw new Error("not built: changes.loadCheckDurations");
}

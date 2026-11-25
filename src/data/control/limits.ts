// Stage limits (M06 control-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { LimitRow, StageDefaults } from "./types.ts";

/** One row per step; a row with `limit_set = 0` takes the step default. */
export async function loadStageLimits(db: Db, defaults?: StageDefaults): Promise<Map<string, LimitRow>> {
  throw new Error("not built: control.loadStageLimits");
}

/** `step=per_day:reset_at` joined, for the planner tick wave. */
export async function limitsSignature(db: Db): Promise<string> {
  throw new Error("not built: control.limitsSignature");
}

/** Upsert with `limit_set = 1` plus the `stage-limit` audit row; validation stays in feature code. */
export async function setStageLimit(db: Db, step: string, perDay: number | null, by: string): Promise<void> {
  throw new Error("not built: control.setStageLimit");
}

/** One multi-row upsert that sets `reset_at`; a step without a row gets `limit_set = 0`. */
export async function resetLimitCounts(db: Db, steps: string[], at: string, defaults: StageDefaults, by: string): Promise<void> {
  throw new Error("not built: control.resetLimitCounts");
}

/** `per_day` of `act`, default applied. */
export async function loadActLimit(db: Db): Promise<number | null> {
  throw new Error("not built: control.loadActLimit");
}

/** Act job items plus finished card writes since `since`. */
export async function loadActUsage(db: Db, since: string): Promise<number> {
  throw new Error("not built: control.loadActUsage");
}

/** Finished audit rows by `details.card`, grouped. */
export async function countCardWrites(db: Db, cardIds: string[] | KeySource): Promise<Map<number, number>> {
  throw new Error("not built: control.countCardWrites");
}

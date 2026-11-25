// Writers (M15 intake part).
import type { Db } from "../../db/index.ts";
import type { Hold, OutsideLimits } from "./types.ts";
import type { Ref } from "../keys.ts";

/** Wave 1 (candidates over `mirror.itemsSince`, released and admitted flags, the surge trip, insiders), an optional wave 2 (whitelist overrides), the pure `computeHolds`, then one `db.write`: `control.tripStage` when tripped, admissions, and a diff write of `outside_holds`. Never calls GitHub or a model. */
export async function recomputeHolds(db: Db, opts?: { now?: number }): Promise<{ holds: Hold[]; tripped: boolean; wakeAt: number | null }> {
  throw new Error("not built: intake.recomputeHolds");
}

/** Moves holds to `outside_released` and audits; throws `OutsideError(409)` when `refs` is non-empty and none was held; one `db.write`. */
export async function releaseHeld(db: Db, by: string, refs: Ref[]): Promise<number> {
  throw new Error("not built: intake.releaseHeld");
}

/** The same keyed by author (case-insensitive); throws 409 when nothing is held. */
export async function releaseAuthor(db: Db, by: string, author: string): Promise<number> {
  throw new Error("not built: intake.releaseAuthor");
}

/** Validates with `parseOutsideLimits`, then `control.saveSettings` with the `abuse-limits` audit row. */
export async function saveOutsideLimits(db: Db, by: string, input: unknown): Promise<OutsideLimits> {
  throw new Error("not built: intake.saveOutsideLimits");
}

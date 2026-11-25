// Pure rules of the outside-author budgets; no handle (M15 intake part).
import type { Db } from "../../db/index.ts";
import type { HoldInfo, HoldInput, HoldResult, OutsideAuthorRow, OutsideLimits } from "./types.ts";

/** Association, bot and insider tests of today's `isOutsideAuthor`, without the handle. */
export function isOutsideAuthor(row: OutsideAuthorRow, insiders: ReadonlySet<string>): boolean {
  throw new Error("not built: intake.isOutsideAuthor");
}

/** The wait text of a hold (unchanged; `plan-cache.ts` uses it). */
export function holdWait(h: Pick<HoldInfo, "reason" | "kind" | "limit">): string {
  throw new Error("not built: intake.holdWait");
}

/** Validation of `saveOutsideLimits` (whole numbers 0..100,000); throws `OutsideError`. */
export function parseOutsideLimits(input: unknown, was: OutsideLimits): OutsideLimits {
  throw new Error("not built: intake.parseOutsideLimits");
}

/** The pure rule: decides the surge trip, the holds, `wakeAt` and the admissions from the loaded candidates, whitelist verdicts, limits and breaker state. */
export function computeHolds(input: HoldInput): HoldResult {
  throw new Error("not built: intake.computeHolds");
}

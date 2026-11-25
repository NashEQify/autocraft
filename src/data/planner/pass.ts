// Pass statistics and shadow-check differences (`plan_pass_stats`, `plan_shadow_diffs`).
import type { Db } from "../../db/index.ts";
import type { PassCount, PassReport, ShadowDiff } from "./types.ts";

/** One multi-row upsert of the counts, one insert of the diffs, then trims `plan_shadow_diffs` and old hourly rows. Joins the pass's transaction. */
export async function recordPass(db: Db, counts: PassCount[], diffs: ShadowDiff[]): Promise<void> { throw new Error("not built: planner.recordPass"); }
/** Logged changes, pass stats, full-pass causes and shadow diff count, for `plan-log status`. 4 statements in one wave. */
export async function loadPassReport(db: Db): Promise<PassReport> { throw new Error("not built: planner.loadPassReport"); }

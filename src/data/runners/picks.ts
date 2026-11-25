// Picks: "Run on my Task Runner" (package runners-b).
import type { Db } from "../../db/index.ts";
import type { PickContext } from "./types.ts";

/** The call, the user's fresh runners, live pick count, cool-off, picker logins and the pick cap in one wave. */
export async function loadPickContext(db: Db, user: string, callId: number, now: number): Promise<PickContext> { throw new Error("not built: runners.loadPickContext"); }
/** Re-counts live picks and sets the pick in one compare-and-set. */
export async function savePick(db: Db, a: { callId: number; login: string; cap: number; max: number; now: number }): Promise<boolean> { throw new Error("not built: runners.savePick"); }

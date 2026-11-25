// The planner's triage facts (M08 triage-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { TriageFactsCtx, TriageFactsResult } from "./types.ts";

/** One wave of seven statements independent of item and repo count: the per-item row, slim verdicts, unchecked pair counts and the four `loadDupeState` statements. */
export async function loadTriageFacts(db: Db, keys: KeySource, ctx: TriageFactsCtx): Promise<TriageFactsResult> {
  throw new Error("not built: triage.loadTriageFacts");
}

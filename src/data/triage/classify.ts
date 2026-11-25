// Run cursor, classify state and verdict rows (M08 triage-a). The pure rule code of `classify/settled.ts` moves to `settle.ts` in the same package.
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ClassifierDuplicates, ClsRow, JevFailed, RefKey, RefereeRow, RunVerdict, Settled, VerdictInput } from "./types.ts";
import type { Ref } from "../keys.ts";

/** The current run: the `current_run` row, else the newest verdict run (jev rows union haiku-alone rows); one statement. */
export async function classifyRun(db: Db): Promise<string | null> {
  throw new Error("not built: triage.classifyRun");
}

/** For `classify current`. */
export async function classifyRunInfo(db: Db): Promise<{ set: string | null; derived: string | null }> {
  throw new Error("not built: triage.classifyRunInfo");
}

/** Reads the previous run, upserts, writes the `classify-run` audit row; one `db.write`. */
export async function setClassifyRun(db: Db, run: string, by: string): Promise<{ previous: string | null }> {
  throw new Error("not built: triage.setClassifyRun");
}

/** Whether the run has any verdict row. */
export async function runHasVerdicts(db: Db, run: string): Promise<boolean> {
  throw new Error("not built: triage.runHasVerdicts");
}

/** The `class_hash` at which a classify request got no valid Jev verdict. */
export async function loadJevFailed(db: Db, keys: KeySource): Promise<Map<RefKey, string>> {
  throw new Error("not built: triage.loadJevFailed");
}

/** Upsert on `classify_state`, one statement per 500 rows; joins the caller's transaction. */
export async function markJevFailed(db: Db, rows: JevFailed[]): Promise<number> {
  throw new Error("not built: triage.markJevFailed");
}

/** Deletes `jev_failed` rows of items no longer in the mirror. */
export async function pruneClassifyState(db: Db): Promise<number> {
  throw new Error("not built: triage.pruneClassifyState");
}

/** Verdict rows of the run; the slim form drops Jev's probabilities and keeps `reason` for sonnet rows only. */
export async function loadVerdicts(db: Db, keys: KeySource, run: string | null, o?: { slim?: boolean }): Promise<Map<RefKey, ClsRow[]>> {
  throw new Error("not built: triage.loadVerdicts");
}

/** The same statement as `loadVerdicts` plus the pure `settle`; an absent key means unclassified. */
export async function loadSettled(db: Db, keys: KeySource, run: string | null): Promise<Map<RefKey, Settled>> {
  throw new Error("not built: triage.loadSettled");
}

/** Reads `item_settled` (one row per item); `alone` without `keys`. The caller has called `ensureSettled`. */
export async function loadSettledRows(db: Db, run: string, keys?: KeySource): Promise<Map<RefKey, Settled>> {
  throw new Error("not built: triage.loadSettledRows");
}

/** Every verdict row of a run for evaluation reports. Marked `alone`. */
export async function loadRunRows(db: Db, run: string): Promise<RunVerdict[]> {
  throw new Error("not built: triage.loadRunRows");
}

/** The `sonnet` rows. */
export async function loadRefereeRows(db: Db, run: string, keys: KeySource): Promise<Map<RefKey, RefereeRow>> {
  throw new Error("not built: triage.loadRefereeRows");
}

/** `probs.opusFailedAt` of the run's sonnet rows. */
export async function loadRefereeFailureTimes(db: Db, run: string): Promise<string[]> {
  throw new Error("not built: triage.loadRefereeFailureTimes");
}

/** Legacy `dup_of` links in both directions. */
export async function loadClassifierDuplicates(db: Db, keys: KeySource): Promise<Map<RefKey, ClassifierDuplicates>> {
  throw new Error("not built: triage.loadClassifierDuplicates");
}

/** Latest row per classifier across runs (`row_number()` window). */
export async function loadLatestVerdicts(db: Db, keys: KeySource): Promise<Map<RefKey, ClsRow[]>> {
  throw new Error("not built: triage.loadLatestVerdicts");
}

/** Verdict count. */
export async function countVerdicts(db: Db, f: { run: string; classifier?: string; since?: string }): Promise<number> {
  throw new Error("not built: triage.countVerdicts");
}

/** `kx.replaceRows` on `(repo, number, classifier, run_id)`; rows get new rowids in the given order; if the batch fails each row is stored alone and the first error thrown after. */
export async function saveVerdicts(db: Db, rows: VerdictInput[]): Promise<Set<RefKey>> {
  throw new Error("not built: triage.saveVerdicts");
}

/** One transaction for a Jev chunk's verdict rows and `classify_state` rows. */
export async function saveJevChunk(db: Db, c: { verdicts: VerdictInput[]; failed: JevFailed[] }): Promise<Set<RefKey>> {
  throw new Error("not built: triage.saveJevChunk");
}

/** Sets `input_hash` on the run's haiku rows and deletes the item's superseded jev rows; two statements per 500 items. */
export async function markHaikuAlone(db: Db, run: string, since: string, hashes: ReadonlyMap<RefKey, string>): Promise<RefKey[]> {
  throw new Error("not built: triage.markHaikuAlone");
}

/** Reads the sonnet rows of the refs and rewrites them with `probs.opusFailures + 1` and `opusFailedAt`. */
export async function recordRefereeFailures(db: Db, run: string, refs: Ref[], now: string): Promise<number> {
  throw new Error("not built: triage.recordRefereeFailures");
}

/** Clears the run's sonnet flags, then flags the refs with `spot-check`. */
export async function markSpotCheck(db: Db, run: string, refs: Ref[]): Promise<void> {
  throw new Error("not built: triage.markSpotCheck");
}

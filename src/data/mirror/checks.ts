// Checks, review gates and diff facts (M01 mirror-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { DiffFactsKey, DiffFactsRow, Gate, GateRead, PrChecksRow, RefKey, RepoCiSignals } from "./types.ts";

/** The stored checks row of each PR. */
export async function loadChecks(db: Db, keys: KeySource, o?: { checksOnlyIfFailing?: boolean }): Promise<Map<RefKey, PrChecksRow>> {
  throw new Error("not built: mirror.loadChecks");
}

/** Batched upsert, one `db.write`; a known `mergeable` at the same head survives UNKNOWN. The follow-ups (`recordRuns`, `resolvePushes`, `noteMergeable`) stay calls of their own modules. */
export async function saveChecks(db: Db, rows: PrChecksRow[], at: string): Promise<void> {
  throw new Error("not built: mirror.saveChecks");
}

/** Whether a repo's checks are known and whether it has no CI, from the latest 20 rows per repo. */
export async function loadRepoCiSignals(db: Db, repos?: string[]): Promise<Map<string, RepoCiSignals>> {
  throw new Error("not built: mirror.loadRepoCiSignals");
}

/** Check names seen on the latest PR rows and main heads of each repo; two statements in one wave. */
export async function loadCheckSamples(db: Db, repos: string[]): Promise<Map<string, { pr: string[]; main: string[] }>> {
  throw new Error("not built: mirror.loadCheckSamples");
}

/** Review gate rows. */
export async function loadGates(db: Db, keys: KeySource | { repo: string }): Promise<Map<RefKey, Gate>> {
  throw new Error("not built: mirror.loadGates");
}

/** Batched upsert of gate reads. */
export async function saveGates(db: Db, rows: GateRead[]): Promise<void> {
  throw new Error("not built: mirror.saveGates");
}

/** Batched increment of the gate failure counter. */
export async function markGateFailures(db: Db, keys: RefKey[]): Promise<void> {
  throw new Error("not built: mirror.markGateFailures");
}

/** Diff facts keyed "ref@head". */
export async function loadDiffFacts(db: Db, heads: DiffFactsKey[] | KeySource): Promise<Map<string, DiffFactsRow>> {
  throw new Error("not built: mirror.loadDiffFacts");
}

/** Every diff-facts row, for the rebuild only. Marked `alone`. */
export async function loadAllDiffFacts(db: Db): Promise<Map<string, DiffFactsRow>> {
  throw new Error("not built: mirror.loadAllDiffFacts");
}

/** Batched upsert of diff facts. */
export async function saveDiffFacts(db: Db, rows: DiffFactsRow[], mode: "upsert-if-changed" | "insert-ignore"): Promise<void> {
  throw new Error("not built: mirror.saveDiffFacts");
}

/** Compare-and-set update guarded by `IS NOT DISTINCT FROM` on the previous value; returns the rows changed. */
export async function setDiffFactsIf(db: Db, rows: { key: DiffFactsKey; was: string | null; to: DiffFactsRow }[]): Promise<number> {
  throw new Error("not built: mirror.setDiffFactsIf");
}

/** Batched update of the read time. */
export async function markDiffRead(db: Db, heads: DiffFactsKey[], at: string): Promise<void> {
  throw new Error("not built: mirror.markDiffRead");
}

/** Batched delete. */
export async function removeDiffFacts(db: Db, heads: DiffFactsKey[]): Promise<void> {
  throw new Error("not built: mirror.removeDiffFacts");
}

// Duplicate pairs, scans, comparisons, drops and groups (M09 triage-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { Ref } from "../keys.ts";
import type { CanonInfo, ComparisonPut, DupeGroupPut, DupeSignal, DupeState, Pair, PairKey, PairVerdictPut, RefKey, ScanContext } from "./types.ts";

/** Operator-ruled pairs, `duplicate_scans` rows and stored pairs for a chunk of up to 1,000 items in one wave. */
export async function loadScanContext(db: Db, refs: Ref[]): Promise<ScanContext> {
  throw new Error("not built: triage.loadScanContext");
}

/** `INSERT ... ON CONFLICT DO NOTHING` for pairs and an upsert for scans, two statements per 500 rows; one transaction per chunk. */
export async function saveScans(db: Db, pairs: Pair[], scans: { repo: string; number: number; hash: string; at: string }[]): Promise<number> {
  throw new Error("not built: triage.saveScans");
}

/** Keeps the materialized CTE and scalar-subquery shape of `check.ts` (the Postgres plan). */
export async function loadUncheckedPairs(db: Db, o?: { limit?: number; repo?: string; refs?: KeySource }): Promise<PairKey[]> {
  throw new Error("not built: triage.loadUncheckedPairs");
}

/** Unchecked pairs per item. */
export async function loadUncheckedPairCounts(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  throw new Error("not built: triage.loadUncheckedPairCounts");
}

/** `mirror.loadItems` and `mirror.loadMergedClosures` in one wave; the pure `compareCanonical` and `pickCanonical` stay. */
export async function loadCanonicalInfo(db: Db, refs: Ref[]): Promise<Map<RefKey, CanonInfo>> {
  throw new Error("not built: triage.loadCanonicalInfo");
}

/** `kx.updateFrom` on `(repo, a, b, a_hash, b_hash)`, one statement per 500. */
export async function savePairVerdicts(db: Db, rows: PairVerdictPut[]): Promise<number> {
  throw new Error("not built: triage.savePairVerdicts");
}

/** Duplicate edges, member rows, stored comparisons and drops in four statements, one wave. */
export async function loadDupeState(db: Db, o?: { repo?: string }): Promise<DupeState> {
  throw new Error("not built: triage.loadDupeState");
}

/** Batched upsert; each row carries its set snapshot. */
export async function saveComparisons(db: Db, rows: ComparisonPut[]): Promise<void> {
  throw new Error("not built: triage.saveComparisons");
}

/** Batched upsert into `dupe_drops`. */
export async function saveDrops(db: Db, rows: { repo: string; key: string; hash: string; at: string }[]): Promise<void> {
  throw new Error("not built: triage.saveDrops");
}

/** Prefixes the hash with `again:` and audits. */
export async function markComparisonsStale(db: Db, repo: string, number: number, by: string): Promise<number> {
  throw new Error("not built: triage.markComparisonsStale");
}

/** Sole writer of `dupe_groups`: delete the repo's items and groups, insert groups and items; four multi-row statements. */
export async function saveDupeGroups(db: Db, repo: string, groups: DupeGroupPut[]): Promise<void> {
  throw new Error("not built: triage.saveDupeGroups");
}

/** The item's group id, role, target and comparison reason. */
export async function loadDupeSignals(db: Db, keys: KeySource): Promise<Map<RefKey, DupeSignal>> {
  throw new Error("not built: triage.loadDupeSignals");
}

/** Pair partners of each item. */
export async function loadDuplicatesOf(db: Db, keys: KeySource): Promise<Map<RefKey, { other: number; canonical: boolean }[]>> {
  throw new Error("not built: triage.loadDuplicatesOf");
}

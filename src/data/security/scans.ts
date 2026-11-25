// Scans, areas and model calls (package security).
import type { Db } from "../../db/index.ts";
import type { EndScanCall, NewArea, NewScanCall, ScanDetailData, ScanListRow, ScanRow, ScanRunData, ScanState, FindingBriefRow } from "./types.ts";

/** Scan rows with the listed-finding count from a grouped join. 1 statement. */
export async function loadScans(db: Db, ids: number[]): Promise<Map<number, ScanListRow>> { throw new Error("not built: security.loadScans"); }
/** Newest scans first; does not reconcile. */
export async function listScans(db: Db, f: { repos?: string[]; repo?: string; limit: number }): Promise<ScanListRow[]> { throw new Error("not built: security.listScans"); }
/** The highest-id active scan per repo (window function). */
export async function loadActiveScans(db: Db, repos: string[] | "all"): Promise<Map<string, ScanRow>> { throw new Error("not built: security.loadActiveScans"); }
/** State and cost of a scan, for the stop and cap check before each model call. */
export async function loadScanGuard(db: Db, id: number): Promise<{ state: ScanState; cost_usd: number } | undefined> { throw new Error("not built: security.loadScanGuard"); }
/** Everything the scan job's start needs, in one `together` wave: scan, areas, known findings and next number, earlier call costs, leftover per area. 4 statements. */
export async function loadScanRun(db: Db, id: number): Promise<ScanRunData | undefined> { throw new Error("not built: security.loadScanRun"); }
/** The scan page's data in one wave: scan, areas, calls with area names, listed findings with scan-test state, and the scan's runs. 6 statements. */
export async function loadScanDetail(db: Db, id: number): Promise<ScanDetailData | undefined> { throw new Error("not built: security.loadScanDetail"); }
/** The 20 newest scans with counts and up to 500 listed findings with scan-test state. 2 statements. */
export async function loadOverview(db: Db, repo: string): Promise<{ scans: ScanListRow[]; findings: FindingBriefRow[] }> { throw new Error("not built: security.loadOverview"); }
/** Inserts a scan; joins the caller's transaction. */
export async function addScan(db: Db, r: { repo: string; cap_usd: number | null; started_by: string }): Promise<number> { throw new Error("not built: security.addScan"); }
/** Links the scan to its job; joins the caller's transaction. */
export async function linkScanJob(db: Db, scanId: number, jobId: number): Promise<void> { throw new Error("not built: security.linkScanJob"); }
/** Sets the scan state, guarded by the active states. */
export async function setScanState(db: Db, id: number, state: "modeling" | "scanning" | "verifying"): Promise<void> { throw new Error("not built: security.setScanState"); }
/** Records the commit the scan reads. */
export async function setScanCommit(db: Db, id: number, sha: string): Promise<void> { throw new Error("not built: security.setScanCommit"); }
/** One multi-row area insert and one scan update with `estimate_usd = cost_usd + guess` in SQL, in one `db.write`. */
export async function saveThreatModel(db: Db, id: number, m: { summaryJson: string; areas: NewArea[]; guessUsd: number }): Promise<void> { throw new Error("not built: security.saveThreatModel"); }
/** Inserts a running call row; returns its id. */
export async function beginScanCall(db: Db, c: NewScanCall): Promise<number> { throw new Error("not built: security.beginScanCall"); }
/** Ends a call: the call row, the scan's cost, the area's cost and the finding verdict in one `db.write`. */
export async function endScanCall(db: Db, e: EndScanCall): Promise<void> { throw new Error("not built: security.endScanCall"); }
/** Inserts call rows; joins the caller's transaction. */
export async function addCalls(db: Db, rows: (NewScanCall & { ok?: boolean; costUsd?: number | null; runId?: number | null; startedAt?: string; endedAt?: string | null })[]): Promise<void> { throw new Error("not built: security.addCalls"); }
/** Ends an area and updates the scan's `areas_done` and `estimate_usd` (computed in SQL) in one `db.write`. */
export async function finishArea(db: Db, a: { scanId: number; idx: number; failed: boolean }): Promise<void> { throw new Error("not built: security.finishArea"); }
/** Ends active scans (guarded, `RETURNING id`) and moves their `unverified` findings to `new` with the unchecked result. */
export async function finishScans(db: Db, rows: { id: number; state: ScanState; error?: string | null }[]): Promise<{ ended: number[] }> { throw new Error("not built: security.finishScans"); }
/** Resumes a capped scan: guarded update to the next state (a `CASE` in the statement), reopens unchecked findings; null when no row changed. */
export async function resumeScan(db: Db, r: { id: number; cap_usd: number | null }): Promise<{ state: ScanState } | null> { throw new Error("not built: security.resumeScan"); }
/** Reads stale work (3 statements, 1 RT) and, only when there is some, writes in one `db.write`: `finishScans`, `clearRounds`, `advanceFindings`. */
export async function reconcileSecurity(db: Db, o?: { repo?: string }): Promise<{ scans: number; findings: number }> { throw new Error("not built: security.reconcileSecurity"); }

// Scan tests (`security_scan_tests`) (package security).
import type { Db } from "../../db/index.ts";
import type { BuildingTest, FindingKey, ScanTestRow } from "./types.ts";

/** State, detail, path and source per finding. */
export async function loadScanTests(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, ScanTestRow>> { throw new Error("not built: security.loadScanTests"); }
/** Scan tests in state `building`. */
export async function listBuildingScanTests(db: Db): Promise<BuildingTest[]> { throw new Error("not built: security.listBuildingScanTests"); }
/** Replaces all columns. */
export async function saveScanTest(db: Db, r: ScanTestRow): Promise<void> { throw new Error("not built: security.saveScanTest"); }
/** Ends scan tests (guarded on `building`) and moves findings whose test ended `not-shown` with the not-shown note, in one `db.write`. */
export async function finishScanTests(db: Db, rows: { repo: string; number: number; state: string; detail: string | null }[]): Promise<number> { throw new Error("not built: security.finishScanTests"); }
/** Sets `task_id` and `retried = 1` (`updateFrom`). */
export async function retryScanTests(db: Db, rows: { repo: string; number: number; task_id: number }[]): Promise<number> { throw new Error("not built: security.retryScanTests"); }

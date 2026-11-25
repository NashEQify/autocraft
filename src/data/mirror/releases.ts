// Releases, stars and downloads (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { DownloadsView, ReleaseReading, ReleaseState } from "./types.ts";

/** Known assets, last read per repo and last star count; three statements in one wave, once per poll. */
export async function loadReleaseState(db: Db, repos: string[]): Promise<ReleaseState> {
  throw new Error("not built: mirror.loadReleaseState");
}

/** One `db.write` per flush of up to 10 repos. */
export async function saveReleaseReadings(db: Db, readings: ReleaseReading[], now: string): Promise<void> {
  throw new Error("not built: mirror.saveReleaseReadings");
}

/** `INSERT ... SELECT ... GROUP BY` with an additive conflict, then delete; no rows through JavaScript. */
export async function foldDeltas(db: Db, now: string): Promise<void> {
  throw new Error("not built: mirror.foldDeltas");
}

/** Read model for the downloads report. */
export async function loadDownloadsReport(db: Db, o: { repos: string[]; from: string; to: string; buckets: number }): Promise<DownloadsView> {
  throw new Error("not built: mirror.loadDownloadsReport");
}

/** App name per repo. */
export async function loadReleaseAppNames(db: Db, repos: string[]): Promise<Map<string, string>> {
  throw new Error("not built: mirror.loadReleaseAppNames");
}

/** One count per bucket per repo. */
export async function countItemEvents(db: Db, o: { repos: string[]; kind: "pr" | "issue"; col: "created_at" | "closed_at" | "merged_at"; buckets: [string, string][] }): Promise<Map<string, number[]>> {
  throw new Error("not built: mirror.countItemEvents");
}

// Sync bookkeeping: `sync_state`, runs, requests and repo failures (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { RefKey, RepoErrorRow, RepoFailure, SyncRequestRow, SyncRunRow, SyncState } from "./types.ts";

/** The one `sync_state` row. */
export async function loadSyncState(db: Db): Promise<SyncState> {
  throw new Error("not built: mirror.loadSyncState");
}

/** Upserts the named columns only. */
export async function saveSyncState(db: Db, patch: Partial<SyncState>): Promise<void> {
  throw new Error("not built: mirror.saveSyncState");
}

/** Compare-and-set, forward only; false when the stored value is not older. */
export async function advanceOrgHighWater(db: Db, t: string): Promise<boolean> {
  throw new Error("not built: mirror.advanceOrgHighWater");
}

/** Inserts a run, prunes runs older than two days and returns the id; one `db.write`. */
export async function startSyncRun(db: Db, startedAt: string): Promise<number> {
  throw new Error("not built: mirror.startSyncRun");
}

/** Closes a run. */
export async function finishSyncRun(db: Db, id: number, r: { endedAt: string; mode?: string; items?: number; error?: string | null }): Promise<void> {
  throw new Error("not built: mirror.finishSyncRun");
}

/** Recent runs, newest first. */
export async function loadSyncRuns(db: Db, limit: number): Promise<SyncRunRow[]> {
  throw new Error("not built: mirror.loadSyncRuns");
}

/** End time of the last run without an error. */
export async function loadLastSyncEnd(db: Db): Promise<string | null> {
  throw new Error("not built: mirror.loadLastSyncEnd");
}

/** Insert, `DO NOTHING` on the ref. */
export async function queueSyncRequests(db: Db, rows: { repo: string; number: number; requestedAt: string }[]): Promise<void> {
  throw new Error("not built: mirror.queueSyncRequests");
}

/** Oldest first. */
export async function loadSyncRequests(db: Db, limit: number): Promise<SyncRequestRow[]> {
  throw new Error("not built: mirror.loadSyncRequests");
}

/** Deletes rows still at that request time. */
export async function removeSyncRequests(db: Db, rows: { repo: string; number: number; requestedAt: string }[]): Promise<void> {
  throw new Error("not built: mirror.removeSyncRequests");
}

/** Whether any request is queued. */
export async function hasSyncRequests(db: Db): Promise<boolean> {
  throw new Error("not built: mirror.hasSyncRequests");
}

/** Returns the refs whose last read started before `after` and queues a request for each without one. */
export async function requestReadsAfter(db: Db, wants: { ref: RefKey; after: string }[], now: string): Promise<RefKey[]> {
  throw new Error("not built: mirror.requestReadsAfter");
}

/** Upsert keeping `since` while the kind is unchanged. */
export async function recordRepoFailures(db: Db, rows: RepoFailure[]): Promise<void> {
  throw new Error("not built: mirror.recordRepoFailures");
}

/** Deletes failure rows. */
export async function clearRepoFailures(db: Db, repos: string[], o?: { kinds?: string[]; before?: string }): Promise<void> {
  throw new Error("not built: mirror.clearRepoFailures");
}

/** Errors of tracked repos. */
export async function loadRepoErrors(db: Db): Promise<RepoErrorRow[]> {
  throw new Error("not built: mirror.loadRepoErrors");
}

/** Sync time of each item's last read. */
export async function loadItemReads(db: Db, keys: import("../keys.ts").KeySource): Promise<Map<RefKey, string>> {
  throw new Error("not built: mirror.loadItemReads");
}

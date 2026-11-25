// Repo rows and their sync marks (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { RefKey, RepoMeta, RepoRow, SyncPlan } from "./types.ts";

/** Repo rows by name. A scoped handle shows tracked repos only; `all` reads every repo. */
export async function loadRepos(db: Db, o?: { names?: string[]; all?: boolean }): Promise<Map<string, RepoRow>> {
  throw new Error("not built: mirror.loadRepos");
}

/** Repo names (visible-repo lists, the public set). */
export async function loadRepoNames(db: Db, o?: { names?: string[]; all?: boolean }): Promise<string[]> {
  throw new Error("not built: mirror.loadRepoNames");
}

/** Upserts the repo list and returns the names written; the owner guard stays in the statement, so refused names are the input minus the result. Also deletes the `not-found` error rows of the written names. */
export async function saveRepoList(db: Db, rows: RepoMeta[]): Promise<string[]> {
  throw new Error("not built: mirror.saveRepoList");
}

/** Inserts the repo when absent. */
export async function ensureRepo(db: Db, r: { name: string; owner: string }): Promise<void> {
  throw new Error("not built: mirror.ensureRepo");
}

/** Sets `high_water`, `synced_at` and `reconciled_at` to null. */
export async function resetRepoSync(db: Db, names: string[]): Promise<void> {
  throw new Error("not built: mirror.resetRepoSync");
}

/** Batched update; the high water only moves forward. */
export async function markReposRead(db: Db, rows: { name: string; syncedAt: string; highWater?: string | null }[]): Promise<void> {
  throw new Error("not built: mirror.markReposRead");
}

/** Batched update that only moves the high water forward. */
export async function advanceRepoHighWater(db: Db, rows: { name: string; t: string }[]): Promise<void> {
  throw new Error("not built: mirror.advanceRepoHighWater");
}

/** Sets `synced_at` for repos with a high water and no `sync_repo_errors` row. */
export async function markReposSyncedByError(db: Db, names: string[], at: string): Promise<void> {
  throw new Error("not built: mirror.markReposSyncedByError");
}

/** Batched update of the reconcile time. */
export async function markReposReconciled(db: Db, rows: { name: string; at: string }[]): Promise<void> {
  throw new Error("not built: mirror.markReposReconciled");
}

/** Repos, synced and broken sets and the sync state in one `together` wave. */
export async function loadSyncPlan(db: Db): Promise<SyncPlan> {
  throw new Error("not built: mirror.loadSyncPlan");
}

/** Deletes the repo's comments and items and resets its sync marks. */
export async function purgeRepoMirror(db: Db, name: string): Promise<{ comments: number; items: number }> {
  throw new Error("not built: mirror.purgeRepoMirror");
}

/** Item count per repo. */
export async function countItemsByRepo(db: Db, repos?: string[]): Promise<Map<string, number>> {
  throw new Error("not built: mirror.countItemsByRepo");
}

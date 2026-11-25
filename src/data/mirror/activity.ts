// Item trace data: events, files, commits (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ActivityAttempt, ActivityRead, ActivityRow, ActivityStats, CommitRow, FileRow, ItemDetail, ItemDetailPart, RefKey } from "./types.ts";

/** Tracked items whose activity read is due. */
export async function listActivityDue(db: Db, f: { since: string; now: string; limit: number }): Promise<{ repo: string; number: number }[]> {
  throw new Error("not built: mirror.listActivityDue");
}

/** Batched upserts of events, files, commits and `activity_sync` in one `db.write`. */
export async function saveActivity(db: Db, o: { reads: ActivityRead[]; attempts: ActivityAttempt[] }): Promise<void> {
  throw new Error("not built: mirror.saveActivity");
}

/** Events ordered by id. */
export async function loadActivity(db: Db, keys: KeySource, o?: { kinds?: string[] }): Promise<Map<RefKey, ActivityRow[]>> {
  throw new Error("not built: mirror.loadActivity");
}

/** Commits of each PR. */
export async function loadCommits(db: Db, keys: KeySource): Promise<Map<RefKey, CommitRow[]>> {
  throw new Error("not built: mirror.loadCommits");
}

/** Files at the item's current head. */
export async function loadFiles(db: Db, keys: KeySource): Promise<Map<RefKey, FileRow[]>> {
  throw new Error("not built: mirror.loadFiles");
}

/** Counts and newest times for item page and trace summaries. */
export async function loadActivityStats(db: Db, keys: KeySource): Promise<Map<RefKey, ActivityStats>> {
  throw new Error("not built: mirror.loadActivityStats");
}

/** Item, comments, activity, commits, files, checks and read time in one `together` wave. */
export async function loadItemDetail(db: Db, ref: RefKey, parts: ItemDetailPart[]): Promise<ItemDetail> {
  throw new Error("not built: mirror.loadItemDetail");
}

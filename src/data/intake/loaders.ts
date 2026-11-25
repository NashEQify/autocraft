// Loaders and read models (M15 intake part).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { HeldAuthorRow, HeldRow, HiddenRepos, HoldCounts, HoldInfo, HoldReason, HoldStatus, OutsideAuthorRow, OutsideState, RefKey } from "./types.ts";

/** Hold of each item; `limit` comes from the settings snapshot, so there is no limits read. */
export async function loadHolds(db: Db, keys: KeySource): Promise<Map<RefKey, HoldInfo>> {
  throw new Error("not built: intake.loadHolds");
}

/** Hold row and release row per item (item page, list rows); one statement with two subselects. */
export async function loadHoldStatus(db: Db, keys: KeySource): Promise<Map<RefKey, HoldStatus>> {
  throw new Error("not built: intake.loadHoldStatus");
}

/** The held list; titles and created time through `mirror.loadShown`. */
export async function listHeldByAuthor(db: Db, filter: { author: string; hidden: HiddenRepos; limit: number }): Promise<HeldRow[]> {
  throw new Error("not built: intake.listHeldByAuthor");
}

/** Per author: count, PRs, oldest item and surge flag. */
export async function listHeldAuthors(db: Db, filter: { hidden: HiddenRepos }): Promise<HeldAuthorRow[]> {
  throw new Error("not built: intake.listHeldAuthors");
}

/** Held counts. */
export async function countHolds(db: Db, filter: { hidden?: HiddenRepos; reason?: HoldReason }): Promise<HoldCounts> {
  throw new Error("not built: intake.countHolds");
}

/** Counts plus the breaker from `control.loadTrip` in the same wave. */
export async function loadOutsideState(db: Db, hidden: HiddenRepos): Promise<OutsideState> {
  throw new Error("not built: intake.loadOutsideState");
}

/** Operators, maintainers and own logins, lower case; composes `access.loginsWithRole` and `access.loadOwnLogins` in one `together`. */
export async function loadInsiders(db: Db): Promise<Set<string>> {
  throw new Error("not built: intake.loadInsiders");
}

/** The refs among the rows whose author is outside. */
export async function loadOutsideFlags(db: Db, rows: (OutsideAuthorRow & { repo: string; number: number })[]): Promise<Set<RefKey>> {
  throw new Error("not built: intake.loadOutsideFlags");
}

// Circuit breakers (M06 control-b). The pure rules stay in `src/core/push-outcome.ts`.
import type { Db } from "../../db/index.ts";
import type { TripRow } from "./types.ts";

/** Active trips by default. */
export async function loadTrips(db: Db, f?: { active?: boolean; keys?: string[] }): Promise<Map<string, TripRow>> {
  throw new Error("not built: control.loadTrips");
}

/** One-key wrapper. */
export async function loadTrip(db: Db, key: string): Promise<TripRow | undefined> {
  throw new Error("not built: control.loadTrip");
}

/** `cleared_at` per key (empty text when never cleared). */
export async function loadBreakerSince(db: Db, keys: string[]): Promise<Map<string, string>> {
  throw new Error("not built: control.loadBreakerSince");
}

/** Compare-and-set (`ON CONFLICT ... WHERE active = 0 RETURNING`); returns the keys that tripped and writes one `stage-trip` audit row per key; joins the caller's transaction. */
export async function tripStage(db: Db, rows: { key: string; reason: string; evidence: string[]; at: string }[]): Promise<string[]> {
  throw new Error("not built: control.tripStage");
}

/** Clears active trips and audits each. */
export async function resumeTrips(db: Db, keys: string[], by: string): Promise<{ key: string; reason: string }[]> {
  throw new Error("not built: control.resumeTrips");
}

/** Single-key wrapper; throws `TripError` with today's two messages after one read when nothing resumed. */
export async function resumeStage(db: Db, key: string, by: string): Promise<void> {
  throw new Error("not built: control.resumeStage");
}

/** Unchanged: a callback `canWrite`. */
export async function mayResumeTrip(db: Db, user: { canWrite(repo: string): Promise<boolean> }, key: string): Promise<boolean> {
  throw new Error("not built: control.mayResumeTrip");
}

/** Trips `merge:<repo>` for rows merged after the key's `cleared_at`. */
export async function tripMergeBreakers(db: Db, rows: { repo: string; number: number; mergedAt: string; reason: string; evidence: string[] }[], at?: string): Promise<string[]> {
  throw new Error("not built: control.tripMergeBreakers");
}

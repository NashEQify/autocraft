// Settings reads. While a planner pass runs, they come from one reading of the table taken at its start (withSettingsSnapshot),
// so a pass reads the table once instead of once per key; outside a pass every read goes to the database.
import type { DatabaseSync } from "node:sqlite";
import { prep } from "./sql-cache.ts";

const snapshots = new WeakMap<DatabaseSync, Map<string, string>>();

/**
 * Runs `fn` with the settings reads on `db` served from one reading of the table. Synchronous only, so nothing on this
 * connection writes between reads except `fn` itself, through writeSetting/deleteSetting, which keep the snapshot current.
 * Other connections (the runner thread, the dashboard) keep writing: the pass sees settings as they were at its start, and
 * applyProposals re-checks limits and blocks with fresh reads.
 */
export function withSettingsSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (snapshots.has(db)) return fn();
  const rows = prep(db, "SELECT key, value FROM main.settings").all() as { key: string; value: string }[];
  snapshots.set(db, new Map(rows.map((r) => [r.key, r.value])));
  try { return fn(); } finally { snapshots.delete(db); }
}

/** Reads the table again for the snapshot of a pass on `db` (none: nothing), so a pass sees the settings of a read transaction it opens later. */
export function rereadSettingsSnapshot(db: DatabaseSync): void {
  if (!snapshots.has(db)) return;
  const rows = prep(db, "SELECT key, value FROM main.settings").all() as { key: string; value: string }[];
  snapshots.set(db, new Map(rows.map((r) => [r.key, r.value])));
}

/** The stored value, undefined when the key has no row. */
export function setting(db: DatabaseSync, key: string): string | undefined {
  const snap = snapshots.get(db);
  if (snap) return snap.get(key);
  return (prep(db, "SELECT value FROM main.settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

/** The stored values of `keys` in one read; keys without a row are left out. */
export function settings(db: DatabaseSync, keys: string[]): Map<string, string> {
  const snap = snapshots.get(db);
  if (snap) return new Map(keys.flatMap((k) => { const v = snap.get(k); return v === undefined ? [] : [[k, v] as const]; }));
  const rows = prep(db, "SELECT key, value FROM main.settings WHERE key IN (SELECT value FROM json_each(?))").all(JSON.stringify(keys)) as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** True when the key has a row. */
export function hasSetting(db: DatabaseSync, key: string): boolean {
  const snap = snapshots.get(db);
  if (snap) return snap.has(key);
  return !!prep(db, "SELECT 1 FROM main.settings WHERE key = ?").get(key);
}

export function writeSetting(db: DatabaseSync, key: string, value: string): void {
  prep(db, "INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  snapshots.get(db)?.set(key, value);
}

export function deleteSetting(db: DatabaseSync, key: string): void {
  prep(db, "DELETE FROM main.settings WHERE key = ?").run(key);
  snapshots.get(db)?.delete(key);
}

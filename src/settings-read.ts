// Settings reads. While a planner pass runs, they come from one reading of the table taken at its start (withSettingsSnapshot),
// so a pass reads the table once instead of once per key; outside a pass every read goes to the database.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./db/index.ts";

/** The snapshot of the pass running in the current async context, for the handle it was read on. */
const pass = new AsyncLocalStorage<{ db: Db; map: Map<string, string> }>();

const snapshotOf = (db: Db): Map<string, string> | undefined => {
  const s = pass.getStore();
  return s?.db === db ? s.map : undefined;
};

/**
 * Runs `fn` with the settings reads on `db` served from one reading of the table. The snapshot belongs to the async context
 * of `fn`: work that runs meanwhile outside it (other requests, timers) reads the table. Inside, writeSetting/deleteSetting
 * keep it current. Other contexts and connections (the runner thread, the dashboard) keep writing: the pass sees settings as
 * they were at its start, and applyProposals re-checks limits and blocks with fresh reads.
 */
export async function withSettingsSnapshot<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (snapshotOf(db)) return await fn();
  const rows = await db.prepare("SELECT key, value FROM main.settings").all() as { key: string; value: string }[];
  return await pass.run({ db, map: new Map(rows.map((r) => [r.key, r.value])) }, fn);
}

/** Reads the table again for the snapshot of a pass on `db` (none: nothing), so a pass sees the settings of a read transaction it opens later. */
export async function rereadSettingsSnapshot(db: Db): Promise<void> {
  const s = pass.getStore();
  if (s?.db !== db) return;
  const rows = await db.prepare("SELECT key, value FROM main.settings").all() as { key: string; value: string }[];
  s.map = new Map(rows.map((r) => [r.key, r.value]));
}

/** The stored value, undefined when the key has no row. */
export async function setting(db: Db, key: string): Promise<string | undefined> {
  const snap = snapshotOf(db);
  if (snap) return snap.get(key);
  return (await db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

/** The stored values of `keys` in one read; keys without a row are left out. */
export async function settings(db: Db, keys: string[]): Promise<Map<string, string>> {
  const snap = snapshotOf(db);
  if (snap) return new Map(keys.flatMap((k) => { const v = snap.get(k); return v === undefined ? [] : [[k, v] as const]; }));
  const rows = await db.prepare("SELECT key, value FROM main.settings WHERE key IN (SELECT value FROM json_each(?))").all(JSON.stringify(keys)) as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** True when the key has a row. */
export async function hasSetting(db: Db, key: string): Promise<boolean> {
  const snap = snapshotOf(db);
  if (snap) return snap.has(key);
  return !!await db.prepare("SELECT 1 FROM main.settings WHERE key = ?").get(key);
}

export async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  snapshotOf(db)?.set(key, value);
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.prepare("DELETE FROM main.settings WHERE key = ?").run(key);
  snapshotOf(db)?.delete(key);
}

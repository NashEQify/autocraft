// Opens database handles. The only module that loads the kysely and pg packages, with dynamic imports: the build worker
// runs src/ without node_modules and never opens the app database (test/no-package-imports.test.ts).
import type { DatabaseSync } from "node:sqlite";
import { connect, dbPath } from "../db.ts";
import { envVar } from "../env.ts";
import { Handle } from "./handle.ts";
import type { Db } from "./index.ts";
import { bindSql } from "./sql.ts";
import { sqliteEngine } from "./sqlite.ts";

let kysely: Promise<typeof import("kysely")> | undefined;

function loadKysely(): Promise<typeof import("kysely")> {
  return (kysely ??= import("kysely").then((k) => {
    bindSql(k.sql);
    return k;
  }));
}

/** The pg module, for the Postgres engine. */
export async function loadPg(): Promise<typeof import("pg").default> {
  return (await import("pg")).default;
}

const bySync = new WeakMap<DatabaseSync, Promise<Db>>();

/** The handle over a connection from `connect()`, one per connection. Closing it closes the connection. */
export function dbFor(sync: DatabaseSync): Promise<Db> {
  let h = bySync.get(sync);
  if (!h) bySync.set(sync, (h = loadKysely().then((k) => new Handle((ctx) => sqliteEngine(k, sync, ctx)))));
  return h;
}

/** A handle of its own on the SQLite database at `path`, schema brought up to date (see `connect()`). */
export async function connectDb(path: string = dbPath(), opts: { busyTimeoutMs?: number } = {}): Promise<Db> {
  return dbFor(connect(path, opts));
}

let proc: Promise<{ db: Db; close: () => Promise<void> }> | undefined;

/**
 * The process's handle on the configured database. It is shared by everything in the process, so its `close()` does
 * nothing: a module that closes the handle it was given must not end it for the job or server still using it. Only
 * `closeDb()` closes it.
 */
export async function openDb(): Promise<Db> {
  if (envVar("DB_URL") !== undefined) throw new Error("AUTOCRAFT_DB_URL is set, but the Postgres backend is not available yet");
  proc ??= connectDb().then((db) => {
    const close = db.close.bind(db);
    db.close = async () => {};
    return { db, close };
  });
  return (await proc).db;
}

/** Closes the process's handle (CLI exit). */
export async function closeDb(): Promise<void> {
  const p = proc;
  proc = undefined;
  if (p) await (await p).close();
}

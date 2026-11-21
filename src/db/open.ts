// Opens database handles. The only module that loads the kysely and pg packages, with dynamic imports: the build worker
// runs src/ without node_modules and never opens the app database (test/no-package-imports.test.ts).
import type { DatabaseSync } from "node:sqlite";
import { connect, dbPath } from "../db.ts";
import { envVar } from "../env.ts";
import { Handle } from "./handle.ts";
import type { Db, DbRole } from "./index.ts";
import { postgresEngine } from "./postgres.ts";
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

export const isPgUrl = (target: string): boolean => /^postgres(ql)?:\/\//.test(target);

/**
 * The configured database: `AUTOCRAFT_DB_URL` (Postgres) or else `AUTOCRAFT_DB` (a SQLite file, default under the home).
 * Both set to different values is refused: one of them would be ignored without a word.
 */
export function dbTarget(env: NodeJS.ProcessEnv = process.env): string {
  const url = envVar("DB_URL", env);
  const path = envVar("DB", env);
  if (url !== undefined && path !== undefined && url !== path) throw new Error("AUTOCRAFT_DB_URL and AUTOCRAFT_DB are both set and differ: set only one");
  if (url !== undefined && !isPgUrl(url)) throw new Error("AUTOCRAFT_DB_URL must be a postgres:// or postgresql:// URL");
  return url ?? dbPath();
}

let role: DbRole = "cli";

/** Sets the role of this process's handles (pool size on Postgres). Called by long-running commands before they open one. */
export function setDbRole(r: DbRole): void {
  role = r;
}

export interface ConnectOptions {
  /** How long a write waits for the write lock before failing with a lock timeout. */
  busyTimeoutMs?: number;
  /** The handle's use, for its pool size on Postgres. Defaults to the process's role (`setDbRole`). */
  role?: DbRole;
  /** Postgres: bring the schema and triggers up to date first (default). False opens the database as it is. */
  migrate?: boolean;
}

/**
 * A handle of its own on `target`: a SQLite file, schema brought up to date (see `connect()`), or a Postgres URL. A
 * Postgres database must already have its schema.
 */
export async function connectDb(target: string = dbTarget(), opts: ConnectOptions = {}): Promise<Db> {
  if (!isPgUrl(target)) return dbFor(connect(target, opts));
  const [k, pg] = await Promise.all([loadKysely(), loadPg()]);
  return new Handle((ctx) => postgresEngine(k, pg, target, { role: opts.role ?? role, busyTimeoutMs: opts.busyTimeoutMs }, ctx));
}

let proc: Promise<Db> | undefined;

/** The process's handle on the configured database. */
export function openDb(): Promise<Db> {
  return (proc ??= connectDb());
}

/** Closes the process's handle (CLI exit). */
export async function closeDb(): Promise<void> {
  const p = proc;
  proc = undefined;
  if (p) await (await p).close();
}

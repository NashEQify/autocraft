// The handle's query surface, for the data modules (src/data/**) and infra (src/db/**) only. Feature code holds a `Db`.
import type { Compilable, Kysely } from "kysely";
import type { DatabaseSync } from "node:sqlite";
import type { DB, Db, QueryOpts, RunResult, Statement } from "./index.ts";

export type { QueryOpts };

export interface QueryDb extends Db {
  /** Kysely, routed to the transaction open in the current async context. Read it at each use. */
  readonly k: Kysely<DB>;
  /** Runs a Kysely query: its first row. Inside `together` a SELECT joins the current wave. */
  get<O>(q: Compilable<O>, o?: QueryOpts): Promise<O | undefined>;
  /** Runs a Kysely query: all rows. Inside `together` a SELECT joins the current wave. */
  all<O>(q: Compilable<O>, o?: QueryOpts): Promise<O[]>;
  /** Runs a Kysely write. */
  run(q: Compilable<unknown>): Promise<RunResult>;
  /** Runs several statements with no parameters (schema scripts, PRAGMAs). */
  script(text: string): Promise<void>;
  /** See `Db.attempt`: a statement error inside `fn` leaves the open transaction usable. */
  attempt<T>(fn: () => Promise<T>): Promise<T>;
  /** See `Db.scope`. */
  scope(): Promise<void>;
  /** Transitional raw SQL in the SQLite dialect, with `?` and `:name` parameters. It never joins a `together` wave. */
  prepare(text: string): Statement;
  /** The underlying SQLite connection, for code that cannot await yet. Absent on Postgres. */
  readonly sync?: DatabaseSync;
}

/** The query surface of `db`. Every handle implements it; the type keeps queries out of feature code. */
export function queryDb(db: Db): QueryDb {
  return db as QueryDb;
}

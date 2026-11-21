// The SQLite engine: node:sqlite's DatabaseSync behind Kysely's SqliteDialect. One connection per handle; Kysely's
// connection mutex serializes the async callers on it, and a transaction holds the mutex until it ends.
import type * as K from "kysely";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Args, Engine, EngineContext, Op, Tx } from "./handle.ts";
import { callSite, siteError } from "./handle.ts";
import type { DB, Row, RunResult } from "./index.ts";

/** Prepared statements kept per connection: preparing the same text again costs more than running it. */
const CACHE_SIZE = 1000;

const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }));

/**
 * The statement layer over one DatabaseSync: an LRU of prepared statements, plain-object rows, numeric run results and
 * the query events. Both Kysely (through `prepare`, the shape SqliteDialect expects) and `db.prepare` run through it.
 */
export class SqliteAdapter {
  readonly #cache = new Map<string, { stmt: StatementSync; reader?: boolean }>();
  readonly sync: DatabaseSync;
  readonly #ctx: EngineContext;

  constructor(sync: DatabaseSync, ctx: EngineContext) {
    this.sync = sync;
    this.#ctx = ctx;
  }

  #entry(text: string): { stmt: StatementSync; reader?: boolean } {
    let e = this.#cache.get(text);
    if (e) {
      this.#cache.delete(text);
    } else {
      e = { stmt: this.sync.prepare(text) };
      if (this.#cache.size >= CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
    }
    this.#cache.set(text, e);
    return e;
  }

  #timed<T>(text: string, f: () => T, count: (r: T) => [rows: number, bytes: number]): T {
    if (!this.#ctx.observed()) return f();
    const t0 = performance.now();
    const r = f();
    const ms = performance.now() - t0;
    const [rows, bytes] = count(r);
    this.#ctx.emit({ kind: "query", sql: text, rows, bytes, ms, site: callSite(siteError()) });
    return r;
  }

  get(text: string, args: Args): Row | undefined {
    const stmt = this.#entry(text).stmt;
    return this.#timed(
      text,
      () => {
        const r = stmt.get(...(args as [])) as Row | undefined;
        return r && { ...r };
      },
      (r) => (r ? [1, Buffer.byteLength(JSON.stringify(r))] : [0, 0]),
    );
  }

  all(text: string, args: Args): Row[] {
    const stmt = this.#entry(text).stmt;
    return this.#timed(text, () => plain(stmt.all(...(args as []))), (r) => [r.length, Buffer.byteLength(JSON.stringify(r))]);
  }

  run(text: string, args: Args): RunResult {
    const stmt = this.#entry(text).stmt;
    return this.#timed(
      text,
      () => {
        const r = stmt.run(...(args as []));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      () => [0, 0],
    );
  }

  exec(text: string): void {
    this.#timed(text, () => this.sync.exec(text), () => [0, 0]);
  }

  /** Kysely's SqliteDatabase. */
  prepare(text: string): { reader: boolean; all(p: readonly unknown[]): unknown[]; run(p: readonly unknown[]): RunResult; iterate(p: readonly unknown[]): IterableIterator<unknown> } {
    const e = this.#entry(text);
    e.reader ??= e.stmt.columns().length > 0;
    return {
      reader: e.reader,
      all: (p) => this.all(text, p as Args),
      run: (p) => this.run(text, p as Args),
      iterate: (p) => this.all(text, p as Args)[Symbol.iterator](),
    };
  }

  close(): void {
    this.#cache.clear();
    if (this.sync.isOpen) this.sync.close();
  }
}

/** An engine over `sync`. `k` is the kysely module, loaded by src/db/open.ts. */
export function sqliteEngine(k: typeof K, sync: DatabaseSync, ctx: EngineContext): Engine {
  const adapter = new SqliteAdapter(sync, ctx);
  const raw = (text: string) => k.CompiledQuery.raw(text);

  class Driver extends k.SqliteDriver {
    // Write transactions take the write lock at BEGIN (IMMEDIATE), so a transaction never fails half-way on a lock it
    // could not upgrade to. A read snapshot is a deferred BEGIN.
    override async beginTransaction(conn: K.DatabaseConnection, settings?: K.TransactionSettings): Promise<void> {
      const tx = ctx.tx();
      if (tx) tx.conn = conn;
      if (settings?.accessMode === "read only") return void (await conn.executeQuery(raw("BEGIN")));
      const wait = tx?.lockTimeoutMs;
      if (wait === undefined) return void (await conn.executeQuery(raw("BEGIN IMMEDIATE")));
      const prev = (sync.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      sync.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(wait))}`);
      try {
        await conn.executeQuery(raw("BEGIN IMMEDIATE"));
      } finally {
        sync.exec(`PRAGMA busy_timeout = ${prev}`);
      }
    }

    // SQLite rolls a transaction back by itself after some errors; a second ROLLBACK would hide the first error.
    override async rollbackTransaction(conn: K.DatabaseConnection): Promise<void> {
      if (sync.isTransaction) await conn.executeQuery(raw("ROLLBACK"));
    }
  }

  class Dialect extends k.SqliteDialect {
    override createDriver(): K.Driver {
      return new Driver({ database: adapter });
    }
  }

  const kysely = new k.Kysely<DB>({ dialect: new Dialect({ database: adapter }) });
  // Inside a transaction a statement runs at once on the connection the transaction holds; outside one it takes the
  // connection first, and so waits for an open transaction to end.
  const held = <T>(tx: Tx | undefined, f: () => T): Promise<T> => (tx ? (async () => f())() : kysely.getExecutor().provideConnection(async () => f()));

  return {
    dialect: "sqlite",
    kysely,
    sync,
    exec: (op: Op, text: string, args: Args, tx: Tx | undefined) => held(tx, () => adapter[op](text, args)),
    script: (text, tx) => held(tx, () => adapter.exec(text)),
    configure: (b, mode) => (mode === "read" ? b.setAccessMode("read only") : b),
    close: async () => {
      await kysely.destroy();
      adapter.close();
    },
  };
}

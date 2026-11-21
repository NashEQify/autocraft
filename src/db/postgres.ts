// The Postgres engine: Kysely's PostgresDialect on a pg.Pool. No session state: settings a transaction needs are SET LOCAL,
// locks are transaction-scoped advisory locks, statements are unnamed (no server-side prepared statements), no LISTEN.
// Values come back in node:sqlite's shapes (see `types`), so a query returns the same rows on both backends.
import type * as K from "kysely";
import type * as Pg from "pg";
import type { Args, Engine, EngineContext, Op, Tx } from "./handle.ts";
import { callSite, siteError, withoutInsertId } from "./handle.ts";
import type { DB, DbRole, Row } from "./index.ts";
import { bindParams, parseParams, rewriteForPostgres, rewriteScriptForPostgres, type ParsedParams } from "./params.ts";

/** Connections per process role: the database allows 100 direct connections, shared by every process of the instance. */
export const POOL_MAX: Record<DbRole, number> = { dashboard: 8, "dashboard-remote": 4, runner: 4, planner: 2, periodic: 2, cli: 1 };

/** Key of the one writer lock every write transaction takes, so writes run one at a time as on SQLite. */
const WRITER_LOCK = 0x61637772; // "acwr"

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/** Parsed statement texts kept per handle. */
const PARSE_CACHE = 1000;

export interface PgOptions {
  role: DbRole;
  /** How long a write transaction waits for the writer lock (and a statement for any lock). Default 30 s. */
  busyTimeoutMs?: number;
  /** Longest a statement may run; 0 for no limit. Default 120 s. */
  statementTimeoutMs?: number;
}

const LOCAL_HOSTS = new Set(["", "localhost", "[::1]"]);

/**
 * The connection string the pool uses. A remote host always gets TLS with certificate and host name checks
 * (sslmode=verify-full against the system CAs), whatever weaker mode the URL names, unless it says sslmode=disable.
 * Loopback hosts and Unix sockets keep the URL's own setting.
 */
export function pgConnectionString(url: string): string {
  const u = new URL(url);
  if (LOCAL_HOSTS.has(u.hostname) || u.hostname.startsWith("127.") || u.searchParams.get("sslmode") === "disable") return url;
  u.searchParams.set("sslmode", "verify-full");
  // libpq's "use the system CAs"; pg would read it as a file name. Node verifies against the system CAs by default.
  if (u.searchParams.get("sslrootcert") === "system") u.searchParams.delete("sslrootcert");
  return u.toString();
}

/** Parsers that give node:sqlite's value shapes: int8 and numeric as numbers, bool as 1/0, bytea as a plain Uint8Array. */
function typesFor(pg: typeof Pg.default): Pg.CustomTypesConfig {
  const { builtins, getTypeParser } = pg.types;
  const bytea = getTypeParser(builtins.BYTEA, "text") as (v: string) => Buffer;
  const parsers = new Map<number, (v: string) => unknown>([
    [builtins.INT8, Number],
    [builtins.NUMERIC, Number],
    [builtins.BOOL, (v) => (v === "t" ? 1 : 0)],
    [builtins.BYTEA, (v) => new Uint8Array(bytea(v))],
  ]);
  return {
    getTypeParser: ((oid: number, format?: "text" | "binary") => parsers.get(oid) ?? getTypeParser(oid, format as "text")) as Pg.CustomTypesConfig["getTypeParser"],
  };
}

/** Emits a query event for every round trip on `client` while someone observes. */
function observeClient(client: Pg.PoolClient, ctx: EngineContext): void {
  const query = client.query.bind(client) as (...a: unknown[]) => unknown;
  (client as { query: unknown }).query = (...a: unknown[]): unknown => {
    const text = a[0];
    if (!ctx.observed() || typeof text !== "string" || typeof a.at(-1) === "function") return query(...a);
    const site = callSite(siteError());
    const t0 = performance.now();
    return (query(...a) as Promise<Pg.QueryResult | Pg.QueryResult[]>).then((r) => {
      // A script with several statements answers with one result per statement.
      const rows = (Array.isArray(r) ? r : [r]).flatMap((x) => x.rows ?? []);
      ctx.emit({ kind: "query", sql: text, rows: rows.length, bytes: rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0, ms: performance.now() - t0, site });
      return r;
    });
  };
}

/** An engine on the Postgres database at `url`. `k` and `pg` are the modules src/db/open.ts loaded. */
export function postgresEngine(k: typeof K, pg: typeof Pg.default, url: string, opts: PgOptions, ctx: EngineContext): Engine {
  const pool = new pg.Pool({
    connectionString: pgConnectionString(url),
    max: POOL_MAX[opts.role],
    allowExitOnIdle: true,
    application_name: `autocraft-${opts.role}`,
    // A startup parameter of every connection, so it also bounds statements outside transactions; no SET is sent.
    statement_timeout: opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    types: typesFor(pg),
  });
  // An idle connection that fails (server restart, network) is dropped by the pool; without a listener it would crash the process.
  pool.on("error", (e) => console.warn(`db: idle Postgres connection failed: ${e.message}`));
  pool.on("connect", (client) => observeClient(client, ctx));
  const raw = (text: string, values?: unknown[]) => k.CompiledQuery.raw(text, values);
  const lockTimeout = (tx: Tx | undefined) => Math.max(1, Math.floor(tx?.lockTimeoutMs ?? opts.busyTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));

  class Driver extends k.PostgresDriver {
    // One round trip opens the transaction: BEGIN, its settings and, for a write, the writer lock. A write runs READ
    // COMMITTED under the one writer lock, so writes see each other's commits in order as on SQLite; a read is one
    // REPEATABLE READ snapshot that refuses writes.
    override async beginTransaction(conn: K.DatabaseConnection, settings: K.TransactionSettings): Promise<void> {
      const tx = ctx.tx();
      if (tx) tx.conn = conn;
      const text = settings.accessMode === "read only"
        ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        : `BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = ${lockTimeout(tx)}; SELECT pg_advisory_xact_lock(${WRITER_LOCK})`;
      try {
        await conn.executeQuery(raw(text));
      } catch (e) {
        // Kysely rolls back only a transaction that began; a failed lock wait leaves this one open on the connection.
        await super.rollbackTransaction(conn as Parameters<K.PostgresDriver["rollbackTransaction"]>[0]).catch(() => undefined);
        throw e;
      }
    }
  }

  class Dialect extends k.PostgresDialect {
    override createDriver(): K.Driver {
      return new Driver({ pool });
    }
  }

  const kysely = new k.Kysely<DB>({ dialect: new Dialect({ pool }) });
  const parsed = new Map<string, ParsedParams>();
  const parse = (text: string): ParsedParams => {
    let p = parsed.get(text);
    if (p) parsed.delete(text);
    else {
      p = parseParams(rewriteForPostgres(text));
      if (parsed.size >= PARSE_CACHE) parsed.delete(parsed.keys().next().value!);
    }
    parsed.set(text, p);
    return p;
  };
  // Inside a transaction a statement runs on the connection the transaction holds; outside one, on any pooled connection.
  const on = async <T>(tx: Tx | undefined, f: (conn: K.DatabaseConnection) => Promise<T>): Promise<T> => {
    if (!tx) return kysely.getExecutor().provideConnection(f);
    if (!tx.conn) throw new Error("db: transaction has no connection");
    return f(tx.conn);
  };

  return {
    dialect: "postgres",
    kysely,
    exec: async (op: Op, text: string, args: Args, tx: Tx | undefined) => {
      const { text: q, values } = bindParams(parse(text), args, (i) => `$${i + 1}`);
      const r = await on(tx, (conn) => conn.executeQuery<Row>(raw(q, values)));
      if (op === "get") return r.rows[0];
      if (op === "all") return [...r.rows];
      return withoutInsertId(Number(r.numAffectedRows ?? 0n));
    },
    script: async (text, tx) => void (await on(tx, (conn) => conn.executeQuery(raw(rewriteScriptForPostgres(text))))),
    configure: (b, mode) => (mode === "read" ? b.setIsolationLevel("repeatable read").setAccessMode("read only") : b.setIsolationLevel("read committed")),
    close: () => kysely.destroy(),
  };
}

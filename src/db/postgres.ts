// The Postgres engine: Kysely's PostgresDialect on a pg.Pool. No session state: settings a transaction needs are SET LOCAL,
// locks are transaction-scoped advisory locks, statements are unnamed (no server-side prepared statements). LISTEN runs
// only on a handle's one dedicated listening connection (pgListener), never on the pool.
// Values come back in node:sqlite's shapes (see `types`), so a query returns the same rows on both backends.
import type * as K from "kysely";
import type * as Pg from "pg";
import type { Args, Engine, EngineContext, Listener, Op, Tx } from "./handle.ts";
import { callSite, siteError, withoutInsertId } from "./handle.ts";
import type { DB, DbRole, Row } from "./index.ts";
import { bindParams, parseParams, rewriteForPostgres, rewriteScriptForPostgres, type ParsedParams } from "./params.ts";
import { plainSchema, SCOPED_SCHEMA } from "./scoped.ts";
import { fenceSql } from "./fence.ts";

/** Connections per process role: the database allows 100 direct connections, shared by every process of the instance. */
export const POOL_MAX: Record<DbRole, number> = { dashboard: 8, "dashboard-remote": 4, runner: 4, planner: 2, periodic: 2, cli: 1 };

/** Key of the one writer lock every write takes (a write transaction, or a write statement outside one), so writes run one at a time as on SQLite. */
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
  /** The app schema of a scoped handle (src/db/scoped.ts): its connections put the scoped views first on the search path. */
  scope?: string;
}

/** `url` with the startup option that puts the scoped views before the tables of `schema`, after any options it has. */
function scopedUrl(url: string, schema: string): string {
  const u = new URL(url);
  const own = u.searchParams.get("options");
  u.searchParams.set("options", `${own ? `${own} ` : ""}-c search_path=${SCOPED_SCHEMA},${plainSchema(schema)}`);
  return u.toString();
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

const STATEMENT_HEAD = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(\w+)/;

/** Whether a statement writes rows: INSERT, UPDATE, DELETE or MERGE, also inside WITH (a WITH that only mentions one of the words is taken as a write too). */
export function writesRows(text: string): boolean {
  const head = STATEMENT_HEAD.exec(text)?.[1]?.toLowerCase();
  if (head === "with") return /\b(?:insert|update|delete|merge)\b/i.test(text);
  return head === "insert" || head === "update" || head === "delete" || head === "merge";
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

/**
 * Kysely's counterpart of the `main.`/`temp.` rewrite raw statements get (src/db/params.ts rewriteForPostgres): table
 * names `main.x` and `temp.x` (typed in src/db/types.ts for code that reads past the scoped views or writes a shadowed
 * table) lose the schema, or with `mainSchema` (a scoped handle) `main.x` names `<mainSchema>.x`, past the views.
 */
function schemaPlugin(k: typeof K, mainSchema: string | undefined): K.KyselyPlugin {
  class Transformer extends k.OperationNodeTransformer {
    protected override transformSchemableIdentifier(node: K.SchemableIdentifierNode, queryId?: K.QueryId): K.SchemableIdentifierNode {
      const t = super.transformSchemableIdentifier(node, queryId);
      const schema = t.schema?.name.toLowerCase();
      if (schema !== "main" && schema !== "temp") return t;
      return { ...t, schema: schema === "main" && mainSchema ? k.IdentifierNode.create(mainSchema) : undefined };
    }
  }
  const transformer = new Transformer();
  return {
    transformQuery: (args) => transformer.transformNode(args.node, args.queryId),
    transformResult: async (args) => args.result,
  };
}

/** An engine on the Postgres database at `url`. `k` and `pg` are the modules src/db/open.ts loaded. */
export function postgresEngine(k: typeof K, pg: typeof Pg.default, url: string, opts: PgOptions, ctx: EngineContext): Engine {
  const pool = new pg.Pool({
    connectionString: pgConnectionString(opts.scope ? scopedUrl(url, opts.scope) : url),
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
  // A fenced process (src/db/fence.ts) checks its epoch after the writer lock: the check sees every write committed before it.
  const beginWrite = (tx: Tx | undefined) => `BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = ${lockTimeout(tx)}; SELECT pg_advisory_xact_lock(${WRITER_LOCK})${fenceSql()}`;
  /** Connections between their BEGIN and its COMMIT or ROLLBACK. */
  const inTransaction = new WeakSet<K.DatabaseConnection>();

  /**
   * Every statement on `conn` passes here. Outside a transaction, a write runs as a transaction of its own under the writer
   * lock, so it waits for an open write transaction as on SQLite, where a count-then-write inside db.write would otherwise
   * race with it. Reads outside a transaction take no lock.
   */
  const lockWrites = async (conn: K.DatabaseConnection): Promise<void> => {
    const run = conn.executeQuery.bind(conn);
    conn.executeQuery = async <R>(q: K.CompiledQuery): Promise<K.QueryResult<R>> => {
      if (inTransaction.has(conn) || !writesRows(q.sql)) return await run<R>(q);
      try {
        await run(raw(beginWrite(undefined)));
        const r = await run<R>(q);
        await run(raw("COMMIT"));
        return r;
      } catch (e) {
        await run(raw("ROLLBACK")).catch(() => undefined);
        throw e;
      }
    };
  };

  class Driver extends k.PostgresDriver {
    // One round trip opens the transaction: BEGIN, its settings and, for a write, the writer lock. A write runs READ
    // COMMITTED under the one writer lock, so writes see each other's commits in order as on SQLite; a read is one
    // REPEATABLE READ snapshot that refuses writes.
    override async beginTransaction(conn: K.DatabaseConnection, settings: K.TransactionSettings): Promise<void> {
      const tx = ctx.tx();
      if (tx) tx.conn = conn;
      inTransaction.add(conn);
      const text = settings.accessMode === "read only" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : beginWrite(tx);
      try {
        await conn.executeQuery(raw(text));
      } catch (e) {
        // Kysely rolls back only a transaction that began; a failed lock wait leaves this one open on the connection.
        await super.rollbackTransaction(conn as Parameters<K.PostgresDriver["rollbackTransaction"]>[0]).catch(() => undefined);
        inTransaction.delete(conn);
        throw e;
      }
    }

    override async commitTransaction(conn: K.DatabaseConnection): Promise<void> {
      try { await super.commitTransaction(conn); } finally { inTransaction.delete(conn); }
    }

    override async rollbackTransaction(conn: K.DatabaseConnection): Promise<void> {
      try { await super.rollbackTransaction(conn as Parameters<K.PostgresDriver["rollbackTransaction"]>[0]); } finally { inTransaction.delete(conn); }
    }
  }

  class Dialect extends k.PostgresDialect {
    override createDriver(): K.Driver {
      return new Driver({ pool, onCreateConnection: lockWrites });
    }
  }

  const kysely = new k.Kysely<DB>({ dialect: new Dialect({ pool }), plugins: [schemaPlugin(k, opts.scope)] });
  const parsed = new Map<string, ParsedParams>();
  const parse = (text: string): ParsedParams => {
    let p = parsed.get(text);
    if (p) parsed.delete(text);
    else {
      p = parseParams(rewriteForPostgres(text, opts.scope));
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

  const engine: Engine = {
    dialect: "postgres",
    kysely,
    listener: () => pgListener(pg, url),
    exec: async (op: Op, text: string, args: Args, tx: Tx | undefined) => {
      const { text: q, values } = bindParams(parse(text), args, (i) => `$${i + 1}`);
      const r = await on(tx, (conn) => conn.executeQuery<Row>(raw(q, values)));
      if (op === "get") return r.rows[0];
      if (op === "all") return [...r.rows];
      return withoutInsertId(Number(r.numAffectedRows ?? 0n));
    },
    script: async (text, tx) => void (await on(tx, (conn) => conn.executeQuery(raw(rewriteScriptForPostgres(text, opts.scope))))),
    configure: (b, mode) => (mode === "read" ? b.setIsolationLevel("repeatable read").setAccessMode("read only") : b.setIsolationLevel("read committed")),
    // A pool of its own: the search path is a startup parameter of each connection, never a session SET.
    scope: async () => {
      if (opts.scope) return engine;
      const r = await on(undefined, (conn) => conn.executeQuery<{ s: string }>(raw("SELECT current_schema() AS s")));
      return postgresEngine(k, pg, url, { ...opts, scope: r.rows[0]!.s }, ctx);
    },
    close: () => kysely.destroy(),
  };
  return engine;
}

/** Channel names a handle may listen on: plain lower-case identifiers, so LISTEN needs no quoting. */
const CHANNEL = /^[a-z][a-z0-9_]{0,62}$/;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const LISTEN_CONNECT_MS = 5_000;

/**
 * LISTEN on one connection of its own, outside the pool, opened in the background at the first listen (5 s connect
 * limit). A lost connection is opened again (1 s, then backing off to 30 s) while anything listens; after a reconnect
 * every listener is called with null, since notifications sent meanwhile are lost. `listening(channel)` says whether the
 * channel's LISTEN is in effect now; callers poll at their short interval while it is not. The connection must be a
 * direct or session-mode one: a transaction-mode pooler drops LISTEN between statements.
 */
export function pgListener(pg: typeof Pg.default, url: string): Listener {
  const fns = new Map<string, Set<(payload: string | null) => void>>();
  /** Channels whose LISTEN went through on `client`. */
  const active = new Set<string>();
  let client: Pg.Client | null = null;
  let connecting: Promise<Pg.Client | null> | null = null;
  let closed = false, failures = 0, warned = false;
  let retry: NodeJS.Timeout | undefined;

  // The connection keeps the process alive only while something listens, so a process can end once its waits are over.
  const hold = (): void => {
    const c = client as (Pg.Client & { ref?: () => void; unref?: () => void }) | null;
    if (fns.size) c?.ref?.();
    else c?.unref?.();
  };
  const dispatch = (channel: string, payload: string | null): void => {
    for (const fn of fns.get(channel) ?? []) {
      try { fn(payload); } catch (e) { console.warn(`db: listener of ${channel} failed: ${(e as Error).message}`); }
    }
  };
  const lost = (c: Pg.Client, why: string): void => {
    if (client !== c) return;
    client = null;
    active.clear();
    c.removeAllListeners("notification");
    void c.end().catch(() => undefined);
    if (!warned) console.warn(`db: listening connection lost (${why}); reconnecting`);
    warned = true;
    schedule();
  };
  const schedule = (): void => {
    if (closed || retry || !fns.size) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)]!);
    retry.unref();
  };
  /** LISTENs every registered channel not yet in effect on the connection. */
  const sync = async (c: Pg.Client): Promise<void> => {
    for (const ch of [...fns.keys()]) {
      if (active.has(ch)) continue;
      try {
        await c.query(`LISTEN ${ch}`);
        if (client === c && fns.has(ch)) active.add(ch);
      } catch (e) {
        lost(c, (e as Error).message);
        return;
      }
    }
  };
  const connect = (): Promise<Pg.Client | null> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const reconnect = failures > 0 || warned;
      const c = new pg.Client({ connectionString: pgConnectionString(url), application_name: "autocraft-listen", keepAlive: true, connectionTimeoutMillis: LISTEN_CONNECT_MS });
      c.on("error", (e) => lost(c, e.message));
      c.on("end", () => lost(c, "closed"));
      try {
        await c.connect();
        if (closed) { await c.end(); return null; }
        c.on("notification", (m) => dispatch(m.channel, m.payload ?? ""));
        client = c;
        hold();
        await sync(c);
        if (client !== c) return null;
        failures = 0;
        warned = false;
        if (reconnect) for (const ch of fns.keys()) dispatch(ch, null);
        return c;
      } catch (e) {
        if (!warned) console.warn(`db: cannot open the listening connection: ${(e as Error).message}`);
        warned = true;
        failures++;
        await c.end().catch(() => undefined);
        schedule();
        return null;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    listen(channel, fn) {
      if (!CHANNEL.test(channel)) throw new Error(`db: bad channel name ${channel}`);
      if (closed) throw new Error("db: the handle is closed");
      let set = fns.get(channel);
      if (!set) fns.set(channel, set = new Set());
      set.add(fn);
      hold();
      if (client) void sync(client);
      else void connect();
      return {
        listening: () => client !== null && active.has(channel),
        off: () => {
          set.delete(fn);
          if (set.size || fns.get(channel) !== set) return;
          fns.delete(channel);
          active.delete(channel);
          if (client) void client.query(`UNLISTEN ${channel}`).catch(() => undefined);
          hold();
        },
      };
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      fns.clear();
      active.clear();
      const c = client ?? await connecting;
      client = null;
      if (c) { c.removeAllListeners("notification"); await c.end().catch(() => undefined); }
    },
  };
}

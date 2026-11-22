// Leader election for the roles of which one copy may work at a time: the runner and the periodic chores. On Postgres a
// copy leads while it holds the role's session-level advisory lock on a connection of its own; another copy waits as a
// standby, trying for the lock every few seconds, and takes over once the leader's session ends. On SQLite every process
// of an install runs on one host, where the lock files exclude a second copy, so a process always leads.
//
// Fencing. Winning moves the role's epoch (settings `leader:<role>:epoch`) in a write transaction, and the winner fences
// its writes to that epoch (src/db/fence.ts). Writes run one at a time under the writer lock, and each fenced write checks
// the epoch after taking it, so a write of the old leader either committed before the new epoch or fails. The old leader
// also stops on its own: a lost connection, or a check of the lock that fails or takes over CHECK_TIMEOUT_MS, aborts
// `lost`, and its process kills its children and exits. Its checks run every CHECK_MS, so it notices within
// CHECK_MS + CHECK_TIMEOUT_MS; the server ends a session whose client went silent only after the keepalive settings on
// the lock connection (KEEPALIVE), later than that, so in a network split the old leader has stopped before another
// copy can win.
import { hostname } from "node:os";
import type * as Pg from "pg";
import type { Db } from "./index.ts";
import { dbTarget, isPgUrl, loadPg } from "./open.ts";
import { pgConnectionString } from "./postgres.ts";
import { epochKey, isFenced, type LeaderRole } from "./fence.ts";

/** Advisory lock keys, one per role ("aclr", "aclp"); below 2^31, so pg_locks shows them as classid 0, objid key. */
const LOCK_KEYS: Record<LeaderRole, number> = { runner: 0x61636c72, periodic: 0x61636c70 };

/** A standby tries for the lock this often. */
export const RETRY_MS = 2_000;
/** The leader checks its lock this often, */
export const CHECK_MS = 2_000;
/** and gives up on a check that takes longer than this. */
export const CHECK_TIMEOUT_MS = 3_000;
/** Leader and standbys write their status row this often (health checks read it). */
export const BEAT_MS = 10_000;
/** Standby rows not written for this long are removed by the leader. */
const STANDBY_KEEP_MS = 10 * 60_000;
const CONNECT_MS = 5_000;
/** Server-side TCP settings of the lock connection: a silent client is dropped after about 5 + 3 × 2 = 11 seconds. */
const KEEPALIVE = { tcp_keepalives_idle: 5, tcp_keepalives_interval: 2, tcp_keepalives_count: 3, tcp_user_timeout: 10_000 };

/** Settings row the leader of `role` writes every BEAT_MS: LeaderStatus as JSON. */
export const leaderKey = (role: LeaderRole): string => `leader:${role}`;
/** Prefix of the rows standbys of `role` write, one per copy: StandbyStatus as JSON. */
export const standbyPrefix = (role: LeaderRole): string => `leader:${role}:standby:`;

export type LeaderStatus = { holder: string; epoch: number; since: string; at: string };
export type StandbyStatus = { holder: string; since: string; at: string };

export type Lease = {
  role: LeaderRole;
  /** 0 on SQLite, where nothing is fenced. */
  epoch: number;
  holder: string;
  /** Aborts when the lock is lost; never on SQLite. */
  lost: AbortSignal;
  /** Gives the lock up (a clean stop); the next standby takes over within RETRY_MS. */
  release(): Promise<void>;
};

export type ElectOptions = {
  /** The database (a postgres:// URL; anything else leads at once). Default: the process's configured database. */
  url?: string;
  /** Stops waiting: elect resolves null. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Called once, when this copy starts to wait as a standby. */
  onStandby?: () => void;
  holder?: string;
  retryMs?: number;
  checkMs?: number;
  checkTimeoutMs?: number;
  beatMs?: number;
};

const iso = (ms = Date.now()): string => new Date(ms).toISOString();

const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done(): void {
    clearTimeout(t);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  signal?.addEventListener("abort", done, { once: true });
});

async function putSetting(db: Db, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** A lock connection: errors and its end go to `onLost`, so a dropped connection never crashes the process. */
async function lockClient(pg: typeof Pg.default, url: string, role: LeaderRole, timeoutMs: number, onLost: (why: string) => void): Promise<Pg.Client> {
  const c = new pg.Client({
    connectionString: pgConnectionString(url), application_name: `autocraft-leader-${role}`, keepAlive: true, keepAliveInitialDelayMillis: 5_000,
    connectionTimeoutMillis: CONNECT_MS, query_timeout: timeoutMs,
  });
  c.on("error", (e) => onLost(e.message));
  c.on("end", () => onLost("the connection closed"));
  try {
    await c.connect();
    // Unix sockets ignore these; a server that refuses one still works with its defaults.
    for (const [k, v] of Object.entries(KEEPALIVE)) await c.query(`SET ${k} = ${v}`).catch(() => undefined);
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
  return c;
}

/**
 * Waits until this copy leads `role`, then resolves its lease; null when `signal` aborted first. The caller fences its
 * process to `lease.epoch` (setFence) before it starts work and stops at once when `lease.lost` aborts.
 */
export async function elect(db: Db, role: LeaderRole, o: ElectOptions = {}): Promise<Lease | null> {
  const holder = o.holder ?? `${hostname()}:${process.pid}`;
  const log = o.log ?? ((l: string) => console.log(l));
  const url = o.url ?? dbTarget();
  if (db.dialect !== "postgres" || !isPgUrl(url)) {
    return o.signal?.aborted ? null : { role, epoch: 0, holder, lost: new AbortController().signal, release: async () => {} };
  }
  const pg = await loadPg();
  const key = LOCK_KEYS[role];
  const retryMs = o.retryMs ?? RETRY_MS, checkMs = o.checkMs ?? CHECK_MS, timeoutMs = o.checkTimeoutMs ?? CHECK_TIMEOUT_MS, beatMs = o.beatMs ?? BEAT_MS;
  const standbyRow = `${standbyPrefix(role)}${holder}`;
  const waitingSince = iso();
  let onLost: (why: string) => void = () => {};
  let client: Pg.Client | null = null;
  let standbyBeat = 0, announced = false, lastError = "";

  // Standby: try for the lock until it is ours.
  for (;;) {
    if (o.signal?.aborted) {
      await client?.end().catch(() => undefined);
      await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow).catch(() => undefined);
      return null;
    }
    try {
      if (!client) {
        const c = await lockClient(pg, url, role, timeoutMs, (why) => onLost(why));
        onLost = (why) => {
          if (client !== c) return;
          client = null;
          log(`leader: the ${role} lock connection failed while waiting (${why}); opening another`);
          void c.end().catch(() => undefined);
        };
        client = c;
      }
      const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
      if (r.rows[0]?.ok) break;
      if (!announced) {
        announced = true;
        log(`leader: another copy leads the ${role}; waiting as a standby`);
        o.onStandby?.();
      }
      if (Date.now() - standbyBeat >= beatMs) {
        standbyBeat = Date.now();
        await putSetting(db, standbyRow, JSON.stringify({ holder, since: waitingSince, at: iso() } satisfies StandbyStatus));
      }
      lastError = "";
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError) log(`leader: cannot try the ${role} lock: ${msg}`);
      lastError = msg;
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
    }
    await pause(retryMs, o.signal);
  }

  const c = client!;
  const ac = new AbortController();
  let released = false;
  let check: NodeJS.Timeout | undefined, beat: NodeJS.Timeout | undefined;
  const lose = (why: string): void => {
    if (released || ac.signal.aborted) return;
    clearInterval(check);
    clearInterval(beat);
    log(`leader: lost the ${role} lock (${why})`);
    ac.abort(new Error(why));
    void c.end().catch(() => undefined);
  };
  onLost = lose;

  // The epoch moves while this copy holds the lock, so no two copies ever share one.
  let epoch: number;
  const since = iso();
  try {
    const row = await db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS BIGINT) + 1 AS TEXT) RETURNING value")
      .get(epochKey(role)) as { value: string };
    epoch = Number(row.value);
    await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow);
    await putSetting(db, leaderKey(role), JSON.stringify({ holder, epoch, since, at: since } satisfies LeaderStatus));
  } catch (e) {
    // A write that cannot get the writer lock (a lock wait past its limit): give the lock back and try again.
    released = true;
    log(`leader: the ${role} lock was won but its epoch not moved: ${(e as Error).message}; trying again`);
    await c.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => undefined);
    await c.end().catch(() => undefined);
    await pause(retryMs, o.signal);
    return await elect(db, role, { ...o, holder, onStandby: announced ? undefined : o.onStandby });
  }
  log(`leader: this copy leads the ${role} (epoch ${epoch})`);

  let checking = false;
  check = setInterval(() => {
    if (checking) return;
    checking = true;
    c.query<{ n: number | string }>("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted", [key])
      .then((r) => { if (Number(r.rows[0]?.n) !== 1) lose("the lock is no longer held"); }, (e: Error) => lose(e.message))
      .finally(() => { checking = false; });
  }, checkMs);
  beat = setInterval(() => {
    // Fenced like every write of this process: a refusal means another copy has taken over.
    void (async () => {
      await putSetting(db, leaderKey(role), JSON.stringify({ holder, epoch, since, at: iso() } satisfies LeaderStatus));
      await pruneStandbys(db, role);
    })().catch((e: unknown) => {
      if (isFenced(e)) lose("another copy took over");
      else log(`leader: status of the ${role} not written: ${(e as Error).message}`);
    });
  }, beatMs);
  check.unref();
  beat.unref();

  return {
    role, epoch, holder, lost: ac.signal,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(check);
      clearInterval(beat);
      if (!ac.signal.aborted) await c.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => undefined);
      await c.end().catch(() => undefined);
      log(`leader: released the ${role} lock`);
    },
  };
}

/** Removes the rows of standbys that stopped writing them. */
async function pruneStandbys(db: Db, role: LeaderRole): Promise<void> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${standbyPrefix(role)}%`) as { key: string; value: string }[];
  for (const r of rows) {
    let at = NaN;
    try { at = Date.parse((JSON.parse(r.value) as StandbyStatus).at); } catch { /* removed below */ }
    if (Number.isNaN(at) || Date.now() - at > STANDBY_KEEP_MS) await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(r.key, r.value);
  }
}

/** What the health checks show of a role: its leader's status and the standbys seen within `freshMs`; null when no copy was ever elected (SQLite). */
export async function leaderStatus(db: Db, role: LeaderRole, freshMs: number, nowMs = Date.now()): Promise<{ leader: LeaderStatus | null; standbys: number } | null> {
  const rows = await db.all(db.k.selectFrom("settings").select(["key", "value"]).where("key", "like", `${leaderKey(role)}%`));
  const lead = rows.find((r) => r.key === leaderKey(role));
  if (!lead) return null;
  const parse = <T>(v: string | null): T | null => { try { return v ? JSON.parse(v) as T : null; } catch { return null; } };
  const fresh = (s: { at?: unknown } | null): boolean => typeof s?.at === "string" && nowMs - Date.parse(s.at) <= freshMs;
  const standbys = rows.filter((r) => r.key.startsWith(standbyPrefix(role)) && fresh(parse<StandbyStatus>(r.value))).length;
  return { leader: parse<LeaderStatus>(lead.value), standbys };
}

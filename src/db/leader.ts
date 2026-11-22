// Leader election for the roles of which one copy may work at a time: the runner and the periodic chores. On Postgres a
// copy leads while it holds the role's session-level advisory lock on a connection of its own; another copy waits as a
// standby, trying for the lock every few seconds, and takes over once the leader's session ends. On SQLite every process
// of an install runs on one host, where the lock files exclude a second copy, so a process always leads.
//
// Fencing. Winning moves the role's epoch (settings `leader:<role>:epoch`) in a write transaction, and the winner fences
// its writes to that epoch (src/db/fence.ts). Writes run one at a time under the writer lock, and each fenced write checks
// the epoch after taking it, so a write of the old leader either committed before the new epoch or fails.
//
// Losing. The leader runs `SELECT 1` on its lock connection every CHECK_MS. A slow check is not a loss. When the
// connection fails, the leader opens another, takes the lock again and reads the epoch under the writer lock: the same
// epoch means no other copy led meanwhile, and it carries on. `lost` aborts when another copy holds the lock or moved the
// epoch, or when no check has succeeded for LOSS_MS by the wall clock (an event-loop stall counts). LOSS_MS is below the
// time the server takes to drop a silent client (SERVER_KEEPALIVE in postgres.ts, about 11 seconds), so in a network
// split the old leader has stopped before another copy can win.
import { hostname } from "node:os";
import type * as Pg from "pg";
import type { Db } from "./index.ts";
import { dbTarget, isPgUrl, loadPg } from "./open.ts";
import { pgConnectionString, SERVER_KEEPALIVE } from "./postgres.ts";
import { epochKey, isFenced, type LeaderRole } from "./fence.ts";

/**
 * Exit code of a process that lost its leader lock: an ordinary failure (not a signal), so its supervisor restarts it
 * (Kubernetes, Compose, systemd Restart=on-failure) as a standby.
 */
export const LOST_LEADER_EXIT = 75;

/** Advisory lock keys, one per role ("aclr", "aclp"); below 2^31, so pg_locks shows them as classid 0, objid key. */
const LOCK_KEYS: Record<LeaderRole, number> = { runner: 0x61636c72, periodic: 0x61636c70 };

/** A standby tries for the lock this often. */
export const RETRY_MS = 2_000;
/** The leader checks its lock connection this often. */
export const CHECK_MS = 2_000;
/** Longest time without a successful check before the leader gives up: below the server's drop time of a silent client. */
export const LOSS_MS = 8_000;
/** Longest wait for a lock query of a standby or of a leader taking its lock again. */
const QUERY_MS = 3_000;
/** Leader and standbys write their status row this often (health checks read it). */
export const BEAT_MS = 10_000;
/** Standby rows not written for this long are removed by the leader. */
const STANDBY_KEEP_MS = 10 * 60_000;
const CONNECT_MS = 5_000;

/** Settings row the leader of `role` writes every BEAT_MS: LeaderStatus as JSON. */
export const leaderKey = (role: LeaderRole): string => `leader:${role}`;
/** Prefix of the rows standbys of `role` write, one per copy: StandbyStatus as JSON. */
export const standbyPrefix = (role: LeaderRole): string => `leader:${role}:standby:`;

/** What the server says of a lock connection: its backend, the keepalive settings in effect and the client address it sees. */
export type ConnInfo = { pid: number; keepalivesIdle: string | null; userTimeout: string | null; clientAddr: string | null };
export type LeaderStatus = { holder: string; epoch: number; since: string; at: string; conn: Omit<ConnInfo, "pid"> };
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
  lossMs?: number;
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

/** `p`, or a rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

async function putSetting(db: Db, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Settings the server refused on a lock connection, logged once each. */
const refusedLogged = new Set<string>();

/** A lock connection: errors and its end go to `onLost`, so a dropped connection never crashes the process. */
async function lockClient(pg: typeof Pg.default, url: string, role: LeaderRole, log: (l: string) => void, onLost: (c: Pg.Client, why: string) => void): Promise<{ client: Pg.Client; info: ConnInfo }> {
  const c = new pg.Client({
    connectionString: pgConnectionString(url), application_name: `autocraft-leader-${role}`, keepAlive: true, keepAliveInitialDelayMillis: 5_000,
    connectionTimeoutMillis: CONNECT_MS,
  });
  c.on("error", (e) => onLost(c, e.message));
  c.on("end", () => onLost(c, "the connection closed"));
  try {
    await c.connect();
    // A refused setting leaves the server's default; the status row shows what is in effect.
    for (const [k, v] of Object.entries(SERVER_KEEPALIVE)) {
      await within(c.query(`SET ${k} = ${v}`), QUERY_MS, `SET ${k}`).catch((e: Error) => {
        if (!refusedLogged.has(k)) log(`leader: the server refused ${k} = ${v} on the ${role} lock connection: ${e.message}`);
        refusedLogged.add(k);
      });
    }
    const r = await within(c.query<{ pid: number; idle: string | null; ut: string | null; addr: string | null }>(
      "SELECT pg_backend_pid() AS pid, current_setting('tcp_keepalives_idle', true) AS idle, current_setting('tcp_user_timeout', true) AS ut, host(inet_client_addr()) AS addr"), QUERY_MS, "the connection check");
    const row = r.rows[0]!;
    return { client: c, info: { pid: Number(row.pid), keepalivesIdle: row.idle, userTimeout: row.ut, clientAddr: row.addr } };
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
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
  const retryMs = o.retryMs ?? RETRY_MS, checkMs = o.checkMs ?? CHECK_MS, lossMs = o.lossMs ?? LOSS_MS, beatMs = o.beatMs ?? BEAT_MS;
  const standbyRow = `${standbyPrefix(role)}${holder}`;
  const waitingSince = iso();
  let onLost: (c: Pg.Client, why: string) => void = () => {};
  const open = () => lockClient(pg, url, role, log, (c, why) => onLost(c, why));
  let conn: { client: Pg.Client; info: ConnInfo } | null = null;
  let standbyBeat = 0, announced = false, lastError = "";

  // Standby: try for the lock until it is ours.
  onLost = (c, why) => {
    if (conn?.client !== c) return;
    conn = null;
    log(`leader: the ${role} lock connection failed while waiting (${why}); opening another`);
    void c.end().catch(() => undefined);
  };
  for (;;) {
    if (o.signal?.aborted) {
      await conn?.client.end().catch(() => undefined);
      await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow).catch(() => undefined);
      return null;
    }
    try {
      conn ??= await open();
      const r = await within(conn.client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]), QUERY_MS, "the lock query");
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
      const c = conn?.client;
      conn = null;
      await c?.end().catch(() => undefined);
    }
    await pause(retryMs, o.signal);
  }

  let current: { client: Pg.Client; info: ConnInfo } = conn!;
  const ac = new AbortController();
  let released = false, recovering = false;
  /** Send time of the last check that succeeded. */
  let lastOk = Date.now();
  let check: NodeJS.Timeout | undefined, watch: NodeJS.Timeout | undefined, beat: NodeJS.Timeout | undefined;
  const stopTimers = () => { clearInterval(check); clearInterval(watch); clearInterval(beat); };
  const lose = (why: string): void => {
    if (released || ac.signal.aborted) return;
    stopTimers();
    log(`leader: lost the ${role} lock (${why})`);
    ac.abort(new Error(why));
    void current.client.end().catch(() => undefined);
  };
  const status = (at: string): string => {
    const { pid: _, ...c } = current.info;
    return JSON.stringify({ holder, epoch, since, at, conn: c } satisfies LeaderStatus);
  };

  // The epoch moves while this copy holds the lock, so no two copies ever share one.
  let epoch: number;
  const since = iso();
  try {
    const row = await db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS BIGINT) + 1 AS TEXT) RETURNING value")
      .get(epochKey(role)) as { value: string };
    epoch = Number(row.value);
    await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow);
    await putSetting(db, leaderKey(role), status(since));
  } catch (e) {
    // A write that cannot get the writer lock (a lock wait past its limit): give the lock back and try again.
    released = true;
    log(`leader: the ${role} lock was won but its epoch not moved: ${(e as Error).message}; trying again`);
    await current.client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => undefined);
    await current.client.end().catch(() => undefined);
    await pause(retryMs, o.signal);
    return await elect(db, role, { ...o, holder, onStandby: announced ? undefined : o.onStandby });
  }
  log(`leader: this copy leads the ${role} (epoch ${epoch})`);

  /** After the lock connection failed: a new connection, the lock again, and the epoch unchanged; otherwise `lost`. */
  const reacquire = async (why: string): Promise<void> => {
    if (recovering || released || ac.signal.aborted) return;
    recovering = true;
    const oldPid = current.info.pid;
    void current.client.end().catch(() => undefined);
    log(`leader: the ${role} lock connection failed (${why}); taking the lock again`);
    try {
      while (!released && !ac.signal.aborted && Date.now() - lastOk <= lossMs) {
        let next: { client: Pg.Client; info: ConnInfo } | null = null;
        try {
          next = await open();
          const got = (await within(next.client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]), QUERY_MS, "the lock query")).rows[0]?.ok;
          if (!got) {
            // Held by the old session (the server has not dropped it yet) or by another copy.
            const h = await within(next.client.query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted", [key]), QUERY_MS, "the lock holder query");
            const holderPid = h.rows[0]?.pid;
            await next.client.end().catch(() => undefined);
            next = null;
            if (holderPid !== undefined && Number(holderPid) !== oldPid) return lose("another copy holds the lock");
            await pause(Math.min(retryMs, 500));
            continue;
          }
          // Under the writer lock: a new leader's epoch write has either committed or not begun.
          const row = await db.write(async () => await db.prepare("SELECT value FROM settings WHERE key = ?").get(epochKey(role)) as { value: string } | undefined);
          if (row?.value !== String(epoch)) {
            lose(`another copy led meanwhile (epoch ${row?.value ?? "none"})`);
            await next.client.end().catch(() => undefined);
            return;
          }
          if (released || ac.signal.aborted) {
            await next.client.end().catch(() => undefined);
            return;
          }
          current = next;
          lastOk = Date.now();
          log(`leader: took the ${role} lock again (epoch ${epoch})`);
          return;
        } catch (e) {
          await next?.client.end().catch(() => undefined);
          if (isFenced(e)) return lose("another copy took over");
          await pause(Math.min(retryMs, 500));
        }
      }
    } finally {
      recovering = false;
    }
  };
  onLost = (c, why) => { if (c === current.client) void reacquire(why); };

  let checking = false;
  check = setInterval(() => {
    if (checking || recovering) return;
    checking = true;
    const sent = Date.now(), c = current.client;
    c.query("SELECT 1").then(
      () => { if (c === current.client) lastOk = Math.max(lastOk, sent); },
      (e: Error) => { if (c === current.client) void reacquire(e.message); },
    ).finally(() => { checking = false; });
  }, checkMs);
  // Wall-clock time: after a stall of the event loop this fires late and sees the whole gap.
  watch = setInterval(() => {
    if (Date.now() - lastOk > lossMs) lose(`no successful check of the lock for ${Math.round((Date.now() - lastOk) / 1000)} s`);
  }, Math.min(250, checkMs));
  beat = setInterval(() => {
    // Fenced like every write of this process: a refusal means another copy has taken over.
    void (async () => {
      await putSetting(db, leaderKey(role), status(iso()));
      await pruneStandbys(db, role);
    })().catch((e: unknown) => {
      if (isFenced(e)) lose("another copy took over");
      else log(`leader: status of the ${role} not written: ${(e as Error).message}`);
    });
  }, beatMs);
  check.unref();
  watch.unref();
  beat.unref();

  return {
    role, epoch, holder, lost: ac.signal,
    release: async () => {
      if (released) return;
      released = true;
      stopTimers();
      if (!ac.signal.aborted) await current.client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => undefined);
      await current.client.end().catch(() => undefined);
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

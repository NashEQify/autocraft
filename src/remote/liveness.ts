// The dashboard's liveness stamp. Helpers reach the server only through the dashboard, so while it is down, stalled or
// restarting no heartbeat can arrive, and a lease must not be counted as lost for that. The dashboard stamps the
// `remote_liveness` row every ALIVE_EVERY_MS; job processes, which expire leases (calls.ts expireLeases), read it.
import { isBusy } from "../db.ts";
import { scaled } from "./time-scale.ts";
import type { Db } from "../db/index.ts";

export const ALIVE_EVERY_MS = scaled(5_000);
/** A stamp older than this means the dashboard is not serving: down, stalled or restarting. */
export const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS;

/**
 * Writes the stamp. After a gap (the previous stamp is stale) every leased call's heartbeat, lease and run start move
 * forward by the gap, capped at now, so neither the idle window nor the time limit counts the time no helper could reach
 * the server; the unbroken run of stamps then starts afresh.
 */
export async function stampAlive(db: Db, nowMs: number = Date.now()): Promise<void> {
  // Called inside a transaction: the next tick stamps.
  if (db.inTransaction()) return;
  await db.write(async () => {
    const r = await db.prepare("SELECT alive_at FROM main.remote_liveness WHERE id = 1").get() as { alive_at: number } | undefined;
    if (!r) await db.prepare("INSERT INTO main.remote_liveness (id, alive_at, since) VALUES (1, ?, ?)").run(nowMs, nowMs);
    else if (nowMs - Number(r.alive_at) > ALIVE_STALE_MS) {
      const gap = nowMs - Number(r.alive_at);
      await db.prepare(`UPDATE main.remote_calls SET heartbeat_at = MIN(heartbeat_at + ?1, ?2), leased_at = MIN(leased_at + ?1, ?2),
          started_at = CASE WHEN started_at IS NULL THEN NULL ELSE MIN(started_at + ?1, ?2) END
        WHERE state = 'leased'`).run(gap, nowMs);
      await db.prepare("UPDATE main.remote_liveness SET alive_at = ?, since = ? WHERE id = 1").run(nowMs, nowMs);
    } else await db.prepare("UPDATE main.remote_liveness SET alive_at = ? WHERE id = 1").run(nowMs);
  });
}

/**
 * Whether the dashboard is serving now, and since when without a gap. A database the dashboard never stamped (no
 * dashboard has run against it) counts as always alive.
 */
export async function dashboardAlive(db: Db, nowMs: number): Promise<{ alive: boolean; since: number }> {
  const r = await db.prepare("SELECT alive_at, since FROM main.remote_liveness WHERE id = 1").get() as { alive_at: number; since: number } | undefined;
  if (!r) return { alive: true, since: -Infinity };
  return { alive: nowMs - Number(r.alive_at) <= ALIVE_STALE_MS, since: Number(r.since) };
}

/** Starts the stamp timer in the dashboard process; returns the function that stops it. */
export async function startLiveness(db: Db): Promise<() => void> {
  const tick = async (): Promise<void> => {
    try { await stampAlive(db); } catch (e) { if (!isBusy(e)) console.log(`liveness stamp not written: ${(e as Error).message}`); }
  };
  await tick();
  const t = setInterval(() => void tick(), ALIVE_EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}

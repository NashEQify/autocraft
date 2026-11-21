// Cool-off of the user-local mode, per login: a login whose helpers keep losing leases (no heartbeat, past a time limit) or
// keep failing calls (`ok: false` replies in a row) gets no calls for a while, so a broken helper stops holding and failing
// calls other helpers could run. Revoking a token does not end it; an operator does (`autocraft-server remote cooloff clear`).
import { scaled } from "./time-scale.ts";
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";

/** Lease drops of one login within DROP_WINDOW_MS that start a cool-off. */
export const DROP_LIMIT = 3;
export const DROP_WINDOW_MS = scaled(2 * 3600_000);
/** A token's drops count at most once in this long: one outage or one stuck machine is one drop. */
export const DROP_DEDUPE_MS = scaled(10 * 60_000);
/** How long lost leases cool a login off. */
export const COOLOFF_MS = scaled(6 * 3600_000);
/** Failed replies in a row, within FAILURE_WINDOW_MS of the first, that start a cool-off. */
export const FAILURE_LIMIT = 5;
export const FAILURE_WINDOW_MS = scaled(30 * 60_000);
/** How long failed replies cool a login off. */
export const FAILURE_COOLOFF_MS = scaled(3600_000);

export const DROP_REASON = `its leases were lost ${DROP_LIMIT} times within 2 hours (no heartbeat, or past the call's time limit)`;
export const FAILURE_REASON = `its helpers failed ${FAILURE_LIMIT} calls in a row within 30 minutes`;

async function coolOff(db: Db, login: string, until: number, reason: string): Promise<void> {
  await db.prepare(`INSERT INTO main.remote_cooloffs (login, until, reason, failures, failures_since) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT (login) DO UPDATE SET until = excluded.until, reason = excluded.reason, failures = 0, failures_since = NULL`).run(login, until, reason);
  await db.prepare("DELETE FROM main.remote_lease_drops WHERE login = ?").run(login);
  await audit(db, login, "remote-cooloff", login, { until, reason });
}

/**
 * Records a lost lease of call `callId`, held by `tokenId` of `login`; the DROP_LIMIT-th drop of the login within the window
 * starts the cool-off. The same call lost again within the window counts once: a call that cannot be delivered (a proxy
 * refusing its reply) says nothing more about the helper, and it fails on its own at its attempt limit.
 */
export async function noteDrop(db: Db, tokenId: number, login: string, callId: number, nowMs: number): Promise<void> {
  if (await db.prepare("SELECT 1 FROM main.remote_lease_drops WHERE token_id = ? AND at > ?").get(tokenId, nowMs - DROP_DEDUPE_MS)) return;
  if (await db.prepare("SELECT 1 FROM main.remote_lease_drops WHERE login = ? AND call_id = ? AND at >= ?").get(login, callId, nowMs - DROP_WINDOW_MS)) return;
  await db.prepare("INSERT INTO main.remote_lease_drops (token_id, login, call_id, at) VALUES (?, ?, ?, ?)").run(tokenId, login, callId, nowMs);
  const n = Number((await db.prepare("SELECT COUNT(*) AS n FROM main.remote_lease_drops WHERE login = ? AND at >= ?").get(login, nowMs - DROP_WINDOW_MS) as { n: number }).n);
  if (n >= DROP_LIMIT) await coolOff(db, login, nowMs + COOLOFF_MS, DROP_REASON);
}

/** Records a failed reply of `login`'s helper; the FAILURE_LIMIT-th in a row within the window starts the cool-off. */
export async function noteFailure(db: Db, login: string, nowMs: number): Promise<void> {
  const r = await db.prepare("SELECT failures, failures_since FROM main.remote_cooloffs WHERE login = ?").get(login) as { failures: number; failures_since: number | null } | undefined;
  const fresh = !r || r.failures_since === null || Number(r.failures_since) < nowMs - FAILURE_WINDOW_MS;
  const failures = fresh ? 1 : Number(r.failures) + 1;
  if (failures >= FAILURE_LIMIT) return await coolOff(db, login, nowMs + FAILURE_COOLOFF_MS, FAILURE_REASON);
  await db.prepare(`INSERT INTO main.remote_cooloffs (login, failures, failures_since) VALUES (?, ?, ?)
    ON CONFLICT (login) DO UPDATE SET failures = excluded.failures, failures_since = excluded.failures_since`).run(login, failures, fresh ? nowMs : r!.failures_since);
}

/** An accepted reply ends the login's run of failures. */
export async function noteSuccess(db: Db, login: string): Promise<void> {
  await db.prepare("UPDATE main.remote_cooloffs SET failures = 0, failures_since = NULL WHERE login = ? AND failures > 0").run(login);
}

/** When the login's helpers may claim again and why they may not now, or null when the login is not cooling off. */
export async function cooloffOf(db: Db, login: string, nowMs: number): Promise<{ until: number; reason: string } | null> {
  const r = await db.prepare("SELECT until, reason FROM main.remote_cooloffs WHERE login = ?").get(login) as { until: number | null; reason: string | null } | undefined;
  return r?.until != null && Number(r.until) > nowMs ? { until: Number(r.until), reason: r.reason ?? DROP_REASON } : null;
}

/** Deletes drops older than the window and cool-off rows that neither hold a login nor count failures (calls.ts pruneRemote). */
export async function pruneCooloffs(db: Db, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM main.remote_lease_drops WHERE at < ?").run(nowMs - DROP_WINDOW_MS);
  await db.prepare("DELETE FROM main.remote_cooloffs WHERE COALESCE(until, 0) <= ? AND (failures = 0 OR failures_since < ?)").run(nowMs, nowMs - FAILURE_WINDOW_MS);
}

/** Ends the login's cool-off and forgets its drops and failures; false when it was not cooling off. */
export async function clearCooloff(db: Db, login: string, by: string, nowMs: number = Date.now()): Promise<boolean> {
  const was = await cooloffOf(db, login, nowMs) !== null;
  await db.prepare("DELETE FROM main.remote_cooloffs WHERE login = ?").run(login);
  await db.prepare("DELETE FROM main.remote_lease_drops WHERE login = ?").run(login);
  if (was) await audit(db, by, "remote-cooloff-clear", login, {});
  return was;
}

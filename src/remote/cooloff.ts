// Cool-off of the user-local mode, per login: a login whose helpers keep losing leases (no heartbeat, past a time limit) or
// keep failing calls (`ok: false` replies in a row) gets no calls for a while, so a broken helper stops holding and failing
// calls other helpers could run. Revoking a token does not end it; an operator does (`autocraft-server remote cooloff clear`).
import { scaled } from "./time-scale.ts";
import { excluded } from "../db/kx.ts";
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
  await db.run(db.k.insertInto("main.remote_cooloffs").values({ login, until, reason, failures: 0, failures_since: null })
    .onConflict((oc) => oc.column("login").doUpdateSet(excluded(["until", "reason", "failures", "failures_since"]))));
  await db.run(db.k.deleteFrom("main.remote_lease_drops").where("login", "=", login));
  await audit(db, login, "remote-cooloff", login, { until, reason });
}

/**
 * Records a lost lease of call `callId`, held by `tokenId` of `login`; the DROP_LIMIT-th drop of the login within the window
 * starts the cool-off. The same call lost again within the window counts once: a call that cannot be delivered (a proxy
 * refusing its reply) says nothing more about the helper, and it fails on its own at its attempt limit.
 */
export async function noteDrop(db: Db, tokenId: number, login: string, callId: number, nowMs: number): Promise<void> {
  if (await db.get(db.k.selectFrom("main.remote_lease_drops").select("token_id").where("token_id", "=", tokenId).where("at", ">", nowMs - DROP_DEDUPE_MS).limit(1))) return;
  if (await db.get(db.k.selectFrom("main.remote_lease_drops").select("token_id").where("login", "=", login).where("call_id", "=", callId).where("at", ">=", nowMs - DROP_WINDOW_MS).limit(1))) return;
  await db.run(db.k.insertInto("main.remote_lease_drops").values({ token_id: tokenId, login, call_id: callId, at: nowMs }));
  const n = Number((await db.get(db.k.selectFrom("main.remote_lease_drops").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", login).where("at", ">=", nowMs - DROP_WINDOW_MS)))!.n);
  if (n >= DROP_LIMIT) await coolOff(db, login, nowMs + COOLOFF_MS, DROP_REASON);
}

/** Records a failed reply of `login`'s helper; the FAILURE_LIMIT-th in a row within the window starts the cool-off. */
export async function noteFailure(db: Db, login: string, nowMs: number): Promise<void> {
  const r = await db.get(db.k.selectFrom("main.remote_cooloffs").select(["failures", "failures_since"]).where("login", "=", login));
  const fresh = !r || r.failures_since === null || Number(r.failures_since) < nowMs - FAILURE_WINDOW_MS;
  const failures = fresh ? 1 : Number(r.failures) + 1;
  if (failures >= FAILURE_LIMIT) return await coolOff(db, login, nowMs + FAILURE_COOLOFF_MS, FAILURE_REASON);
  await db.run(db.k.insertInto("main.remote_cooloffs").values({ login, failures, failures_since: fresh ? nowMs : r!.failures_since })
    .onConflict((oc) => oc.column("login").doUpdateSet(excluded(["failures", "failures_since"]))));
}

/** An accepted reply ends the login's run of failures. */
export async function noteSuccess(db: Db, login: string): Promise<void> {
  await db.run(db.k.updateTable("main.remote_cooloffs").set({ failures: 0, failures_since: null }).where("login", "=", login).where("failures", ">", 0));
}

/** When the login's helpers may claim again and why they may not now, or null when the login is not cooling off. */
export async function cooloffOf(db: Db, login: string, nowMs: number): Promise<{ until: number; reason: string } | null> {
  return cooledOf(await db.get(cooloffRow(db, login)), nowMs);
}

/** The login's cool-off row, as cooloffOf reads it. */
export const cooloffRow = (db: Db, login: string) => db.k.selectFrom("main.remote_cooloffs").select(["until", "reason"]).where("login", "=", login);

/** cooloffOf for the row already read (undefined: none). */
export const cooledOf = (r: { until: number | null; reason: string | null } | undefined, nowMs: number): { until: number; reason: string } | null =>
  r?.until != null && Number(r.until) > nowMs ? { until: Number(r.until), reason: r.reason ?? DROP_REASON } : null;

/** Deletes drops older than the window and cool-off rows that neither hold a login nor count failures (calls.ts pruneRemote). */
export async function pruneCooloffs(db: Db, nowMs: number): Promise<void> {
  await db.run(db.k.deleteFrom("main.remote_lease_drops").where("at", "<", nowMs - DROP_WINDOW_MS));
  await db.run(db.k.deleteFrom("main.remote_cooloffs").where((eb) => eb.and([
    eb(eb.fn.coalesce("until", eb.lit(0)), "<=", nowMs),
    eb.or([eb("failures", "=", 0), eb("failures_since", "<", nowMs - FAILURE_WINDOW_MS)]),
  ])));
}

/** Ends the login's cool-off and forgets its drops and failures; false when it was not cooling off. */
export async function clearCooloff(db: Db, login: string, by: string, nowMs: number = Date.now()): Promise<boolean> {
  const was = await cooloffOf(db, login, nowMs) !== null;
  await db.run(db.k.deleteFrom("main.remote_cooloffs").where("login", "=", login));
  await db.run(db.k.deleteFrom("main.remote_lease_drops").where("login", "=", login));
  if (was) await audit(db, by, "remote-cooloff-clear", login, {});
  return was;
}

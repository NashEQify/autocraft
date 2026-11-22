// Each user's "Max calls at once" for their user-local helpers, stored in `user_settings` under `max_calls`: the most calls
// all their helpers hold leases on together (claimCall). No row means no limit.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export const MAX_CALLS_KEY = "max_calls";
/** The highest limit a user may set: four helpers at the helper's 16 parallel slots. */
export const MAX_CALLS_MAX = 64;

/** The user's limit, or null for none. */
export async function userMaxCalls(db: Db, login: string): Promise<number | null> {
  const row = await db.get(db.k.selectFrom("main.user_settings").select("value").where("login", "=", login).where("key", "=", MAX_CALLS_KEY));
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_CALLS_MAX ? n : null;
}

/** A limit from a request body, checked: a whole number from 1 to MAX_CALLS_MAX, or null for none; throws with the reason for a bad one. */
export function parseMaxCalls(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CALLS_MAX) throw new Error(`maxCalls must be a whole number from 1 to ${MAX_CALLS_MAX}, or null for no limit`);
  return raw;
}

/** Stores the user's limit (null removes it); a change is audited. */
export async function setUserMaxCalls(db: Db, login: string, max: number | null): Promise<number | null> {
  const was = await userMaxCalls(db, login);
  if (max === null) await db.run(db.k.deleteFrom("main.user_settings").where("login", "=", login).where("key", "=", MAX_CALLS_KEY));
  else await db.run(db.k.insertInto("main.user_settings").values({ login, key: MAX_CALLS_KEY, value: String(max), updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(excluded(["value", "updated_at"]))));
  if (was !== max) await audit(db, login, "max-calls", login, { maxCalls: max, was });
  return max;
}

// Each user's "Manual only" switch for their Task Runners, stored in `user_settings` under `manual_only` ('1' when on): the
// runners take only the calls the user picked ("Run on my Task Runner", picks.ts) and follow-ups of the user's own sessions
// (calls.ts claimOrder). The planner's room (room.ts), the authors' give-way rule (calls.ts idleOthers) and the
// `remote-starved` health check leave such runners out. No row means off.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";

export const MANUAL_ONLY_KEY = "manual_only";

/** SQL that is true when the login in column `col` has Manual only on. */
export const manualSql = (col: string): string =>
  `EXISTS (SELECT 1 FROM main.user_settings mo WHERE mo.login = ${col} AND mo.key = '${MANUAL_ONLY_KEY}' AND mo.value = '1')`;

export async function manualOnly(db: Db, login: string): Promise<boolean> {
  return await db.prepare("SELECT 1 FROM main.user_settings WHERE login = ? AND key = ? AND value = '1'").get(login, MANUAL_ONLY_KEY) !== undefined;
}

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseManualOnly(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("manualOnly must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export async function setManualOnly(db: Db, login: string, on: boolean): Promise<boolean> {
  const was = await manualOnly(db, login);
  if (!on) await db.prepare("DELETE FROM main.user_settings WHERE login = ? AND key = ?").run(login, MANUAL_ONLY_KEY);
  else await db.prepare("INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, '1', ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(login, MANUAL_ONLY_KEY, new Date().toISOString());
  if (was !== on) await audit(db, login, "manual-only", login, { manualOnly: on });
  return on;
}

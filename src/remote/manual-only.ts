// Each user's "Manual only" switch for their Task Runners, stored in `user_settings` under `manual_only` ('1' when on): the
// runners take only the calls the user picked ("Run on my Task Runner", picks.ts) and follow-ups of the user's own sessions
// (calls.ts claimOrder). The planner's room (room.ts), the authors' give-way rule (calls.ts idleOthers) and the
// `remote-starved` health check leave such runners out. No row means off.
import { audit } from "../dash/audit.ts";
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { excluded, ref, type Eb, type Ex } from "../db/kx.ts";

export const MANUAL_ONLY_KEY = "manual_only";

/** SQL that is true when the login in column `col` has Manual only on. */
export const manualSql = (col: string): string =>
  `EXISTS (SELECT 1 FROM main.user_settings mo WHERE mo.login = ${col} AND mo.key = '${MANUAL_ONLY_KEY}' AND mo.value = '1')`;

/** `manualSql` as an expression on the login in `col`. */
export const manualExpr = (db: Db, eb: Eb, col: Ex): AliasableExpression<SqlBool> =>
  eb.exists(db.k.selectFrom("main.user_settings as mo").select(eb.lit(1).as("one")).where("mo.login", "=", ref<string>(col)).where("mo.key", "=", MANUAL_ONLY_KEY).where("mo.value", "=", "1"));

export async function manualOnly(db: Db, login: string): Promise<boolean> {
  return await db.get(db.k.selectFrom("main.user_settings").select((eb) => eb.lit(1).as("one")).where("login", "=", login).where("key", "=", MANUAL_ONLY_KEY).where("value", "=", "1")) !== undefined;
}

/** The switch of a stored `manual_only` value (undefined: no row). */
export const manualOf = (value: string | undefined): boolean => value === "1";

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseManualOnly(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("manualOnly must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export async function setManualOnly(db: Db, login: string, on: boolean): Promise<boolean> {
  const was = await manualOnly(db, login);
  if (!on) await db.run(db.k.deleteFrom("main.user_settings").where("login", "=", login).where("key", "=", MANUAL_ONLY_KEY));
  else await db.run(db.k.insertInto("main.user_settings").values({ login, key: MANUAL_ONLY_KEY, value: "1", updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(excluded(["value", "updated_at"]))));
  if (was !== on) await audit(db, login, "manual-only", login, { manualOnly: on });
  return on;
}

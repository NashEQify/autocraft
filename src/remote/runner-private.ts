// Each user's "Private Task Runner" switch, stored in `user_settings` under `runner_private` ('1' when on). The Live board's worker
// view (src/dash/api/live.ts) shows the calls of a private user's runners under one neutral row, with no login, label, slots or
// models; the user still sees their own runners as theirs. No row means shared.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const RUNNER_PRIVATE_KEY = "runner_private";

export async function runnerPrivate(db: Db, login: string): Promise<boolean> {
  return await db.get(db.k.selectFrom("main.user_settings").select((eb) => eb.lit(1).as("one")).where("login", "=", login).where("key", "=", RUNNER_PRIVATE_KEY).where("value", "=", "1")) !== undefined;
}

/** The lowercased logins among `logins` that keep their runners private. */
export async function privateLogins(db: Db, logins: readonly string[]): Promise<Set<string>> {
  const want = [...new Set(logins.map((l) => l.toLowerCase()))];
  if (!want.length) return new Set();
  const rows = await db.all(db.k.selectFrom("main.user_settings").select("login").where("key", "=", RUNNER_PRIVATE_KEY).where("value", "=", "1")
    .where((eb) => kx.inList(db, eb.fn<string>("lower", ["login"]), want)));
  return new Set(rows.map((r) => r.login.toLowerCase()));
}

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseRunnerPrivate(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("runnerPrivate must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export async function setRunnerPrivate(db: Db, login: string, on: boolean): Promise<boolean> {
  const was = await runnerPrivate(db, login);
  if (!on) await db.run(db.k.deleteFrom("main.user_settings").where("login", "=", login).where("key", "=", RUNNER_PRIVATE_KEY));
  else await db.run(db.k.insertInto("main.user_settings").values({ login, key: RUNNER_PRIVATE_KEY, value: "1", updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(kx.excluded(["value", "updated_at"]))));
  if (was !== on) await audit(db, login, "runner-private", login, { runnerPrivate: on });
  return on;
}

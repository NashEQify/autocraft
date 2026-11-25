// Whitelist overrides (M03 access-a).
import type { Db } from "../../db/index.ts";
import type { Login, Override, OverrideRow } from "./types.ts";

/** Overrides by lower-cased login; `"all"` is the explicit whole-table form. */
export async function loadOverrides(db: Db, logins: Login[] | "all"): Promise<Map<string, Override>> {
  throw new Error("not built: access.loadOverrides");
}

/** Every override, for the Contributors page. */
export async function listOverrides(db: Db): Promise<OverrideRow[]> {
  throw new Error("not built: access.listOverrides");
}

/** Deletes the same login in another case, upserts, audits; one `db.write`. */
export async function saveOverride(db: Db, row: { login: Login; status: string; githubId?: number | null; note?: string | null }, by: string): Promise<void> {
  throw new Error("not built: access.saveOverride");
}

/** Deletes and audits; one `db.write`. */
export async function clearOverride(db: Db, login: Login, by: string): Promise<void> {
  throw new Error("not built: access.clearOverride");
}

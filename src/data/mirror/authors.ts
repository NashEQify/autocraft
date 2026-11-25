// Author ids and permissions (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { AuthorHistory, AuthorPermissionRow, AuthorPermissionSave } from "./types.ts";

/** Bound GitHub account id per login. */
export async function loadAuthorIds(db: Db, logins: string[] | "all"): Promise<Map<string, number>> {
  throw new Error("not built: mirror.loadAuthorIds");
}

/** Insert `DO NOTHING`; one statement per 500 rows; returns the count bound. */
export async function bindAuthorIds(db: Db, rows: { login: string; id: number }[]): Promise<number> {
  throw new Error("not built: mirror.bindAuthorIds");
}

/** One `INSERT ... SELECT` from the oldest id-bearing item per unbound login. */
export async function bindKnownAuthorIds(db: Db): Promise<number> {
  throw new Error("not built: mirror.bindKnownAuthorIds");
}

/** The oldest merged or closed PR per unbound login. */
export async function loadUnboundLoginPrs(db: Db, logins?: string[]): Promise<{ login: string; repo: string; number: number }[]> {
  throw new Error("not built: mirror.loadUnboundLoginPrs");
}

/** Keyed "repo\nlogin". */
export async function loadAuthorPermissions(db: Db, o?: { repos?: string[]; logins?: string[] }): Promise<Map<string, AuthorPermissionRow>> {
  throw new Error("not built: mirror.loadAuthorPermissions");
}

/** Success rows upsert, failure rows increment; one `db.write`. */
export async function saveAuthorPermissions(db: Db, rows: AuthorPermissionSave[]): Promise<void> {
  throw new Error("not built: mirror.saveAuthorPermissions");
}

/** Merged, closed and open counts per login and account. */
export async function loadAuthorHistory(db: Db, o: { logins?: string[]; repo?: string }): Promise<AuthorHistory[]> {
  throw new Error("not built: mirror.loadAuthorHistory");
}

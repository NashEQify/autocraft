// The access list (M03 access-a).
import type { Db } from "../../db/index.ts";
import type { AccessRow, Login, RemovedSummary, Role } from "./types.ts";

/** Every access row ordered by login without case. */
export async function listAccess(db: Db): Promise<AccessRow[]> {
  throw new Error("not built: access.listAccess");
}

/** Access rows by lower-cased login. */
export async function loadAccess(db: Db, logins: readonly Login[]): Promise<Map<string, AccessRow>> {
  throw new Error("not built: access.loadAccess");
}

/** Logins holding one of the roles. */
export async function loginsWithRole(db: Db, roles: readonly Role[]): Promise<Login[]> {
  throw new Error("not built: access.loginsWithRole");
}

/** Number of operators. */
export async function countOperators(db: Db): Promise<number> {
  throw new Error("not built: access.countOperators");
}

/** Insert guarded by `on conflict do nothing` (no row changed means already on the list) and an audit row, in one `db.write`. */
export async function addLogin(db: Db, by: string, row: { login: Login; role: Role; note: string | null; githubId?: number | null }): Promise<void> {
  throw new Error("not built: access.addLogin");
}

/** Deletes the login and its permissions, sessions, tokens, user tokens, Discord links and codes, ends its setup links, audits; one `db.write`. `keepOperator` is read inside the transaction. */
export async function removeLogin(db: Db, by: string, login: Login, o?: { keepOperator?: boolean }): Promise<RemovedSummary> {
  throw new Error("not built: access.removeLogin");
}

/** Changes the role; a demotion also deletes cached permissions and sessions, ends answer tokens, drops user tokens and ends setup links; one `db.write`. */
export async function setRole(db: Db, by: string, login: Login, role: Role, o?: { keepOperator?: boolean }): Promise<boolean> {
  throw new Error("not built: access.setRole");
}

/** Compare-and-set of `github_id` where it is null; one read only when nothing changed. */
export async function bindGithubId(db: Db, login: Login, id: number): Promise<"ok" | "bound" | "mismatch"> {
  throw new Error("not built: access.bindGithubId");
}

/** The access row, only while it is bound to that GitHub id. */
export async function actorOf(db: Db, login: Login, githubId: number): Promise<AccessRow | null> {
  throw new Error("not built: access.actorOf");
}

/** The app bot login plus the box login from the settings snapshot, lower case. */
export async function loadOwnLogins(db: Db): Promise<Set<string>> {
  throw new Error("not built: access.loadOwnLogins");
}

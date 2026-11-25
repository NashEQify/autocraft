// Cached repo permissions and the act rule (M03 access-a).
import type { Db } from "../../db/index.ts";
import type { ActFacts, ActIdentity, ActRefusal, ActVerdict, Login, PermEntry, PermKey, PermRow } from "./types.ts";
import type { KeySource } from "../keys.ts";

export const WRITE_PERMISSIONS: readonly string[] = ["write", "maintain", "admin"];
export const PERM_READ_TTL = 10 * 60_000;
export const PERM_WRITE_TTL = 60_000;
/** A write permission older than this is read again, so it stays younger than `PERM_READ_TTL` while GitHub answers. */
export const REFRESH_AFTER = PERM_READ_TTL - 2 * 60_000;
/** How long after GitHub last confirmed it a write permission still counts while a re-read is under way or failed. */
export const HOLD_MAX = 60 * 60_000;

/** Cached permission per login and repo; one JSON-bound tuple lookup. */
export async function loadPermissions(db: Db, pairs: readonly { login: Login; repo: string }[]): Promise<Map<PermKey, PermEntry>> {
  throw new Error("not built: access.loadPermissions");
}

/** All cached rows of those logins. */
export async function loadPermissionsOfLogins(db: Db, logins: readonly Login[]): Promise<Map<string, PermRow[]>> {
  throw new Error("not built: access.loadPermissionsOfLogins");
}

/** One person, many repos (a session's visible repos). */
export async function loadPermissionsForRepos(db: Db, login: Login, repos: string[]): Promise<Map<string, PermEntry>> {
  throw new Error("not built: access.loadPermissionsForRepos");
}

/** Batched upsert, one statement. */
export async function savePermissions(db: Db, rows: { login: Login; repo: string; permission: string; checkedAt: string }[]): Promise<void> {
  throw new Error("not built: access.savePermissions");
}

/** Batched delete. */
export async function endPermissions(db: Db, logins: Login[]): Promise<number> {
  throw new Error("not built: access.endPermissions");
}

/** Cached rows below write permission, checked within `PERM_READ_TTL` (Task Runner claim snapshot). */
export async function loadPermissionDenials(db: Db, logins: Login[] | KeySource, nowMs: number): Promise<Map<PermKey, string>> {
  throw new Error("not built: access.loadPermissionDenials");
}

/** One LEFT JOIN of the pairs to `access` and `repo_permissions`; the only database read of the act rule. */
export async function loadActFacts(db: Db, pairs: { login: string | null; repo: string }[]): Promise<Map<PermKey, ActFacts>> {
  throw new Error("not built: access.loadActFacts");
}

/** The set form for the planner and bulk commands; never calls GitHub. `why: "stale"` tells the caller to re-read the permission. */
export async function canActMany(db: Db, pairs: { login: string | null; repo: string }[], o: { identity: ActIdentity; mode: "cached"; maxAgeMs: number; now?: number; held?: ReadonlySet<PermKey> }): Promise<Map<PermKey, ActVerdict>> {
  throw new Error("not built: access.canActMany");
}

/** The request form, in the order of today's `actRefusal`: login, role, the live write check, then the identity. */
export async function canAct(db: Db, actor: { login: string | null; canWrite(repo: string): Promise<boolean> }, repo: string, o: { identity: ActIdentity }): Promise<ActRefusal | null> {
  throw new Error("not built: access.canAct");
}

/** Whether the permission is write or better. */
export function isWrite(permission: string | null | undefined): boolean {
  throw new Error("not built: access.isWrite");
}

/** Whether a cached write permission is young enough. */
export function freshWrite(row: PermEntry | null | undefined, maxAgeMs: number, now: number, held?: boolean): boolean {
  throw new Error("not built: access.freshWrite");
}

/** The act rule over loaded facts. */
export function decideAct(facts: ActFacts, write: "yes" | "no" | "unknown" | "cached", identity: ActIdentity): ActVerdict {
  throw new Error("not built: access.decideAct");
}

// Sessions and OAuth states (M04 access-b).
import type { Db } from "../../db/index.ts";
import type { AdminSession, NewOauthState, NewSession, OauthState, Sealed, SessionRow } from "./types.ts";

/** Inserts a session. */
export async function addSession(db: Db, row: NewSession): Promise<void> {
  throw new Error("not built: access.addSession");
}

/** Joins `access` for the live role; deletes an over-age session; touches `last_seen` and `expires_at` when older than 60 s. */
export async function loadSession(db: Db, idHash: string, o?: { now?: number }): Promise<SessionRow | null> {
  throw new Error("not built: access.loadSession");
}

/** The sealed tokens of a session. */
export async function loadSessionSealed(db: Db, idHash: string): Promise<{ sealed: Sealed | null; login: string } | null> {
  throw new Error("not built: access.loadSessionSealed");
}

/** Replaces the sealed tokens. */
export async function saveSessionTokens(db: Db, idHash: string, sealed: Sealed): Promise<void> {
  throw new Error("not built: access.saveSessionTokens");
}

/** Newest first, with sealed tokens. */
export async function loadLiveSessionsOf(db: Db, login: string): Promise<SessionRow[]> {
  throw new Error("not built: access.loadLiveSessionsOf");
}

/** Joined to `access.role`, for the Access page. */
export async function listSessions(db: Db, now: number): Promise<AdminSession[]> {
  throw new Error("not built: access.listSessions");
}

/** Deletes one session. */
export async function endSession(db: Db, idHash: string): Promise<void> {
  throw new Error("not built: access.endSession");
}

/** Admin revoke: delete returning. */
export async function endSessionById(db: Db, rowid: number): Promise<{ idHash: string; login: string; createdAt: string; sealed: Sealed | null } | null> {
  throw new Error("not built: access.endSessionById");
}

/** Identity switch. */
export async function endAllSessions(db: Db): Promise<number> {
  throw new Error("not built: access.endAllSessions");
}

/** Deletes expired sessions and OAuth states; one `db.write`. */
export async function pruneExpired(db: Db, now: number): Promise<void> {
  throw new Error("not built: access.pruneExpired");
}

/** Inserts a state. */
export async function addOauthState(db: Db, row: NewOauthState): Promise<void> {
  throw new Error("not built: access.addOauthState");
}

/** `DELETE ... RETURNING` when the cookie matches, a plain read when not (the row stays). */
export async function takeOauthState(db: Db, state: string, o: { cookieMatches: boolean }): Promise<OauthState | null> {
  throw new Error("not built: access.takeOauthState");
}

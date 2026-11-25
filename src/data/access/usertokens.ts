// Per-login GitHub App user tokens, revocations, reseal and reporter tokens (M04 access-b).
import type { Db } from "../../db/index.ts";
import type { Login, ReporterSealed, RevocationRow, Sealed, SealedRow, SealedStore, UserTokenSealed, UserTokenStatus } from "./types.ts";

/** Upsert with `version + 1`. */
export async function saveUserToken(db: Db, row: { login: Login; githubId: number; sealed: Sealed; now: string }): Promise<void> {
  throw new Error("not built: access.saveUserToken");
}

/** Any status. */
export async function loadUserTokenSealed(db: Db, login: Login): Promise<UserTokenSealed | null> {
  throw new Error("not built: access.loadUserTokenSealed");
}

/** Set loader for the Access page and the user lane's token wait. */
export async function loadUserTokenStatus(db: Db, logins: Login[]): Promise<Map<string, UserTokenStatus>> {
  throw new Error("not built: access.loadUserTokenStatus");
}

/** Compare-and-set on `version`. */
export async function swapUserToken(db: Db, login: Login, version: number, sealed: Sealed, now: string): Promise<boolean> {
  throw new Error("not built: access.swapUserToken");
}

/** Marks a refresh failure, compare-and-set on `version`. */
export async function failUserToken(db: Db, login: Login, version: number, now: string): Promise<boolean> {
  throw new Error("not built: access.failUserToken");
}

/** Deletes the rows returning them, then queues `grant` revocations; one `db.write`. */
export async function dropUserTokens(db: Db, logins: Login[]): Promise<number> {
  throw new Error("not built: access.dropUserTokens");
}

/** Identity switch and app removal. */
export async function dropAllUserTokens(db: Db): Promise<number> {
  throw new Error("not built: access.dropAllUserTokens");
}

/** Batched insert. */
export async function queueSessionTokenRevocation(db: Db, rows: { login: Login; sealed: Sealed; aad: string; now: string }[]): Promise<void> {
  throw new Error("not built: access.queueSessionTokenRevocation");
}

/** Queued revocations. */
export async function loadRevocations(db: Db, o: { freshOnly: boolean }): Promise<RevocationRow[]> {
  throw new Error("not built: access.loadRevocations");
}

/** `LIMIT 1` probe run on every request. */
export async function hasFreshRevocation(db: Db): Promise<boolean> {
  throw new Error("not built: access.hasFreshRevocation");
}

/** Compare-and-set on `attempts` (one per row, an effect guard). */
export async function claimRevocation(db: Db, id: number, attempts: number): Promise<boolean> {
  throw new Error("not built: access.claimRevocation");
}

/** Batched delete. */
export async function finishRevocations(db: Db, ids: number[]): Promise<void> {
  throw new Error("not built: access.finishRevocations");
}

/** Sealed tokens of a login's sessions (`shareRefresh`). */
export async function loadSessionSealedOf(db: Db, login: Login): Promise<{ idHash: string; sealed: Sealed }[]> {
  throw new Error("not built: access.loadSessionSealedOf");
}

/** Batched compare-and-set update; only a row still holding `old` changes. */
export async function swapSessionTokens(db: Db, rows: { idHash: string; old: Sealed; sealed: Sealed }[]): Promise<number> {
  throw new Error("not built: access.swapSessionTokens");
}

/** The vault deletes the login's row only when it holds the same sign-in. */
export async function deleteUserTokenIf(db: Db, login: Login, sealedMatch: Sealed): Promise<void> {
  throw new Error("not built: access.deleteUserTokenIf");
}

/** Rows of the four sealed stores in one wave. */
export async function listSealedRows(db: Db): Promise<SealedRow[]> {
  throw new Error("not built: access.listSealedRows");
}

/** One compare-and-set update per store; one `db.write`. */
export async function swapSealedRows(db: Db, rows: { store: SealedStore; id: number | string; old: Sealed; sealed: Sealed }[]): Promise<Record<SealedStore, number>> {
  throw new Error("not built: access.swapSealedRows");
}

/** Upsert that queues the replaced token's revocation; one `db.write`. */
export async function saveReporter(db: Db, row: { reporter: string; githubId: number; login: Login; sealed: Sealed; now: string }): Promise<void> {
  throw new Error("not built: access.saveReporter");
}

/** One reporter token. */
export async function loadReporterSealed(db: Db, reporter: string): Promise<ReporterSealed | null> {
  throw new Error("not built: access.loadReporterSealed");
}

/** Compare-and-set on `version`. */
export async function swapReporter(db: Db, reporter: string, version: number, sealed: Sealed, now: string): Promise<boolean> {
  throw new Error("not built: access.swapReporter");
}

/** Marks a refresh failure. */
export async function failReporter(db: Db, reporter: string, version: number, now: string): Promise<boolean> {
  throw new Error("not built: access.failReporter");
}

/** Insert, also deleting expired rows; one `db.write`. */
export async function addReporterState(db: Db, row: { stateHash: string; reporter: string; verifier: string; expiresAt: string }): Promise<void> {
  throw new Error("not built: access.addReporterState");
}

/** Reads a state without taking it. */
export async function peekReporterState(db: Db, stateHash: string, now: string): Promise<{ reporter: string; verifier: string } | null> {
  throw new Error("not built: access.peekReporterState");
}

/** Delete returning. */
export async function takeReporterState(db: Db, stateHash: string, now: string): Promise<{ reporter: string; verifier: string } | null> {
  throw new Error("not built: access.takeReporterState");
}

/** Deletes states and token, queues the revocation; one `db.write`. */
export async function forgetReporterTokens(db: Db, reporter: string, now: string): Promise<boolean> {
  throw new Error("not built: access.forgetReporterTokens");
}

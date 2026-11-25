// The GitHub App row, its states, setup links and allowed owners (M04 access-b).
import type { Db } from "../../db/index.ts";
import type { AllowedOwner, AppInstallFacts, AppSealed, AppState, Login, Sealed, SetupLink } from "./types.ts";

/** The stored App with its sealed keys. */
export async function loadAppSealed(db: Db): Promise<AppSealed | null> {
  throw new Error("not built: access.loadAppSealed");
}

/** Whether an App row exists. */
export async function hasStoredApp(db: Db): Promise<boolean> {
  throw new Error("not built: access.hasStoredApp");
}

/** The app bot login, read by process entry points so `src/db/open.ts` reads no domain table. */
export async function loadGithubAppLogin(db: Db): Promise<string | null> {
  throw new Error("not built: access.loadGithubAppLogin");
}

/** Read model for the identity health checks; two statements in one wave. */
export async function loadAppInstallFacts(db: Db): Promise<AppInstallFacts> {
  throw new Error("not built: access.loadAppInstallFacts");
}

/** Inserts the App when none is stored. */
export async function importAppIfAbsent(db: Db, row: { appId: number; slug: string; sealed: Sealed }): Promise<boolean> {
  throw new Error("not built: access.importAppIfAbsent");
}

/** Compare-and-set on `keys_enc`. */
export async function saveApp(db: Db, row: { appId: number; slug: string; sealed: Sealed }, o: { replaceUnreadable: Sealed | null }): Promise<boolean> {
  throw new Error("not built: access.saveApp");
}

/** Deletes the App row. */
export async function clearApp(db: Db): Promise<void> {
  throw new Error("not built: access.clearApp");
}

/** Replaces the sealed webhook secret. */
export async function swapAppWebhook(db: Db, appId: number, sealed: Sealed): Promise<boolean> {
  throw new Error("not built: access.swapAppWebhook");
}

/** Deletes stale or same-tag rows then inserts; one `db.write`. */
export async function addAppState(db: Db, row: { state: string; login: Login; sessionHash: string; createdAt: string }, o: { expireBefore: string; replaceTag?: string }): Promise<void> {
  throw new Error("not built: access.addAppState");
}

/** Reads a state. */
export async function loadAppState(db: Db, state: string): Promise<AppState | null> {
  throw new Error("not built: access.loadAppState");
}

/** `DELETE ... RETURNING`. */
export async function takeAppState(db: Db, state: string): Promise<AppState | null> {
  throw new Error("not built: access.takeAppState");
}

/** Deletes every state. */
export async function clearAppStates(db: Db): Promise<void> {
  throw new Error("not built: access.clearAppStates");
}

/** Inserts a setup link. */
export async function createSetupLink(db: Db, row: Omit<SetupLink, "id" | "used_at" | "installation_id">): Promise<void> {
  throw new Error("not built: access.createSetupLink");
}

/** `UPDATE ... RETURNING org`. */
export async function revokeSetupLink(db: Db, id: number): Promise<{ org: string | null } | null> {
  throw new Error("not built: access.revokeSetupLink");
}

/** Open links whose creator is still an operator. */
export async function listOpenSetupLinks(db: Db, now: string): Promise<SetupLink[]> {
  throw new Error("not built: access.listOpenSetupLinks");
}

/** One open link. */
export async function loadOpenSetupLink(db: Db, by: { id: number } | { hash: string }, now: string): Promise<SetupLink | null> {
  throw new Error("not built: access.loadOpenSetupLink");
}

/** Marks a link used. */
export async function useSetupLink(db: Db, id: number, by: Login, installationId: number, now: string): Promise<boolean> {
  throw new Error("not built: access.useSetupLink");
}

/** Ends a person's open links. */
export async function endSetupLinksOf(db: Db, login: Login, now: string): Promise<number> {
  throw new Error("not built: access.endSetupLinksOf");
}

/** Every allowed owner. */
export async function listAllowedOwners(db: Db): Promise<AllowedOwner[]> {
  throw new Error("not built: access.listAllowedOwners");
}

/** Batched insert on conflict do nothing, returning the inserted rows; the caller audits them. */
export async function addAllowedOwners(db: Db, rows: { login: string; accountId?: number | null }[], by: string): Promise<{ inserted: AllowedOwner[] }> {
  throw new Error("not built: access.addAllowedOwners");
}

/** Deletes one owner. */
export async function removeAllowedOwner(db: Db, login: string): Promise<void> {
  throw new Error("not built: access.removeAllowedOwner");
}

/** Fills ids of rows whose `account_id` is null. */
export async function setAllowedOwnerAccounts(db: Db, rows: { login: string; accountId: number }[]): Promise<void> {
  throw new Error("not built: access.setAllowedOwnerAccounts");
}

/** Renames an owner. */
export async function renameAllowedOwner(db: Db, from: string, inst: string): Promise<void> {
  throw new Error("not built: access.renameAllowedOwner");
}

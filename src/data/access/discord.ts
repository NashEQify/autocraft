// Discord links and link codes (M03 access-a).
import type { Db } from "../../db/index.ts";
import type { LinkRow, Login } from "./types.ts";

/** Drops the login's earlier and expired codes, inserts the new one; one `db.write`. */
export async function makeLinkCode(db: Db, row: { codeHash: string; login: Login; expiresAt: string }, now: string): Promise<void> {
  throw new Error("not built: access.makeLinkCode");
}

/** Deletes the code returning it, upserts the link when unexpired; one `db.write`. */
export async function redeemLinkCode(db: Db, codeHash: string, userHash: string, now: string): Promise<Login | null> {
  throw new Error("not built: access.redeemLinkCode");
}

/** Login per Discord user hash. */
export async function loginsOfLinks(db: Db, userHashes: string[]): Promise<Map<string, Login>> {
  throw new Error("not built: access.loginsOfLinks");
}

/** Every link. */
export async function listLinks(db: Db): Promise<LinkRow[]> {
  throw new Error("not built: access.listLinks");
}

/** Earliest link time per login. */
export async function linkedSince(db: Db, logins: Login[]): Promise<Map<string, string>> {
  throw new Error("not built: access.linkedSince");
}

/** Deletes links. */
export async function unlinkLogins(db: Db, logins: Login[]): Promise<number> {
  throw new Error("not built: access.unlinkLogins");
}

/** `DELETE ... RETURNING login`. */
export async function unlinkRow(db: Db, userHash: string): Promise<Login | null> {
  throw new Error("not built: access.unlinkRow");
}

/** Batched delete. */
export async function forgetLinks(db: Db, userHashes: string[]): Promise<number> {
  throw new Error("not built: access.forgetLinks");
}

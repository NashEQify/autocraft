// user_tokens: the GitHub App user token of each login, written at every
// sign-in while the GitHub identity is the app. It holds the sealed JSON of
// the whole token set, like sessions.token_enc, but is keyed by login so the
// act stage can act for a login without a live session. The vault
// (src/github/vault.ts) refreshes it.
import type { TokenBox } from "./crypto.ts";
import type { Tokens } from "./provider.ts";
import type { Db } from "../../db/index.ts";

const aad = (login: string): string => `user_tokens:${login.toLowerCase()}`;

export async function saveUserTokens(db: Db, box: TokenBox, login: string, githubId: number, tokens: Tokens): Promise<void> {
  await db.run(db.k.insertInto("user_tokens")
    .values({ login, github_id: githubId, token_enc: box.seal(JSON.stringify(tokens), aad(login)), version: 1, updated_at: new Date().toISOString(), status: "ok" })
    .onConflict((oc) => oc.column("login").doUpdateSet((eb) => ({
      github_id: eb.ref("excluded.github_id"), token_enc: eb.ref("excluded.token_enc"), version: eb("user_tokens.version", "+", 1),
      updated_at: eb.ref("excluded.updated_at"), status: "ok",
    }))));
}

export async function loadUserTokens(db: Db, box: TokenBox, login: string): Promise<Tokens | null> {
  const row = await db.get(db.k.selectFrom("user_tokens").select("token_enc").where("login", "=", login).where("status", "=", "ok"));
  const plain = row ? box.open(row.token_enc, aad(login)) : null;
  try {
    return plain ? (JSON.parse(plain) as Tokens) : null;
  } catch {
    return null;
  }
}

/** The login's row with its opened tokens, whatever its status (null tokens: unreadable). */
export async function readUserTokens(db: Db, box: TokenBox, login: string): Promise<{ tokens: Tokens | null; version: number; status: string } | null> {
  const row = await db.get(db.k.selectFrom("user_tokens").select(["token_enc", "version", "status"]).where("login", "=", login));
  if (!row) return null;
  const plain = box.open(row.token_enc, aad(login));
  let tokens: Tokens | null = null;
  try {
    tokens = plain ? (JSON.parse(plain) as Tokens) : null;
  } catch { /* unreadable: the caller treats it as no token */ }
  return { tokens, version: Number(row.version), status: row.status };
}

/**
 * Stores a refreshed pair if the row still has `version` (compare-and-swap: a refresh in another process or a new
 * sign-in may have written first). Returns false when it lost.
 */
export async function swapUserTokens(db: Db, box: TokenBox, login: string, version: number, tokens: Tokens): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("user_tokens")
    .set((eb) => ({ token_enc: box.seal(JSON.stringify(tokens), aad(login)), version: eb("version", "+", 1), updated_at: new Date().toISOString(), status: "ok" }))
    .where("login", "=", login).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/** Marks the row as needing a new sign-in, if it still has `version`. Returns false when it lost. */
export async function failUserTokens(db: Db, login: string, version: number): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("user_tokens")
    .set((eb) => ({ status: "refresh-failed", version: eb("version", "+", 1), updated_at: new Date().toISOString() }))
    .where("login", "=", login).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/**
 * Deletes the login's row because its access was removed (a removed login, a role change) and queues its whole GitHub
 * authorization for revocation; the dashboard's vault does that later. Returns whether a row existed.
 * Not for ending one session: that is dropSessionTokens.
 */
export async function dropUserTokens(db: Db, login: string): Promise<boolean> {
  const row = await db.get(db.k.deleteFrom("user_tokens").where("login", "=", login).returning("token_enc"));
  if (!row) return false;
  await db.run(db.k.insertInto("user_token_revocations").values({ login, token_enc: row.token_enc, queued_at: new Date().toISOString(), kind: "grant" }));
  return true;
}

/**
 * Ends one session's GitHub App token: queues that token alone for revocation, so the login's other sign-ins keep their
 * tokens and the authorization stays. The vault's sweep also deletes the login's user_tokens row once the revoke
 * succeeds, but only when the row holds that same token set (it was written by the same sign-in).
 */
export async function dropSessionTokens(db: Db, login: string, idHash: string, tokenEnc: string | null): Promise<boolean> {
  if (!tokenEnc) return false;
  await db.run(db.k.insertInto("user_token_revocations").values({ login, token_enc: tokenEnc, queued_at: new Date().toISOString(), kind: "token", aad: idHash }));
  return true;
}

export const revocationAad = aad;

/**
 * A refresh consumed `oldRefresh` (GitHub refresh tokens are single use), so every stored copy of that token set must
 * take the new pair: the login's user_tokens row and each of its sessions that holds the same refresh token. Copies
 * with another refresh token come from another sign-in and are left alone. The sessions keep running.
 */
export async function shareRefresh(db: Db, box: TokenBox, login: string, oldRefresh: string, next: Tokens): Promise<void> {
  const u = await readUserTokens(db, box, login);
  if (u?.status === "ok" && u.tokens?.refresh === oldRefresh) await swapUserTokens(db, box, login, u.version, next);
  const sessions = await db.all(db.k.selectFrom("sessions").select(["id_hash", "token_enc"]).$narrowType<{ token_enc: string }>().where("login", "=", login).where("token_enc", "is not", null));
  for (const s of sessions) {
    const plain = box.open(s.token_enc, s.id_hash);
    let t: Tokens | null = null;
    try {
      t = plain ? (JSON.parse(plain) as Tokens) : null;
    } catch { /* unreadable: leave it */ }
    if (t?.refresh === oldRefresh) await db.run(db.k.updateTable("sessions").set({ token_enc: box.seal(JSON.stringify(next), s.id_hash) }).where("id_hash", "=", s.id_hash).where("token_enc", "=", s.token_enc));
  }
}

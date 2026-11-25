// The user-token vault: a usable GitHub App access token for a login, for the dashboard and the runner process alike
// (both open the same database and derive the same TokenBox from the secrets file's session_key).
//
// Refreshes run through refreshShared (src/dash/server/token-refresh.ts): one at a time per login across every process,
// with the row and the login's sessions written together, and a newer copy healing a refused one. There is never a
// fallback to another identity: a final failure answers "needs sign-in".
import { envVar } from "../env.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import { resealLegacyValues } from "../dash/server/reseal.ts";
import { readSecrets } from "../dash/server/config.ts";
import { openAppKeys } from "./app-keys.ts";
import { GitHubProvider, RevokeRefused, type Provider, type Tokens } from "../dash/server/provider.ts";
import { readUserTokens, revocationAad } from "../dash/server/user-tokens.ts";
import { refreshShared, usableAccess } from "../dash/server/token-refresh.ts";
import { githubIdentity } from "./identity.ts";
import type { Db } from "../db/index.ts";

export type NeedsSignIn = { ok: false; needsSignIn: true; why: "no-token" | "refresh-failed" | "expired" };
/** A transient failure (GitHub unreachable): try again later, the token set is untouched. */
export type Unavailable = { ok: false; needsSignIn: false };
export type UserTokenResult = { ok: true; access: string } | NeedsSignIn | Unavailable;

const EXPIRY_MARGIN = 60_000;
const MAX_REVOKE_ATTEMPTS = 5;

export class Vault {
  #db: Db;
  #box: TokenBox;
  #providerOf: () => Provider;
  get #provider(): Provider { return this.#providerOf(); }
  #sweeping = false;
  #inflight = new Map<string, Promise<UserTokenResult>>();

  /** `provider` may be a function, read at each use, so the GitHub App's registration can change while the vault lives. */
  constructor(db: Db, box: TokenBox, provider: Provider | (() => Provider)) {
    this.#db = db;
    this.#box = box;
    this.#providerOf = typeof provider === "function" ? provider : () => provider;
  }

  /** A usable access token for `login`, refreshed when it is within a minute of expiry or `rejected` (a token GitHub answered 401 to). */
  userToken(login: string, rejected?: string): Promise<UserTokenResult> {
    const key = login.toLowerCase();
    let p = this.#inflight.get(key);
    if (!p) {
      // Fresh reads: #obtain reads the row again until another process's new pair lands.
      p = this.#db.fresh(() => this.#obtain(login, rejected)).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    return p;
  }

  async #obtain(login: string, rejected: string | undefined): Promise<UserTokenResult> {
    const row = await readUserTokens(this.#db, this.#box, login);
    if (!row?.tokens) return { ok: false, needsSignIn: true, why: "no-token" };
    if (row.status === "ok" && usableAccess(row.tokens, rejected)) return { ok: true, access: row.tokens.access };
    // Under the app identity the sessions hold tokens of the same app, so they share refreshes with the row and may heal it.
    const heal = await githubIdentity(this.#db) === "app";
    if (row.status !== "ok" && (!heal || !await this.#db.get(this.#db.k.selectFrom("sessions").select("id_hash").where("login", "=", login).where("token_enc", "is not", null)))) {
      return { ok: false, needsSignIn: true, why: "refresh-failed" };
    }
    const r = await refreshShared(this.#db, this.#box, this.#provider, login, { kind: "user" }, { rejected, heal });
    if (r.ok) return { ok: true, access: r.tokens.access };
    return r.transient ? { ok: false, needsSignIn: false } : { ok: false, needsSignIn: true, why: r.why };
  }

  /**
   * Works through the revocation queue (a removed login's whole grant, or one revoked session's token). A row stays
   * until GitHub confirms the revoke. An expired stored access token, or a 404/422 answer, is retried once with a
   * freshly refreshed token. After MAX_REVOKE_ATTEMPTS failed sweeps the row is dropped. `fresh` handles only rows
   * not tried yet. Returns the number of rows handled.
   */
  async sweepRevocations(fresh = false): Promise<number> {
    if (this.#sweeping) return 0;
    this.#sweeping = true;
    try {
      const rows = await this.#db.all(this.#db.k.selectFrom("user_token_revocations")
        .select(["id", "login", "token_enc", "kind", "aad", "attempts"])
        .$if(fresh, (q) => q.where("attempts", "=", 0)).orderBy("id"));
      for (const r of rows) {
        // Claim the attempt first: a concurrent sweep (another process) that read the same row changes nothing here and skips it.
        if ((await this.#db.run(this.#db.k.updateTable("user_token_revocations").set((eb) => ({ attempts: eb("attempts", "+", 1) }))
          .where("id", "=", r.id).where("attempts", "=", r.attempts))).changes !== 1) continue;
        let done = false;
        try {
          done = await this.#revokeRow(r);
        } catch (e) {
          console.error(`revocation for ${r.login}: ${(e as Error).message}`);
        }
        if (done) {
          await this.#db.run(this.#db.k.deleteFrom("user_token_revocations").where("id", "=", r.id));
        } else if (r.attempts + 1 >= MAX_REVOKE_ATTEMPTS) {
          console.error(`revocation for ${r.login}: given up after ${r.attempts + 1} failed attempts`);
          await this.#db.run(this.#db.k.deleteFrom("user_token_revocations").where("id", "=", r.id));
        }
      }
      return rows.length;
    } finally {
      this.#sweeping = false;
    }
  }

  /** True once GitHub confirmed the revoke (or there is nothing left to revoke: an unreadable row). */
  async #revokeRow(r: { login: string; token_enc: string; kind: string; aad: string | null }): Promise<boolean> {
    const plain = this.#box.open(r.token_enc, r.aad ?? revocationAad(r.login));
    let t: Tokens | null = null;
    try {
      t = plain ? (JSON.parse(plain) as Tokens) : null;
    } catch { /* unreadable */ }
    if (!t) return true;
    const revoke = (access: string): Promise<void> => (r.kind === "token" ? this.#provider.revoke(access) : this.#provider.revokeGrant(access));
    // The login's user_tokens row written by the same sign-in holds this very token set and dies with it.
    const own = r.kind === "token" ? await readUserTokens(this.#db, this.#box, r.login) : null;
    const sameSignIn = !!own?.tokens && (own.tokens.access === t.access || (!!t.refresh && own.tokens.refresh === t.refresh));
    const refreshed = async (): Promise<string | null> => {
      if (!t.refresh || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= Date.now())) return null;
      const next = await this.#provider.refresh(t.refresh);
      return "refused" in next ? null : next.access;
    };
    let ok = false;
    const expired = t.expiresAt !== null && t.expiresAt - EXPIRY_MARGIN <= Date.now();
    if (!expired) {
      try {
        await revoke(t.access);
        ok = true;
      } catch (e) {
        if (!(e instanceof RevokeRefused) || (e.status !== 404 && e.status !== 422)) throw e;
      }
    }
    if (!ok) {
      const access = await refreshed();
      if (!access) return false;
      await revoke(access);
    }
    if (sameSignIn) await this.#db.run(this.#db.k.deleteFrom("user_tokens").where("login", "=", r.login));
    return true;
  }
}

/** The runner's vault: the app's client credentials from the process's app-key store and the session key from the secrets file, as the dashboard reads them. Null without a registered app. */
export async function openVault(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Vault | null> {
  const secrets = readSecrets(envVar("SECRETS_FILE", env));
  const keys = await openAppKeys(db, env);
  const app = keys?.current() ?? null;
  if (!keys || !app) return null;
  const box = new TokenBox(secrets.sessionKey);
  // The runner may start before the dashboard has re-sealed values under the current key.
  await resealLegacyValues(db, box);
  return new Vault(db, box, () => {
    const now = keys.current() ?? app;
    return new GitHubProvider(now.clientId, now.clientSecret);
  });
}

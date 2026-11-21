import type { Role, User } from "../types.ts";
import { randomToken, sha256hex, type TokenBox } from "./crypto.ts";
import { shareRefresh } from "./user-tokens.ts";
import { REPO_NAME, WRITE_PERMISSIONS, type Provider, type Tokens } from "./provider.ts";
import type { Db } from "../../db/index.ts";

const DAY = 86_400_000;
export const SESSION_TTL = 14 * DAY;
// A session also ends this long after sign-in however active it is; operators'
// sessions are shorter.
export const SESSION_MAX = 30 * DAY;
export const OPERATOR_SESSION_MAX = 7 * DAY;
const TOUCH_EVERY = 60_000;
export const PERM_READ_TTL = 10 * 60_000;
export const PERM_WRITE_TTL = 60_000;

export type Session = {
  rowid: number;
  idHash: string;
  login: string;
  role: Role;
  csrf: string;
  tokenEnc: string | null;
};

// sessions.token_enc holds the sealed JSON of the whole Tokens set, so the
// refresh token and expiry times are encrypted the same way as the access token.
export const sealTokens = (box: TokenBox, t: Tokens, idHash: string): string => box.seal(JSON.stringify(t), idHash);

export function openTokens(box: TokenBox, sealed: string | null, idHash: string): Tokens | null {
  const plain = sealed ? box.open(sealed, idHash) : null;
  if (!plain) return null;
  try {
    return JSON.parse(plain) as Tokens;
  } catch {
    return null;
  }
}

export async function createSession(db: Db, box: TokenBox, login: string, tokens: Tokens, userAgent: string | undefined): Promise<string> {
  const id = randomToken(32);
  const idHash = sha256hex(id);
  const now = new Date();
  await db.prepare(`INSERT INTO sessions (id_hash, login, csrf, token_enc, created_at, last_seen, expires_at, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(idHash, login, randomToken(32), sealTokens(box, tokens, idHash), now.toISOString(), now.toISOString(),
      new Date(now.getTime() + SESSION_TTL).toISOString(), (userAgent ?? "").slice(0, 300) || null);
  return id;
}

/** The time a session made at `createdAt` ends at the latest, whatever its activity. */
export const sessionEndsAt = (createdAt: string, role: Role): number => Date.parse(createdAt) + (role === "operator" ? OPERATOR_SESSION_MAX : SESSION_MAX);

// A session counts only while its login is still on the access list; the
// role comes from the list, not the session, so it is always current.
export async function loadSession(db: Db, id: string | undefined): Promise<Session | null> {
  if (!id || id.length > 100) return null;
  const idHash = sha256hex(id);
  const row = await db.prepare(`SELECT s.rowid, s.login, s.csrf, s.token_enc, s.last_seen, s.created_at, a.role
                          FROM sessions s JOIN access a ON a.login = s.login
                          WHERE s.id_hash = ? AND s.expires_at > ?`)
    .get(idHash, new Date().toISOString()) as
    { rowid: number; login: string; csrf: string; token_enc: string | null; last_seen: string; created_at: string; role: Role } | undefined;
  if (!row) return null;
  const now = Date.now();
  const endsAt = sessionEndsAt(row.created_at, row.role);
  if (!(now < endsAt)) {
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return null;
  }
  if (now - Date.parse(row.last_seen) > TOUCH_EVERY) {
    await db.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?")
      .run(new Date(now).toISOString(), new Date(Math.min(now + SESSION_TTL, endsAt)).toISOString(), idHash);
  }
  return { rowid: Number(row.rowid), idHash, login: row.login, role: row.role, csrf: row.csrf, tokenEnc: row.token_enc };
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256hex(id));
}

export async function pruneExpired(db: Db): Promise<void> {
  const now = new Date();
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?").run(now.toISOString(), new Date(now.getTime() - SESSION_MAX).toISOString());
  await db.prepare("DELETE FROM oauth_states WHERE created_at <= ?").run(new Date(now.getTime() - 600_000).toISOString());
}

// One refresh per session at a time: GitHub refresh tokens are single use, so
// two concurrent refreshes would end the session.
const refreshing = new Map<string, Promise<string | null | undefined>>();
const EXPIRY_MARGIN = 60_000;

// Returns a usable access token: null when the session can no longer get one
// (and has been ended), undefined after a transient failure.
async function accessToken(db: Db, box: TokenBox, provider: Provider, idHash: string, mirror: boolean, rejected?: string): Promise<string | null | undefined> {
  const row = await db.prepare("SELECT token_enc, login FROM sessions WHERE id_hash = ?").get(idHash) as { token_enc: string | null; login: string } | undefined;
  if (!row) return null;
  const t = openTokens(box, row.token_enc, idHash);
  if (!t) return null;
  const fresh = t.access !== rejected && (t.expiresAt === null || t.expiresAt - EXPIRY_MARGIN > Date.now());
  if (fresh) return t.access;
  let p = refreshing.get(idHash);
  if (!p) {
    p = (async () => {
      const end = async () => {
        await db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
        return null;
      };
      if (!t.refresh || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= Date.now())) return await end();
      let next: Tokens | null;
      try {
        next = await provider.refresh(t.refresh);
      } catch (e) {
        console.error(`token refresh: ${(e as Error).message}`);
        return undefined;
      }
      if (!next) {
        // The vault (another process) may have used this single-use refresh token first and stored the new pair here.
        for (let i = 0; i < 4; i++) {
          const again = await db.prepare("SELECT token_enc FROM sessions WHERE id_hash = ?").get(idHash) as { token_enc: string | null } | undefined;
          const shared = again ? openTokens(box, again.token_enc, idHash) : null;
          if (shared && shared.refresh !== t.refresh) return shared.access;
          if (!mirror) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        return await end();
      }
      await db.prepare("UPDATE sessions SET token_enc = ? WHERE id_hash = ?").run(sealTokens(box, next, idHash), idHash);
      // The old refresh token is dead now, so every other copy of it (user_tokens, sessions of the same sign-in) takes the new pair.
      if (mirror) await shareRefresh(db, box, row.login, t.refresh, next);
      return next.access;
    })().finally(() => refreshing.delete(idHash));
    refreshing.set(idHash, p);
  }
  return p;
}

/**
 * The User an agent token stands for (src/dash/mcp/). A token carries no GitHub token of its own, so permission checks
 * use the login's newest live dashboard session, as that session's own requests would. Without one, only a cached
 * permission young enough for the request counts, and anything else reads as no permission: the repo is hidden
 * unless public, and a pick is shown as `none`.
 */
export async function userForLogin(db: Db, box: TokenBox, provider: Provider, login: string, role: Role, forWrite: boolean): Promise<User> {
  const s = (await db.prepare(`SELECT rowid, id_hash, login, csrf, token_enc, created_at FROM sessions WHERE login = ? AND expires_at > ? AND token_enc IS NOT NULL
    ORDER BY created_at DESC`).all(login, new Date().toISOString()) as { rowid: number; id_hash: string; login: string; csrf: string; token_enc: string; created_at: string }[])
    .find((x) => Date.now() < sessionEndsAt(x.created_at, role));
  if (s) return makeUser(db, box, provider, { rowid: Number(s.rowid), idHash: s.id_hash, login: s.login, role, csrf: s.csrf, tokenEnc: s.token_enc }, forWrite);
  const cached = async (repo: string): Promise<string | null> => {
    const row = await db.prepare("SELECT permission, checked_at FROM repo_permissions WHERE login = ? AND repo = ?").get(login, repo) as { permission: string; checked_at: string } | undefined;
    return row && Date.now() - Date.parse(row.checked_at) < (forWrite ? PERM_WRITE_TTL : PERM_READ_TTL) ? row.permission : null;
  };
  return {
    login, role,
    canWrite: async (repo) => WRITE_PERMISSIONS.has(await cached(repo) ?? ""),
    canRead: async (repo) => { const p = await cached(repo); return p !== null && p !== "none"; },
    permissionError: async (repo) => await cached(repo) === null ? `${login} has no live dashboard session to read the permission on ${repo} from GitHub` : null,
  };
}

/** Whether `login` had write permission on `repo` at its last successful check, made less than `maxAgeMs` ago. */
export async function cachedWrite(db: Db, login: string, repo: string, maxAgeMs: number): Promise<boolean> {
  const row = await db.prepare("SELECT permission, checked_at FROM repo_permissions WHERE login = ? AND repo = ?").get(login, repo) as { permission: string; checked_at: string } | undefined;
  return !!row && WRITE_PERMISSIONS.has(row.permission) && Date.now() - Date.parse(row.checked_at) < maxAgeMs;
}

// `forWrite` is true on POST requests: a handler that calls canWrite there is
// about to write, so the cached permission must be at most a minute old.
export function makeUser(db: Db, box: TokenBox, provider: Provider, s: Session, forWrite: boolean, mirrorUserTokens = false): User {
  const memo = new Map<string, Promise<string | null>>();
  const failed = new Map<string, string>();
  const fail = (repo: string, why: string): null => {
    failed.set(repo, why);
    return null;
  };
  // The user's permission on the repo from GitHub (cached), or null when it can't be told (the reason goes in `failed`).
  const check = async (repo: string): Promise<string | null> => {
    if (!REPO_NAME.test(repo)) return fail(repo, `${repo} is not a repo name`);
    const maxAge = forWrite ? PERM_WRITE_TTL : PERM_READ_TTL;
    const cached = await db.prepare("SELECT permission, checked_at FROM repo_permissions WHERE login = ? AND repo = ?")
      .get(s.login, repo) as { permission: string; checked_at: string } | undefined;
    if (cached && Date.now() - Date.parse(cached.checked_at) < maxAge) return cached.permission;
    let permission: string | undefined;
    try {
      const noToken = (t: string | null | undefined): null => fail(repo, t === null ? `${s.login}'s dashboard session has ended; sign in again` : `${s.login}'s GitHub token could not be refreshed (GitHub did not answer)`);
      let token = await accessToken(db, box, provider, s.idHash, mirrorUserTokens);
      if (!token) return noToken(token);
      permission = await provider.permission(token, repo);
      if (permission === "unauthorized") {
        token = await accessToken(db, box, provider, s.idHash, mirrorUserTokens, token);
        if (!token) return noToken(token);
        permission = await provider.permission(token, repo);
        if (permission === "unauthorized") return fail(repo, `GitHub refused ${s.login}'s token`);
      }
    } catch (e) {
      console.error(`permission check ${s.login} ${repo}: ${(e as Error).message}`);
      return fail(repo, `GitHub permission check failed: ${(e as Error).message}`);
    }
    failed.delete(repo);
    await db.prepare(`INSERT INTO repo_permissions (login, repo, permission, checked_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (login, repo) DO UPDATE SET permission = excluded.permission, checked_at = excluded.checked_at`)
      .run(s.login, repo, permission, new Date().toISOString());
    return permission;
  };
  const permission = (repo: string): Promise<string | null> => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = check(repo)));
    return p;
  };
  return {
    login: s.login,
    role: s.role,
    async canWrite(repo: string): Promise<boolean> {
      return WRITE_PERMISSIONS.has((await permission(repo)) ?? "");
    },
    async canRead(repo: string): Promise<boolean> {
      const p = await permission(repo);
      return p !== null && p !== "none";
    },
    permissionError: async (repo) => failed.get(repo) ?? null,
  };
}

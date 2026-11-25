// One refresh of a login's GitHub token set at a time, across every process (dashboard replicas, the runner, jobs).
//
// GitHub refresh tokens are single use, and a login's token set lives in several copies: its user_tokens row and each
// of its sessions. The vault refreshes the row, a session refreshes its own copy, and either may run in any process.
// refreshShared takes the login's lock (Db.exclusive: it excludes only other refreshes of the login and holds no writer
// lock), reads every copy again, and only then decides:
//  1. the copy is usable (another process refreshed while this one waited): use it, no endpoint call;
//  2. otherwise call the refresh endpoint and, once it answered, write the new pair into every copy that held the old
//     refresh token in one short write transaction, so no process ever sees one copy updated and the other not;
//  3. when the endpoint refuses, or the refresh token has expired, a newer token set in another copy (a session's for
//     the row, the row's for a session) heals this one instead of failing;
//  4. only then is the row marked refresh-failed, with GitHub's error code and description, or the session ended.
// The login's lock is held across at most two endpoint calls (the second only when healing from a copy whose access
// token has also expired); every endpoint call has the provider's timeout.
import type { TokenBox } from "./crypto.ts";
import type { Provider, Refused, Tokens } from "./provider.ts";
import { failUserTokens, readUserTokens, swapUserTokens } from "./user-tokens.ts";
import type { Db } from "../../db/index.ts";

const EXPIRY_MARGIN = 60_000;
/** How long a refresh waits for another process's refresh of the same login, which holds the lock across its endpoint call. */
const LOCK_WAIT_MS = 30_000;

/** The copy to refresh: the login's user_tokens row, or one session's token set. */
export type RefreshTarget = { kind: "user" } | { kind: "session"; idHash: string };
export type Refreshed =
  | { ok: true; tokens: Tokens }
  /** GitHub did not answer: nothing changed, try again later. */
  | { ok: false; transient: true }
  /** The copy can no longer be refreshed: the row is marked refresh-failed (or was already), or the session has ended. */
  | { ok: false; transient: false; why: "no-token" | "refresh-failed" | "expired" };

type Copy =
  | { kind: "user"; version: number; status: string; tokens: Tokens | null }
  | { kind: "session"; idHash: string; enc: string; tokens: Tokens | null };

/** Whether `t`'s access token can be used now: not the one GitHub just answered 401 to, and not within a minute of expiry. */
export const usableAccess = (t: Tokens, rejected?: string, now = Date.now()): boolean =>
  t.access !== rejected && (t.expiresAt === null || t.expiresAt - EXPIRY_MARGIN > now);
const refreshable = (t: Tokens, now: number): t is Tokens & { refresh: string } => !!t.refresh && (t.refreshExpiresAt === null || t.refreshExpiresAt > now);
/** Every refresh issues a refresh token with a fresh expiry, so a later expiry is a newer token set. */
const issuedAt = (t: Tokens): number => t.refreshExpiresAt ?? t.expiresAt ?? 0;
const lockOf = (login: string): string => `user-token:${login.toLowerCase()}`;
const reasonOf = (r: Refused): string => `${r.refused.error}${r.refused.description ? `: ${r.refused.description}` : ""}`;

function openSession(box: TokenBox, enc: string, idHash: string): Tokens | null {
  const plain = box.open(enc, idHash);
  try {
    return plain ? (JSON.parse(plain) as Tokens) : null;
  } catch {
    return null;
  }
}

/** Every copy of the login's token set: its user_tokens row and its sessions. */
async function readCopies(db: Db, box: TokenBox, login: string): Promise<Copy[]> {
  const out: Copy[] = [];
  const u = await readUserTokens(db, box, login);
  if (u) out.push({ kind: "user", ...u });
  const rows = await db.all(db.k.selectFrom("sessions").select(["id_hash", "token_enc"]).$narrowType<{ token_enc: string }>()
    .where("login", "=", login).where("token_enc", "is not", null));
  for (const r of rows) out.push({ kind: "session", idHash: r.id_hash, enc: r.token_enc, tokens: openSession(box, r.token_enc, r.id_hash) });
  return out;
}

/**
 * A usable token set for `target`, refreshed under the login's lock (see the top of this file). `rejected` is an access
 * token GitHub answered 401 to. A new pair goes into every copy that held the used refresh token (the same token set,
 * whichever app issued it). `heal`: the sessions hold tokens of the same GitHub App as the row (the GitHub identity is
 * the app), so a copy with another, newer token set may replace a refused one.
 */
export function refreshShared(db: Db, box: TokenBox, provider: Provider, login: string, target: RefreshTarget, opts: { rejected?: string; heal: boolean }): Promise<Refreshed> {
  // A lock wait past LOCK_WAIT_MS or a database error leaves the token set as it was: try again later.
  return db.exclusive(lockOf(login), async (): Promise<Refreshed> => {
    const now = Date.now();
    const copies = await db.fresh(() => readCopies(db, box, login));
    const isTarget = (c: Copy): boolean => c.kind === target.kind && (c.kind === "user" || c.idHash === (target as { idHash: string }).idHash);
    const mine = copies.find(isTarget);
    if (!mine?.tokens) return { ok: false, transient: false, why: "no-token" };
    const own = mine.tokens;
    const live = mine.kind === "session" || mine.status === "ok";
    if (live && usableAccess(own, opts.rejected, now)) return { ok: true, tokens: own };

    // Writes `next` into the target and every other copy holding one of the `used` refresh tokens.
    // Each write is a compare-and-swap: a sign-in may have replaced a copy since it was read.
    const store = async (next: Tokens, used: (string | null)[]): Promise<Refreshed> => {
      await db.write(async () => {
        for (const c of copies) {
          if (!isTarget(c) && !(c.tokens?.refresh && used.includes(c.tokens.refresh))) continue;
          if (c.kind === "user") await swapUserTokens(db, box, login, c.version, next);
          else await db.run(db.k.updateTable("sessions").set({ token_enc: box.seal(JSON.stringify(next), c.idHash) }).where("id_hash", "=", c.idHash).where("token_enc", "=", c.enc));
        }
      });
      return { ok: true, tokens: next };
    };
    const refresh = async (token: string): Promise<Tokens | Refused | null> => {
      try {
        return await provider.refresh(token);
      } catch (e) {
        console.error(`GitHub token refresh for ${login}: ${(e as Error).message}`);
        return null;
      }
    };
    const refusedLog = (r: Refused): void => console.error(`GitHub token refresh for ${login}: the token endpoint refused the ${mine.kind === "user" ? "stored" : "session's"} refresh token (${reasonOf(r)})`);

    let refusal: string | null = null;
    if (live && refreshable(own, now)) {
      const r = await refresh(own.refresh);
      if (!r) return { ok: false, transient: true };
      if (!("refused" in r)) return await store(r, [own.refresh]);
      refusedLog(r);
      refusal = reasonOf(r);
    }

    const newer = !opts.heal ? [] : copies
      .filter((c): c is Copy & { tokens: Tokens } => !isTarget(c) && !!c.tokens && c.tokens.refresh !== own.refresh && issuedAt(c.tokens) >= issuedAt(own)
        && (c.kind === "session" || c.status === "ok"))
      .sort((a, b) => issuedAt(b.tokens) - issuedAt(a.tokens));
    let healCalls = 0;
    for (const c of newer) {
      if (usableAccess(c.tokens, opts.rejected, now)) return await store(c.tokens, [own.refresh]);
      // One healing endpoint call at most, so the lock is never held for more than two.
      if (!refreshable(c.tokens, now) || healCalls++) continue;
      const r = await refresh(c.tokens.refresh);
      if (!r) return { ok: false, transient: true };
      if (!("refused" in r)) return await store(r, [own.refresh, c.tokens.refresh]);
      refusedLog(r);
    }

    if (mine.kind === "session") {
      await db.run(db.k.deleteFrom("sessions").where("id_hash", "=", mine.idHash).where("token_enc", "=", mine.enc));
      return { ok: false, transient: false, why: "refresh-failed" };
    }
    if (live) await failUserTokens(db, login, mine.version, refusal ?? "the stored refresh token has expired");
    return { ok: false, transient: false, why: live && !refusal ? "expired" : "refresh-failed" };
  }, LOCK_WAIT_MS).catch((e: unknown): Refreshed => {
    console.error(`GitHub token refresh for ${login}: ${(e as Error).message}`);
    return { ok: false, transient: true };
  });
}

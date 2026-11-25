// The pipeline's own reading of a maintainer's write permission. A maintainer's pre-approved merge, the approval it rests on and a
// queued fix-up request count only while the maintainer's cached write permission is fresh (access.canActMany), and a dashboard session
// refreshes that row only while the person uses the dashboard. The pipeline reads it again through the GitHub App installation
// (src/remote/permission.ts, which writes repo_permissions) shortly before it expires, so these long-lived rows do not end with the session.
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { githubIdentity } from "../github/identity.ts";
import { canActMany, loadAccess, loadPermissions, loginsWithRole, permKey, type PermEntry } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadActingPairs } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** A write permission older than this is read again, so it stays younger than PERM_READ_TTL while GitHub answers. About one read per login and repo per TTL. */
export const REFRESH_AFTER = PERM_READ_TTL - 2 * 60_000;
/** A write permission GitHub has not confirmed for this long no longer counts while reads fail or the app cannot see the login (404, no token). */
export const HOLD_MAX = 60 * 60_000;

const lastFailure = new Map<string, string>();

export type RefreshDeps = {
  /** Stands in for `appPermission`, which writes the answer to repo_permissions. */
  permission?: (db: Db, login: string, repo: string) => Promise<AppPermission>;
};

/** The maintainer logins the pipeline acts for, with the repo (of tracked repos), and each one's cached permission row. */
async function pipelineMaintainers(db: Db): Promise<{ login: string; repo: string; row: PermEntry | undefined }[]> {
  const [pairs, maintainers, tracked] = await db.together(() => Promise.all([loadActingPairs(db), loginsWithRole(db, ["maintainer"]), loadTrackedRepos(db)]));
  const isMaintainer = new Set(maintainers.map((l) => l.toLowerCase()));
  const seen = new Map<string, { login: string; repo: string }>();
  for (const p of pairs) if (isMaintainer.has(p.login.toLowerCase()) && tracked.has(p.repo)) seen.set(permKey(p.login, p.repo), p);
  const list = [...seen.values()];
  const rows = await loadPermissions(db, list);
  return list.map((p) => ({ ...p, row: rows.get(permKey(p.login, p.repo)) }));
}

/**
 * Whether `login` may act on `repo` now by the act rule (AutoCraft role, write permission cached within PERM_READ_TTL or kept in `held`,
 * app identity). `held` is the `refreshSettlers` result.
 */
export async function settlesNow(db: Db, login: string | null, repo: string, held?: ReadonlySet<string>): Promise<boolean> {
  if (!login) return false;
  const verdict = (await canActMany(db, [{ login, repo }], { identity: await githubIdentity(db), mode: "cached", maxAgeMs: PERM_READ_TTL, ...(held ? { held } : {}) })).get(permKey(login, repo));
  return verdict?.ok === true;
}

/**
 * Starts a read through the GitHub App for each maintainer the pipeline acts for whose cached write permission is older than REFRESH_AFTER,
 * and returns the `permKey`s whose write permission still counts past PERM_READ_TTL: those with no newer answer yet, because the read is
 * under way or failed (it is made again on the next pass), up to HOLD_MAX after GitHub last confirmed it. A fresh answer that is not write
 * ends it; a role or setting change ends it as before. Only a write permission is kept: a stale non-write row is not read again.
 * `wake` is told when a write permission reaches REFRESH_AFTER and a held one HOLD_MAX, and, after the pass, when a read started here ends:
 * its answer (or failure, read again on the next pass) is the next pass's input.
 */
export async function refreshSettlers(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: (at: number) => void = () => {}): Promise<Set<string>> {
  const held = new Set<string>();
  const read = deps.permission ?? ((d, login, repo) => appPermission(d, login, repo));
  const now = Date.now();
  for (const { login, repo, row: entry } of await pipelineMaintainers(db)) {
    const row = entry ? { permission: entry.permission, checked_at: entry.checkedAt } : undefined;
    const age = row ? now - Date.parse(row.checked_at) : NaN;
    if (row && WRITE_PERMISSIONS.has(row.permission) && age < REFRESH_AFTER) wake(Date.parse(row.checked_at) + REFRESH_AFTER);
    // Past HOLD_MAX (or an unreadable time) the row is not held and the pre-approval ends: a read started now would come too late for this pass.
    if (!row || !WRITE_PERMISSIONS.has(row.permission) || !(age >= REFRESH_AFTER && age < HOLD_MAX)) continue;
    const k = permKey(login, repo);
    held.add(k);
    wake(Date.parse(row.checked_at) + HOLD_MAX);
    const fail = (why: string) => {
      // Read again on every pass while GitHub fails: the log gets each new reason once.
      if (lastFailure.get(k) !== why) log(`permission of ${login} on ${repo}: ${why}`);
      lastFailure.set(k, why);
    };
    read(db, login, repo).then(
      (r) => (r.kind === "error" ? fail(r.why) : r.kind === "unavailable" ? fail("the GitHub App cannot read it (no installation token, or GitHub answered 404)") : void lastFailure.delete(k)),
      (e) => fail((e as Error).message),
    ).finally(() => wake(Date.now()));
  }
  return held;
}

/**
 * Whether `login` settles on `repo` with a write permission confirmed now, for a write the pipeline makes on that person's answer without the
 * user lane (an integration batch's merge). An operator settles; a maintainer needs a write permission checked within PERM_READ_TTL, else it is
 * read through the GitHub App (`read`, which writes repo_permissions). "unknown" when GitHub could not answer and the last write permission is
 * younger than HOLD_MAX: the caller waits. Past that, or on a fresh non-write answer, "no".
 */
export async function settlesLive(db: Db, login: string, repo: string, read: RefreshDeps["permission"] = (d, l, r) => appPermission(d, l, r)): Promise<"yes" | "no" | "unknown"> {
  const role = (await loadAccess(db, [login])).get(login.toLowerCase())?.role;
  if (role !== "maintainer" && role !== "operator") return "no";
  const age = async (): Promise<number> => {
    const row = (await loadPermissions(db, [{ login, repo }])).get(permKey(login, repo));
    return row && WRITE_PERMISSIONS.has(row.permission) ? Date.now() - Date.parse(row.checkedAt) : NaN;
  };
  const before = await age();
  if (!(before < PERM_READ_TTL)) {
    let r: AppPermission;
    try { r = await read(db, login, repo); } catch (e) { r = { kind: "error", why: (e as Error).message }; }
    if (r.kind !== "ok") return before < HOLD_MAX ? "unknown" : "no";
  }
  return await settlesNow(db, login, repo) ? "yes" : "no";
}

// The pipeline's own reading of a maintainer's write permission. A maintainer's pre-approved merge, the Merge answer it rests on and a
// queued fix-up request count only while the maintainer's cached write permission is fresh (src/settlers.ts), and a dashboard session
// refreshes that row only while the person uses the dashboard. The pipeline reads it again through the GitHub App installation
// (src/remote/permission.ts, which writes repo_permissions) shortly before it expires, so these long-lived rows do not end with the session.
import { mergeDecisionId } from "../core/rules.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { maintainersSettle, settleKey, settlesNow } from "../settlers.ts";
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

const answeredMerge = async (db: Db, repo: string, number: number, head: string): Promise<string | null> =>
  (await db.prepare("SELECT answered_by FROM main.decisions WHERE id = ? AND answer = 'merge'").get(mergeDecisionId(repo, number, head)) as { answered_by: string | null } | undefined)?.answered_by ?? null;

/** The maintainer logins the pipeline acts for, with the repo: makers of active pre-approvals and queued fix-up requests, and who answered the Merge a queued pre-approval rests on or that has yet to carry across a base merge. */
async function pipelineMaintainers(db: Db): Promise<{ login: string; repo: string }[]> {
  const maintainers = new Set((await db.prepare("SELECT login FROM main.access WHERE role = 'maintainer'").all() as { login: string }[]).map((r) => r.login));
  if (!maintainers.size) return [];
  const pairs = new Map<string, { login: string; repo: string }>();
  const add = (login: string | null, repo: string) => {
    if (login && maintainers.has(login)) pairs.set(settleKey(login, repo), { login, repo });
  };
  const active = await db.prepare("SELECT repo, number, state, head, by FROM preapprovals WHERE state IN ('fixup', 'review', 'ci', 'queued') AND repo IN (SELECT name FROM main.tracked_repos)").all() as { repo: string; number: number; state: string; head: string | null; by: string }[];
  for (const p of active) {
    add(p.by, p.repo);
    if (p.state === "queued" && p.head) add(await answeredMerge(db, p.repo, p.number, p.head), p.repo);
  }
  for (const o of await db.prepare("SELECT by, repo FROM operator_fixups WHERE state = 'queued'").all() as { by: string; repo: string }[]) add(o.by, o.repo);
  // A Merge answer that carries across the pipeline's own base merge (carryAnswers) and has not carried yet.
  const carries = await db.prepare(`SELECT m.repo, m.number, m.from_head FROM conflict_merges m JOIN main.items i ON i.repo = m.repo AND i.number = m.number
    WHERE m.state = 'merged' AND m.own_diff = 'same' AND i.state = 'OPEN' AND i.head_oid = m.to_head AND m.repo IN (SELECT name FROM main.tracked_repos)
      AND NOT EXISTS (SELECT 1 FROM preapprovals p WHERE p.repo = m.repo AND p.number = m.number AND p.head = m.to_head)`).all() as { repo: string; number: number; from_head: string }[];
  for (const x of carries) add(await answeredMerge(db, x.repo, x.number, x.from_head), x.repo);
  return [...pairs.values()];
}

/**
 * Starts a read through the GitHub App for each maintainer the pipeline acts for whose cached write permission is older than REFRESH_AFTER,
 * and returns the `settleKey`s whose write permission still counts past PERM_READ_TTL: those with no newer answer yet, because the read is
 * under way or failed (it is made again on the next pass), up to HOLD_MAX after GitHub last confirmed it. A fresh answer that is not write
 * ends it; a role or setting change ends it as before. Only a write permission is kept: a stale non-write row is not read again.
 */
export async function refreshSettlers(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}): Promise<Set<string>> {
  const held = new Set<string>();
  if (!await maintainersSettle(db)) return held;
  const read = deps.permission ?? ((d, login, repo) => appPermission(d, login, repo));
  const now = Date.now();
  for (const { login, repo } of await pipelineMaintainers(db)) {
    const row = await db.prepare("SELECT permission, checked_at FROM main.repo_permissions WHERE login = ? AND repo = ?").get(login, repo) as { permission: string; checked_at: string } | undefined;
    const age = row ? now - Date.parse(row.checked_at) : NaN;
    // Past HOLD_MAX (or an unreadable time) the row is not held and the pre-approval ends: a read started now would come too late for this pass.
    if (!row || !WRITE_PERMISSIONS.has(row.permission) || !(age >= REFRESH_AFTER && age < HOLD_MAX)) continue;
    const k = settleKey(login, repo);
    held.add(k);
    const fail = (why: string) => {
      // Read again on every pass while GitHub fails: the log gets each new reason once.
      if (lastFailure.get(k) !== why) log(`permission of ${login} on ${repo}: ${why}`);
      lastFailure.set(k, why);
    };
    read(db, login, repo).then(
      (r) => (r.kind === "error" ? fail(r.why) : r.kind === "unavailable" ? fail("the GitHub App cannot read it (no installation token, or GitHub answered 404)") : void lastFailure.delete(k)),
      (e) => fail((e as Error).message),
    );
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
  const role = (await db.prepare("SELECT role FROM main.access WHERE login = ?").get(login) as { role: string } | undefined)?.role;
  if (role !== "maintainer" || !await maintainersSettle(db)) return await settlesNow(db, login, [repo]) ? "yes" : "no";
  const age = async (): Promise<number> => {
    const row = await db.prepare("SELECT permission, checked_at FROM main.repo_permissions WHERE login = ? AND repo = ?").get(login, repo) as { permission: string; checked_at: string } | undefined;
    return row && WRITE_PERMISSIONS.has(row.permission) ? Date.now() - Date.parse(row.checked_at) : NaN;
  };
  const before = await age();
  if (!(before < PERM_READ_TTL)) {
    let r: AppPermission;
    try { r = await read(db, login, repo); } catch (e) { r = { kind: "error", why: (e as Error).message }; }
    if (r.kind !== "ok") return before < HOLD_MAX ? "unknown" : "no";
  }
  return await settlesNow(db, login, [repo]) ? "yes" : "no";
}

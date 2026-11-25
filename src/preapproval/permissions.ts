// The pipeline's own reading of the write permission of the people it acts for. Their pre-approved merge, the approval it rests on, the work
// they started and a queued fix-up request count while GitHub confirmed their write access within HOLD_MAX (access.standing), and a dashboard
// session refreshes that row only while the person uses the dashboard. The pipeline reads it again through the GitHub App installation
// (src/remote/permission.ts, which writes repo_permissions) shortly before PERM_READ_TTL ends, so these long-lived rows do not end with the
// session, and only GitHub's own answer that the person has no write access ends them: while it cannot be read they wait.
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { githubIdentity } from "../github/identity.ts";
import { HOLD_MAX, loadActFacts, loadPermissions, loginsWithRole, PERM_READ_TTL, permKey, REFRESH_AFTER, standing, standings, type PermEntry, type Standing } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadActingPairs } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** A failed read is made again after this long (a registered backoff, src/stages/registry.ts). */
export const READ_RETRY_MS = 60_000;

const failures = new Map<string, { why: string; until: number }>();

export type RefreshDeps = {
  /** Stands in for `appPermission`, which writes the answer to repo_permissions. */
  permission?: (db: Db, login: string, repo: string) => Promise<AppPermission>;
  /** Stands in for READ_RETRY_MS. */
  retryMs?: number;
};

/** The operator and maintainer logins the pipeline acts for, with the repo (of tracked repos), and each one's cached permission row. */
async function pipelineActors(db: Db): Promise<{ login: string; repo: string; row: PermEntry | undefined }[]> {
  const [pairs, staff, tracked] = await db.together(() => Promise.all([loadActingPairs(db), loginsWithRole(db, ["operator", "maintainer"]), loadTrackedRepos(db)]));
  const mayAct = new Set(staff.map((l) => l.toLowerCase()));
  const seen = new Map<string, { login: string; repo: string }>();
  for (const p of pairs) if (mayAct.has(p.login.toLowerCase()) && tracked.has(p.repo)) seen.set(permKey(p.login, p.repo), p);
  const list = [...seen.values()];
  const rows = await loadPermissions(db, list);
  return list.map((p) => ({ ...p, row: rows.get(permKey(p.login, p.repo)) }));
}

/** Whether what `login` approved or started on `repo` still counts now (access.standing). */
export async function settlesNow(db: Db, login: string | null, repo: string): Promise<Standing> {
  if (!login) return "no";
  return (await standings(db, [{ login, repo }], { identity: await githubIdentity(db) })).get(permKey(login, repo))!;
}

/**
 * Starts a read through the GitHub App for each person the pipeline acts for whose write access on the repo GitHub has not answered on since
 * REFRESH_AFTER (for a row below write: PERM_READ_TTL), a person with no row included (a converted approval). The answer is the next pass's
 * input; a failed read is made again after READ_RETRY_MS.
 * `wake` is told when a permission comes due, when one stops counting (HOLD_MAX) and when a read started here ends.
 */
export async function refreshSettlers(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: (at: number) => void = () => {}): Promise<void> {
  const read = deps.permission ?? ((d, login, repo) => appPermission(d, login, repo));
  const now = Date.now();
  for (const { login, repo, row } of await pipelineActors(db)) {
    const at = row ? Date.parse(row.checkedAt) : NaN;
    const write = standing({ login, role: "operator", githubId: null, perm: row ?? null }, "app", now);
    const due = write === "no" ? at + PERM_READ_TTL : at + REFRESH_AFTER;
    if (now < due) { wake(due); continue; }
    if (write === "yes") wake(at + HOLD_MAX);
    const k = permKey(login, repo);
    const failed = failures.get(k);
    if (failed && now < failed.until) { wake(failed.until); continue; }
    const fail = (why: string): number => {
      // The log gets each new reason once.
      if (failures.get(k)?.why !== why) log(`permission of ${login} on ${repo}: ${why}`);
      const until = Date.now() + (deps.retryMs ?? READ_RETRY_MS);
      failures.set(k, { why, until });
      return until;
    };
    void read(db, login, repo).then((r) => {
      if (r.kind === "ok") { failures.delete(k); return Date.now(); }
      return fail(r.kind === "error" ? r.why : "the GitHub App cannot read it (no installation token, or GitHub answered 404)");
    }).catch((e) => fail((e as Error).message)).then((next) => wake(next));
  }
}

/**
 * Whether what `login` approved or asked for on `repo` counts, with write access confirmed now, for a write the pipeline makes on it without
 * the user lane (an integration batch's merge, a queued card press). A write permission older than PERM_READ_TTL is read through the GitHub App
 * (`read`, which writes repo_permissions). "unknown" when GitHub could not answer: the caller waits.
 */
export async function settlesLive(db: Db, login: string, repo: string, read: RefreshDeps["permission"] = (d, l, r) => appPermission(d, l, r)): Promise<Standing> {
  const [facts, identity] = await db.together(() => Promise.all([loadActFacts(db, [{ login, repo }]), githubIdentity(db)]));
  const f = facts.get(permKey(login, repo));
  if (standing(f && { ...f, perm: null }, identity) === "no") return "no";
  const age = f?.perm ? Date.now() - Date.parse(f.perm.checkedAt) : NaN;
  if (!(age < PERM_READ_TTL)) {
    let r: AppPermission;
    try { r = await read(db, login, repo); } catch (e) { r = { kind: "error", why: (e as Error).message }; }
    if (r.kind !== "ok") return "unknown";
  }
  return await settlesNow(db, login, repo);
}

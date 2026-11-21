// Who may settle a decision (answer, undo their own answer, Backlog, press a conversation card). An operator always may.
// A maintainer may when `settings.maintainer_writes` is on, every repo the decision covers has the app's identity (the
// merges and closes then run as that person through the user lane, never as the box account) and the person has write
// permission on every one of those repos.
import { githubIdentity } from "./github/identity.ts";
import { PERM_READ_TTL } from "./dash/server/sessions.ts";
import { HttpError } from "./dash/server/util.ts";
import { slugOf } from "./owners.ts";
import { everySeq } from "./async-seq.ts";
import type { Db } from "./db/index.ts";
import { distinctFrom, jsonArrayLength, jsonEach, jsonText, jsonValid, nowParam, quote } from "./db/portable.ts";
import * as kx from "./db/kx.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";

export const MAINTAINER_WRITES_KEY = "maintainer_writes";

export const maintainerWritesOn = async (db: Db): Promise<boolean> =>
  (await db.prepare("SELECT value FROM main.settings WHERE key = ?").get(MAINTAINER_WRITES_KEY) as { value: string } | undefined)?.value === "1";

/** Maintainers settle now where they have write access: `maintainer_writes` on and the app's identity (which is instance-wide, as `allAppIdentity` reads it). */
export const maintainersSettle = async (db: Db): Promise<boolean> => await maintainerWritesOn(db) && await githubIdentity(db) === "app";

export async function setMaintainerWrites(db: Db, on: boolean): Promise<boolean> {
  if (await maintainerWritesOn(db) === on) return false;
  if (on) await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = '1'").run(MAINTAINER_WRITES_KEY);
  else await db.prepare("DELETE FROM main.settings WHERE key = ?").run(MAINTAINER_WRITES_KEY);
  return true;
}

/** SQL for the logins whose answers the pipeline acts on: operators, and maintainers while `maintainer_writes` is on. */
export const SETTLER_LOGINS_SQL = `(SELECT login FROM main.access WHERE role = 'operator'
  OR (role = 'maintainer' AND EXISTS (SELECT 1 FROM main.settings WHERE key = '${MAINTAINER_WRITES_KEY}' AND value = '1')))`;

export async function settlerLogins(db: Db): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT login FROM ${SETTLER_LOGINS_SQL}`).all() as { login: string }[]).map((r) => r.login));
}

/**
 * Values read once per planner pass or response, so a loop over decisions does not query per decision. `held` holds `settleKey`s whose
 * cached write permission still counts past PERM_READ_TTL: the pipeline is reading it again from GitHub and has no newer answer yet.
 */
export type SettleMemo = { operators?: Set<string>; maintainers?: Set<string>; on?: boolean; app: Map<string, boolean>; write: Map<string, boolean>; held?: ReadonlySet<string> };
export const settleMemo = (): SettleMemo => ({ app: new Map(), write: new Map() });
export const settleKey = (login: string, repo: string): string => `${login}\n${repo}`;

const roles = async (db: Db, m: SettleMemo): Promise<void> => {
  if (m.operators) return;
  const rows = await db.prepare("SELECT login, role FROM main.access WHERE role IN ('operator', 'maintainer')").all() as { login: string; role: string }[];
  m.operators = new Set(rows.filter((r) => r.role === "operator").map((r) => r.login));
  m.maintainers = new Set(rows.filter((r) => r.role === "maintainer").map((r) => r.login));
  m.on = await maintainerWritesOn(db);
};

/** At least one repo, and every repo has the app's identity, so a maintainer's GitHub writes run as that maintainer. */
export async function allAppIdentity(db: Db, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  return repos.length > 0 && await everySeq(repos, async (r) => {
    let v = m.app.get(r);
    if (v === undefined) m.app.set(r, (v = await githubIdentity(db) === "app"));
    return v;
  });
}

const WRITE = "('write', 'maintain', 'admin')";

/** A cached write permission younger than PERM_READ_TTL, or an older one the memo holds; the write itself reads the live permission again. */
async function cachedWrite(db: Db, login: string, repo: string, m: SettleMemo): Promise<boolean> {
  const k = settleKey(login, repo);
  let v = m.write.get(k);
  if (v === undefined) {
    const row = await db.prepare(`SELECT checked_at FROM main.repo_permissions WHERE login = ? AND repo = ? AND permission IN ${WRITE}`).get(login, repo) as { checked_at: string } | undefined;
    m.write.set(k, (v = !!row && (Date.now() - Date.parse(row.checked_at) < PERM_READ_TTL || !!m.held?.has(k))));
  }
  return v;
}

/** The sync form for views and the planner: write permission from the cached `repo_permissions` value. */
export async function canSettleCached(db: Db, login: string, role: string, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  if (role === "operator") return true;
  await roles(db, m);
  if (role !== "maintainer" || !m.on || !await allAppIdentity(db, repos, m)) return false;
  return await everySeq(repos, async (r) => await cachedWrite(db, login, r, m));
}

/** The request form: write permission is read live (the session's `canWrite`). An operator's write access is not checked here: request handlers call `settleRefusal`, which does. */
export async function canSettle(db: Db, user: { login: string; role: string; canWrite: (repo: string) => Promise<boolean> }, repos: string[]): Promise<boolean> {
  if (user.role === "operator") return true;
  if (user.role !== "maintainer" || !await maintainerWritesOn(db) || !await allAppIdentity(db, repos)) return false;
  const ok = await Promise.all(repos.map((r) => user.canWrite(r).catch(() => false)));
  return ok.every(Boolean);
}

/**
 * May `user` act on `repos` now: answer or settle a decision, run a conversation card or choice, put items in the merge queue (Queue items,
 * queue_pr). One rule for every such write a person starts: an operator needs live write access on every repo, a maintainer the rule of
 * `canSettle`. Returns why not, or null; `what` names the action in the refusal ("settles decisions").
 */
export async function settleRefusal(db: Db, user: { login: string; role: string; canWrite: (repo: string) => Promise<boolean> }, repos: string[], what: string): Promise<string | null> {
  if (user.role !== "operator") return (await canSettle(db, user, repos)) ? null : `only an operator, or a maintainer with write access where the app acts for them, ${what}`;
  const ok = await Promise.all(repos.map((r) => user.canWrite(r).catch(() => false)));
  const blocked = repos.filter((_, i) => !ok[i]);
  return blocked.length ? `no write access to ${blocked.map((r) => slugOf(r)).join(", ")}` : null;
}

/** `settleRefusal` as a 403, for the request handlers. */
export async function requireSettle(db: Db, user: Parameters<typeof settleRefusal>[1], repos: string[], what: string): Promise<void> {
  const why = await settleRefusal(db, user, repos, what);
  if (why) throw new HttpError(403, why);
}

/** The DB-side form for the pipeline: the login's current role, and the cached write permission for a maintainer (or one `m.held` keeps). Write access is read live again when the write is made. */
export async function settlesNow(db: Db, login: string | null, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  if (!login) return false;
  await roles(db, m);
  return m.operators!.has(login) || (m.maintainers!.has(login) && await canSettleCached(db, login, "maintainer", repos, m));
}

/**
 * SQL: `login` (an expression) is an operator, or a maintainer who settles on the repo expression (setting on, app identity, fresh cached write).
 * Binds `:settles_after` (settlesAfter): a cached write permission read before it is not fresh.
 */
export const settlesLoginSql = (login: string, repo: string): string => `(${login} IN (SELECT login FROM main.access WHERE role = 'operator')
  OR (${login} IN ${SETTLER_LOGINS_SQL}
    AND EXISTS (SELECT 1 FROM main.settings s WHERE s.key = 'github_identity' AND s.value = 'app')
    AND EXISTS (SELECT 1 FROM main.repo_permissions rp WHERE rp.login = ${login} AND rp.repo = ${repo} AND rp.permission IN ${WRITE}
      AND rp.checked_at > :settles_after)))`;

/** The named parameter settlesLoginSql binds, at `nowMs`. */
export const settlesAfter = (nowMs: number): { settles_after: string } => ({ settles_after: new Date(nowMs - PERM_READ_TTL).toISOString() });

/** SQL: when the cached write permission that lets `login` settle on `repo` (expressions) was read; null for an operator, whose settling does not age. Freshness ends PERM_READ_TTL after it. */
export const settlesCheckedAtSql = (login: string, repo: string): string => `(CASE WHEN ${login} IN (SELECT login FROM main.access WHERE role = 'operator') THEN NULL
  ELSE (SELECT max(rp.checked_at) FROM main.repo_permissions rp WHERE rp.login = ${login} AND rp.repo = ${repo} AND rp.permission IN ${WRITE}) END)`;

/**
 * SQL condition on a decisions row (`a` is its table name or alias): a disputed answer never counts. Otherwise its answer counts because its answerer is an operator, or a
 * maintainer while `maintainer_writes` is on and every repo the decision covers (its own and its batch items') has the app's
 * identity, so its merge or close is made as that person. Checked wherever the pipeline reads answers.
 */
export const settledBySql = (db: Db, a: string): string => `(${distinctFrom(db, `${a}.exec_state`, "'disputed'")} AND (${a}.answered_by IN (SELECT login FROM main.access WHERE role = 'operator')
  OR (${a}.answered_by IN ${SETTLER_LOGINS_SQL}
    AND (${a}.repo IS NOT NULL OR ${itemsCount(db, a)} > 0)
    AND NOT EXISTS (SELECT 1 WHERE ${a}.repo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.settings s WHERE s.key = 'github_identity' AND s.value = 'app'))
    AND NOT EXISTS (SELECT 1 FROM ${itemsEach(db, a)}
      WHERE ${jsonText(db, "j.value", "$.repo")} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.settings s WHERE s.key = 'github_identity' AND s.value = 'app')))))`;

/** The batch items of decisions row `a` as a FROM item `j` (none when `items` is not a JSON array). */
const itemsEach = (db: Db, a: string): string => jsonEach(db, `CASE WHEN ${jsonValid(db, `${a}.items`)} THEN ${a}.items ELSE '[]' END`, "j");

/** How many batch items decisions row `a` has. */
const itemsCount = (db: Db, a: string): string => jsonArrayLength(db, `CASE WHEN ${jsonValid(db, `${a}.items`)} THEN ${a}.items ELSE '[]' END`);

/** The same check for one loaded decision row. */
export async function settledBy(db: Db, d: { answered_by: string | null; repo: string | null; items: string | null; exec_state?: string | null }, m: SettleMemo = settleMemo()): Promise<boolean> {
  if (!d.answered_by || d.exec_state === "disputed") return false;
  await roles(db, m);
  if (m.operators!.has(d.answered_by)) return true;
  if (!m.maintainers!.has(d.answered_by) || !m.on) return false;
  let items: { repo: string }[] = [];
  try { items = JSON.parse(d.items ?? "[]"); } catch { /* none */ }
  return await allAppIdentity(db, [...new Set([...(d.repo ? [d.repo] : []), ...items.map((i) => i.repo)])], m);
}

/**
 * SQL condition on a decisions row (`a`: its table name or alias): `login` with `role` settles it, as `canSettleCached` decides for one row. An operator
 * settles everything. A maintainer needs `maintainer_writes` on, and for the decision's repo and every batch item's repo the app's identity and a fresh
 * cached write permission. Anyone else settles nothing.
 */
export function canSettleSql(db: Db, login: string, role: string, a = "decisions"): string {
  if (role === "operator") return "TRUE";
  if (role !== "maintainer") return "FALSE";
  const me = `'${login.replace(/'/g, "''")}'`;
  const fresh = quote(nowParam({ offsetMs: -PERM_READ_TTL }));
  const ok = (repo: string): string => `(EXISTS (SELECT 1 FROM main.settings s WHERE s.key = 'github_identity' AND s.value = 'app')
    AND EXISTS (SELECT 1 FROM main.repo_permissions rp WHERE rp.login = ${me} AND rp.repo = ${repo} AND rp.permission IN ${WRITE}
      AND rp.checked_at > ${fresh}))`;
  return `(EXISTS (SELECT 1 FROM main.settings WHERE key = '${MAINTAINER_WRITES_KEY}' AND value = '1')
    AND (${a}.repo IS NOT NULL OR ${itemsCount(db, a)} > 0)
    AND (${a}.repo IS NULL OR ${ok(`${a}.repo`)})
    AND NOT EXISTS (SELECT 1 FROM ${itemsEach(db, a)}
      WHERE ${jsonText(db, "j.value", "$.repo")} IS NOT NULL AND NOT ${ok(jsonText(db, "j.value", "$.repo"))}))`;
}

// Typed twins of the SQL fragments above, for queries built with `db.k`.

const WRITE_PERMISSIONS = ["write", "maintain", "admin"];

/** The logins of operators. */
const operatorLogins = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom("main.access").select("login").where("role", "=", "operator");

/** `SETTLER_LOGINS_SQL`: operators, and maintainers while `maintainer_writes` is on. */
const settlerLoginsQuery = (eb: kx.AnyEb) => {
  const t = kx.schemaEb(eb);
  return t.selectFrom("main.access").select("login").where((w) => w.or([w("role", "=", "operator"), w.and([w("role", "=", "maintainer"),
    w.exists(t.selectFrom("main.settings").select(w.lit(1).as("one")).where("key", "=", MAINTAINER_WRITES_KEY).where("value", "=", "1"))])]));
};

/** The instance runs as the GitHub App. */
const appIdentity = (eb: kx.AnyEb) =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.settings as s").select(eb.lit(1).as("one")).where("s.key", "=", "github_identity").where("s.value", "=", "app"));

/** The `items` of decisions row `a` when it is a JSON array, else `[]`. */
const itemsJson = (db: Db, eb: kx.AnyEb, a: string) => eb.case().when(kx.jsonValid(db, `${a}.items`)).then(eb.ref(`${a}.items`)).else(eb.val("[]")).end();

/** `settlesLoginSql` as an expression; `nowMs` takes the place of the bound `:settles_after` (settlesAfter). */
export function settlesLoginExpr(eb: kx.AnyEb, login: kx.Ex, repo: kx.Ex, nowMs: number): AliasableExpression<SqlBool> {
  const l = kx.exprOf(eb, login);
  return eb.or([eb(l, "in", operatorLogins(eb)), eb.and([eb(l, "in", settlerLoginsQuery(eb)), appIdentity(eb),
    eb.exists(kx.schemaEb(eb).selectFrom("main.repo_permissions as rp").select(eb.lit(1).as("one")).where("rp.login", "=", l).where("rp.repo", "=", kx.exprOf(eb, repo))
      .where("rp.permission", "in", WRITE_PERMISSIONS).where("rp.checked_at", ">", settlesAfter(nowMs).settles_after))])]);
}

/** `settlesCheckedAtSql` as an expression. */
export function settlesCheckedAtExpr(eb: kx.AnyEb, login: kx.Ex, repo: kx.Ex): AliasableExpression<string | null> {
  const l = kx.exprOf(eb, login);
  return eb.case().when(l, "in", operatorLogins(eb)).then(eb.lit(null))
    .else(kx.schemaEb(eb).selectFrom("main.repo_permissions as rp").select((s) => s.fn.max("rp.checked_at").as("at")).where("rp.login", "=", l)
      .where("rp.repo", "=", kx.exprOf(eb, repo)).where("rp.permission", "in", WRITE_PERMISSIONS)).end();
}

/** `settledBySql` as an expression (`a`: the decisions table name or alias in the caller's query). */
export function settledByExpr(db: Db, eb: kx.AnyEb, a: string): AliasableExpression<SqlBool> {
  const c = (col: string) => eb.ref(`${a}.${col}`);
  return eb.and([eb(c("exec_state"), "is distinct from", "disputed"), eb.or([eb(c("answered_by"), "in", operatorLogins(eb)), eb.and([
    eb(c("answered_by"), "in", settlerLoginsQuery(eb)),
    eb.or([eb(c("repo"), "is not", null), eb(kx.jsonArrayLength(db, itemsJson(db, eb, a)), ">", 0)]),
    eb.not(eb.and([eb(c("repo"), "is not", null), eb.not(appIdentity(eb))])),
    eb.not(eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, itemsJson(db, eb, a), "j")).select(eb.lit(1).as("one"))
      .where(kx.jsonText(db, "j.value", "$.repo"), "is not", null).where(eb.not(appIdentity(eb))))),
  ])])]);
}

/** `canSettleSql` as an expression. */
export function canSettleExpr(db: Db, eb: kx.AnyEb, login: string, role: string, a = "decisions"): AliasableExpression<SqlBool> {
  if (role === "operator") return eb.lit(true);
  if (role !== "maintainer") return eb.lit(false);
  const t = kx.schemaEb(eb);
  const c = (col: string) => eb.ref(`${a}.${col}`);
  const fresh = nowParam({ offsetMs: -PERM_READ_TTL });
  const ok = (repo: Expression<any>) => eb.and([appIdentity(eb), eb.exists(t.selectFrom("main.repo_permissions as rp").select(eb.lit(1).as("one"))
    .where("rp.login", "=", login).where("rp.repo", "=", repo).where("rp.permission", "in", WRITE_PERMISSIONS).where("rp.checked_at", ">", fresh))]);
  const itemRepo = () => kx.jsonText(db, "j.value", "$.repo");
  return eb.and([
    eb.exists(t.selectFrom("main.settings").select(eb.lit(1).as("one")).where("key", "=", MAINTAINER_WRITES_KEY).where("value", "=", "1")),
    eb.or([eb(c("repo"), "is not", null), eb(kx.jsonArrayLength(db, itemsJson(db, eb, a)), ">", 0)]),
    eb.or([eb(c("repo"), "is", null), ok(c("repo"))]),
    eb.not(eb.exists(t.selectFrom(kx.jsonEach(db, itemsJson(db, eb, a), "j")).select(eb.lit(1).as("one")).where(itemRepo(), "is not", null).where(eb.not(ok(itemRepo()))))),
  ]);
}

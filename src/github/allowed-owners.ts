// The GitHub accounts the GitHub App may be installed on. GitHub lets any account install a public app, so AutoCraft
// keeps its own list and uninstalls the app from other accounts: at once on the installation's webhook, and in a sweep
// the sync run makes every 10 minutes. An empty list turns this off. An account that owns a tracked or filing-only repo,
// or the app itself, is never uninstalled and cannot be taken off the list.
import { audit } from "../dash/audit.ts";
import type { AppSecrets } from "../dash/server/config.ts";
import { DEFAULT_OWNER, OWNER } from "../owners.ts";
import { setting } from "../settings-read.ts";
import { installations, type AppDeps, type Installation } from "./app.ts";
import { readAppSecrets } from "./install-token.ts";
import { removeInstallation } from "./write.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export class AllowedOwnerError extends Error {}

export type AllowedOwner = { login: string; addedBy: string; addedAt: string };

/** The audit login of the removals. */
const REMOVER = "app-install-check";
export const SWEEP_EVERY_MS = 10 * 60_000;
const SWEPT_AT = "app_install_sweep_at";
/** How long a removal shows as a health warning, unless an operator acknowledges it first. */
export const FOREIGN_WARN_MS = 24 * 3600_000;

const lower = (s: string): string => s.toLowerCase();

export async function allowedOwners(db: Db): Promise<AllowedOwner[]> {
  return await db.all(db.k.selectFrom("app_allowed_owners").select(["login", "added_by as addedBy", "added_at as addedAt"]).orderBy("login"));
}

/**
 * Accounts that stay allowed whatever the list says, by lower-case login, with the reason: the owners of tracked and
 * filing-only repos, and the account the app belongs to.
 */
export async function keptOwners(db: Db, appOwner: string | null): Promise<Map<string, { login: string; why: string }>> {
  const out = new Map<string, { login: string; why: string }>();
  const put = (login: string, why: string): void => { if (!out.has(lower(login))) out.set(lower(login), { login, why }); };
  if (appOwner) put(appOwner, `${appOwner} owns the GitHub App`);
  const tracked = await db.all(db.k.selectFrom("main.tracked_repos as t").leftJoin("main.repos as r", "r.name", "t.name")
    .select((eb) => ["t.name as name", eb.fn.coalesce("r.owner", eb.val(DEFAULT_OWNER)).as("owner")]).orderBy("t.name"));
  for (const t of tracked) put(t.owner, `${t.owner} owns the tracked repo ${t.name}`);
  for (const f of await db.all(db.k.selectFrom("discord_filing_repos").select(["owner", "name"]).orderBy("name"))) put(f.owner, `${f.owner} owns the filing-only repo ${f.name}`);
  return out;
}

/** Whether `login` is on the list; true for every login while the list is empty (nothing is enforced). */
export async function ownerAllowed(db: Db, login: string): Promise<boolean> {
  const owners = await allowedOwners(db);
  return !owners.length || owners.some((o) => lower(o.login) === lower(login));
}

/**
 * Puts an account on the list. The first account listed turns enforcement on, so the accounts that must stay allowed
 * (keptOwners) are listed with it. Audited as `app-owner-allow`, one row per account added.
 */
export async function allowOwner(db: Db, by: string, login: string, appOwner: string | null): Promise<AllowedOwner[]> {
  const name = login.trim();
  if (!OWNER.test(name)) throw new AllowedOwnerError("That is not a GitHub account name.");
  const owners = await allowedOwners(db);
  if (owners.some((o) => lower(o.login) === lower(name))) throw new AllowedOwnerError(`${name} is already an allowed owner.`);
  const add = [name];
  if (!owners.length) {
    for (const k of (await keptOwners(db, appOwner)).values()) if (!add.some((a) => lower(a) === lower(k.login))) add.push(k.login);
  }
  const at = new Date().toISOString();
  for (const a of add) {
    await db.run(db.k.insertInto("app_allowed_owners").values({ login: a, added_by: by, added_at: at }).onConflict((oc) => oc.column("login").doNothing()));
    await audit(db, by, "app-owner-allow", a, a === name ? {} : { with: name });
  }
  return await allowedOwners(db);
}

/** Takes an account off the list; refused for an account that must stay allowed. Returns false when it was not listed. Audited as `app-owner-remove`. */
export async function removeOwner(db: Db, by: string, login: string, appOwner: string | null): Promise<boolean> {
  const row = (await allowedOwners(db)).find((o) => lower(o.login) === lower(login.trim()));
  if (!row) return false;
  const kept = (await keptOwners(db, appOwner)).get(lower(row.login));
  if (kept) throw new AllowedOwnerError(`${kept.why}, so it stays an allowed owner.`);
  await db.run(db.k.deleteFrom("app_allowed_owners").where("login", "=", row.login));
  await audit(db, by, "app-owner-remove", row.login);
  return true;
}

export type Verdict = "off" | "allowed" | { kept: string } | "foreign";

/** What enforcement does with an installation on `account`. */
export async function verdictFor(db: Db, account: string, appOwner: string | null): Promise<Verdict> {
  const owners = await allowedOwners(db);
  if (!owners.length) return "off";
  if (owners.some((o) => lower(o.login) === lower(account))) return "allowed";
  const kept = (await keptOwners(db, appOwner)).get(lower(account));
  return kept ? { kept: kept.why } : "foreign";
}

export type EnforceDeps = AppDeps & { log?: (line: string) => void };

/** Uninstalls the app from `inst`'s account when the account is not allowed. Returns whether it was removed. A failed removal is audited and logged, not thrown. */
export async function enforceOne(db: Db, app: AppSecrets, inst: Pick<Installation, "id" | "owner">, found: "webhook" | "sweep", deps: EnforceDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const v = await verdictFor(db, inst.owner, app.owner?.login ?? null);
  if (v === "off" || v === "allowed") return false;
  if (typeof v === "object") {
    log(`github app: installation ${inst.id} on ${inst.owner} is not on the allowed owners list but kept: ${v.kept}`);
    return false;
  }
  try {
    await removeInstallation({ db, login: REMOVER }, { app, installationId: inst.id, account: inst.owner, found, ...(deps.apiBase ? { apiBase: deps.apiBase } : {}) });
    log(`github app: removed installation ${inst.id} on ${inst.owner}, not an allowed owner`);
    return true;
  } catch (e) {
    log(`github app: removing installation ${inst.id} on ${inst.owner}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

/** Lists the app's installations and removes those on accounts not allowed. Returns how many were removed; nothing is read while the list is empty. */
export async function sweepInstallations(db: Db, app: AppSecrets, deps: EnforceDeps = {}): Promise<number> {
  if (!(await allowedOwners(db)).length) return 0;
  let n = 0;
  for (const i of await installations(app, deps)) if (await enforceOne(db, app, i, "sweep", deps)) n++;
  return n;
}

/** The sweep when the last one is SWEEP_EVERY_MS old; the sync run calls it, so of two replicas only the periodic leader does. */
export async function sweepInstallationsIfDue(db: Db, now = Date.now(), deps: EnforceDeps & { app?: AppSecrets | null } = {}): Promise<boolean> {
  const app = deps.app === undefined ? readAppSecrets() : deps.app;
  if (!app) return false;
  const at = await setting(db, SWEPT_AT);
  if (at && now - Date.parse(at) < SWEEP_EVERY_MS - 5_000) return false;
  // Stamped first: a sweep GitHub refuses waits for the next turn instead of retrying every minute.
  await db.run(db.k.insertInto("settings").values({ key: SWEPT_AT, value: new Date(now).toISOString() }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  await sweepInstallations(db, app, deps);
  return true;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** A verified `installation` (created, new permissions accepted) or `installation_repositories` (added) delivery: enforces at once. */
export async function installationEvent(db: Db, event: string, payload: unknown, deps: EnforceDeps & { app?: AppSecrets | null } = {}): Promise<boolean> {
  const p = obj(payload);
  const acts = event === "installation" ? ["created", "new_permissions_accepted"] : event === "installation_repositories" ? ["added"] : [];
  if (!acts.includes(String(p.action))) return false;
  const inst = obj(p.installation);
  const owner = obj(inst.account).login;
  if (typeof inst.id !== "number" || typeof owner !== "string" || !owner) return false;
  const app = deps.app === undefined ? readAppSecrets() : deps.app;
  if (!app) return false;
  return await enforceOne(db, app, { id: inst.id, owner }, "webhook", deps);
}

/** Removals of the last FOREIGN_WARN_MS that no operator has acknowledged, newest first. */
export async function unackedRemovals(db: Db, nowMs: number): Promise<{ account: string; at: string }[]> {
  const from = new Date(nowMs - FOREIGN_WARN_MS).toISOString();
  const ack = (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.max<string | null>("at").as("at")).where("action", "=", "app-foreign-install-ack")))?.at ?? null;
  const rows = await db.all(db.k.selectFrom("audit").select(["at", "target", "details"]).where("action", "=", "app-install-removed")
    .where("at", ">=", ack && ack > from ? ack : from).orderBy("at", "desc"));
  return rows.flatMap((r) => {
    try { return (JSON.parse(r.details ?? "{}") as { state?: unknown }).state === "done" && r.target && (!ack || r.at > ack) ? [{ account: r.target, at: r.at }] : []; } catch { return []; }
  });
}

/** An operator acknowledges the removals so far: their warning clears until the next one. */
export async function ackRemovals(db: Db, by: string): Promise<void> {
  await audit(db, by, "app-foreign-install-ack", "github-app", {});
}

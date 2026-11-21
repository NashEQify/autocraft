// Contributor whitelist: an automatic tier from merge history, with owner
// overrides that always win.
import { audit } from "./dash/audit.ts";
import { githubUserId } from "./github/users.ts";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import { ciEq, upsert } from "./db/portable.ts";
import { openDb } from "./db/open.ts";

export type Tier = "whitelisted" | "not" | "allow" | "deny";

export const TIER_LABEL: Record<Tier, string> = {
  whitelisted: "whitelisted",
  not: "not whitelisted",
  allow: "override allow",
  deny: "override deny",
};

export type Rule = { minMerged: number; minRate: number };

export type Contributor = {
  login: string;
  merged: number;
  closed: number;          // closed without merge
  open: number;
  rate: number | null;     // merged / (merged + closed); null with no finished PRs
  last_merge: string | null;
  repos: string;           // comma-separated
  override: "allow" | "deny" | null;
  override_in_effect: boolean; // false for an allow given to another account than the one the login is bound to (or with no account)
  note: string | null;     // private
  override_by: string | null;
  override_at: string | null;
  tier: Tier;
};

export async function getRule(db: Db): Promise<Rule> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('whitelist_min_merged','whitelist_min_merge_rate')").all() as { key: string; value: string }[];
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { minMerged: Number(m.whitelist_min_merged ?? 5), minRate: Number(m.whitelist_min_merge_rate ?? 0.6) };
}

export async function setRule(db: Db, rule: Rule, by: string): Promise<void> {
  if (!Number.isInteger(rule.minMerged) || rule.minMerged < 0) throw new Error("min merged must be a whole number ≥ 0");
  if (!(rule.minRate >= 0 && rule.minRate <= 1)) throw new Error("min merge rate must be between 0 and 1");
  const set = db.prepare(upsert(db, { table: "settings", cols: ["key", "value"], key: ["key"] }));
  await set.run("whitelist_min_merged", String(rule.minMerged));
  await set.run("whitelist_min_merge_rate", String(rule.minRate));
  await audit(db, by, "rule", "whitelist", rule);
}

export function tierOf(merged: number, closed: number, override: string | null, rule: Rule): Tier {
  if (override === "allow" || override === "deny") return override;
  const done = merged + closed;
  return merged >= rule.minMerged && done > 0 && merged / done >= rule.minRate ? "whitelisted" : "not";
}

// SQL for per-author PR stats; the `items_pr_author` index covers it.
export const STATS_SQL = `
  SELECT author AS login,
         SUM(CASE WHEN state = 'MERGED' THEN 1 ELSE 0 END) AS merged,
         SUM(CASE WHEN state = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
         SUM(CASE WHEN state = 'OPEN' THEN 1 ELSE 0 END) AS open,
         MAX(merged_at) AS last_merge
  FROM items WHERE kind = 'pr' AND author IS NOT NULL`;

/** `STATS_SQL` as a query on `db.k`; add the GROUP BY (and any filter) as the text version's callers do. */
export function statsExpr(db: Db) {
  const n = (eb: kx.AnyEb, state: string) => eb.fn.sum<number>(eb.case().when("state", "=", state).then(eb.lit(1)).else(eb.lit(0)).end());
  return db.k.selectFrom("items").select((eb) => ["author as login" as const, n(eb, "MERGED").as("merged"), n(eb, "CLOSED").as("closed"), n(eb, "OPEN").as("open"),
    eb.fn.max("merged_at").as("last_merge")]).where("kind", "=", "pr").where("author", "is not", null);
}

export type AuthorRef = { login: string; id: number | null };
export const tierKey = (a: AuthorRef): string => `${a.login}\0${a.id ?? ""}`;

type Standing = { merged: number; closed: number; override: "allow" | "deny" | null };

/**
 * The history and override that count for each author account. A login string can pass to another GitHub account, so history is
 * counted per account: a PR row with an id counts for that id, a row without one (mirrored before ids were stored) for the account
 * the login is bound to (author_ids), and for nobody while the login is unbound. An author with no id stands for the bound account.
 * An allow override counts only for the account it was given to; a deny holds for every account under the login.
 */
async function standings(db: Db, authors: AuthorRef[]): Promise<Map<string, Standing>> {
  const out = new Map<string, Standing>();
  if (!authors.length) return out;
  const logins = [...new Set(authors.map((a) => a.login))];
  // A long list (the contributors page) reads every login rather than binding thousands of parameters.
  const all = logins.length > 500;
  const marks = logins.map(() => "?").join(",");
  const only = (col: string, nocase = false): string =>
    (all ? "TRUE" : !nocase ? `${col} IN (${marks})` : db.dialect === "postgres" ? `(${col})::citext IN (${marks})` : `${col} COLLATE NOCASE IN (${marks})`);
  const args = all ? [] : logins;
  const rows = new Map<string, { id: number | null; merged: number; closed: number }[]>();
  for (const r of await db.prepare(`SELECT author AS login, author_id AS id, SUM(CASE WHEN state = 'MERGED' THEN 1 ELSE 0 END) AS merged, SUM(CASE WHEN state = 'CLOSED' THEN 1 ELSE 0 END) AS closed
    FROM items WHERE kind = 'pr' AND author IS NOT NULL AND ${only("author")} GROUP BY author, author_id`).all(...args) as { login: string; id: number | null; merged: number; closed: number }[]) {
    (rows.get(r.login) ?? rows.set(r.login, []).get(r.login)!).push(r);
  }
  const over = new Map((await db.prepare(`SELECT login, status, github_id FROM whitelist_overrides WHERE ${only("login", true)}`).all(...args) as { login: string; status: string; github_id: number | null }[])
    .map((r) => [r.login.toLowerCase(), r]));
  const bound = new Map((await db.prepare(`SELECT login, id FROM author_ids WHERE ${only("login")}`).all(...args) as { login: string; id: number }[]).map((r) => [r.login, r.id]));
  for (const a of authors) {
    const owner = bound.get(a.login);
    const account = a.id ?? owner ?? null;
    let merged = 0, closed = 0;
    if (account !== null) for (const r of rows.get(a.login) ?? []) if (r.id === account || (r.id === null && owner === account)) { merged += r.merged; closed += r.closed; }
    const o = over.get(a.login.toLowerCase());
    const override = o?.status === "deny" ? "deny" : o?.status === "allow" && account !== null && o.github_id === account ? "allow" : null;
    out.set(tierKey(a), { merged, closed, override });
  }
  return out;
}

/** Tiers of the given authors, from one stats query (see standings: history and an allow count only for their own account). */
export async function tiersOf(db: Db, authors: AuthorRef[]): Promise<Map<string, Tier>> {
  const rule = await getRule(db);
  return new Map([...await standings(db, authors)].map(([k, s]) => [k, tierOf(s.merged, s.closed, s.override, rule)]));
}

export async function contributors(db: Db, opts: { repo?: string; login?: string } = {}): Promise<Contributor[]> {
  const rule = await getRule(db);
  const where = [opts.repo ? "AND repo = :repo" : "", opts.login ? "AND author = :login" : ""].join(" ");
  const params: Record<string, string | number> = {};
  if (opts.repo) params.repo = opts.repo;
  if (opts.login) params.login = opts.login;
  // Stats always come from every repo; the repo filter only picks who is listed.
  const rows = await db.prepare(`
    WITH s AS (${STATS_SQL} GROUP BY author),
    r AS (SELECT author, ${db.dialect === "postgres" ? "string_agg(DISTINCT repo, ',' ORDER BY repo)" : "GROUP_CONCAT(DISTINCT repo)"} AS repos FROM items WHERE kind = 'pr' AND author IS NOT NULL ${where} GROUP BY author),
    j AS (
      SELECT r.author AS login, COALESCE(s.merged,0) AS merged, COALESCE(s.closed,0) AS closed, COALESCE(s.open,0) AS open,
             s.last_merge, r.repos, o.status AS override, o.note, o.by AS override_by, o.at AS override_at
      FROM r LEFT JOIN s ON s.login = r.author LEFT JOIN whitelist_overrides o ON ${ciEq(db, "o.login", "r.author")}
      UNION ALL
      SELECT o.login, 0, 0, 0, NULL, '', o.status, o.note, o.by, o.at FROM whitelist_overrides o
      WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.kind = 'pr' AND ${ciEq(db, "i.author", "o.login")}) ${opts.repo ? "AND FALSE" : ""} ${opts.login ? "AND o.login = :login" : ""}
    )
    SELECT j.* FROM j`).all(params) as Omit<Contributor, "rate" | "tier" | "override_in_effect">[];
  // History, override and tier are those of the account the login is bound to, as the merge rule reads them.
  const st = await standings(db, rows.map((r) => ({ login: r.login, id: null })));
  return rows.map((r) => {
    const s = st.get(tierKey({ login: r.login, id: null }))!;
    return { ...r, merged: s.merged, closed: s.closed, override_in_effect: r.override !== null && s.override === r.override,
      tier: tierOf(s.merged, s.closed, s.override, rule), rate: s.merged + s.closed > 0 ? s.merged / (s.merged + s.closed) : null };
  });
}

/** Whether the author account is whitelisted (by history or an allow override), with the facts; `id` null stands for the login's bound account. */
export async function isWhitelisted(db: Db, login: string, id: number | null): Promise<{ ok: boolean; reason: string }> {
  const rule = await getRule(db);
  const s = (await standings(db, [{ login, id }])).get(tierKey({ login, id }))!;
  if (s.override === "allow") return { ok: true, reason: "override: allow" };
  if (s.override === "deny") return { ok: false, reason: "override: deny" };
  const rate = s.merged + s.closed > 0 ? s.merged / (s.merged + s.closed) : 0;
  const ok = tierOf(s.merged, s.closed, null, rule) === "whitelisted";
  const facts = `${s.merged} merged, merge rate ${Math.round(rate * 100)}%; rule: ≥ ${rule.minMerged} merged and ≥ ${Math.round(rule.minRate * 100)}%`;
  return { ok, reason: facts };
}

export const OVERRIDE_LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

/**
 * Sets or clears the override of a login. `githubId` is the account the login names now (looked up by the caller): an allow
 * counts only for that account, so it needs one; a deny holds for any account under the login.
 */
export async function setOverride(db: Db, login: string, status: "allow" | "deny" | null, note: string | null, by: string, githubId: number | null = null): Promise<void> {
  if (!OVERRIDE_LOGIN.test(login)) throw new Error(`not a GitHub login: ${login}`);
  if (status === "allow" && githubId === null) throw new Error(`${login} is not a GitHub user`);
  if (status === null) {
    await db.prepare(`DELETE FROM whitelist_overrides WHERE ${ciEq(db, "login", "?")}`).run(login);
  } else {
    await db.prepare(`DELETE FROM whitelist_overrides WHERE ${ciEq(db, "login", "?")} AND login <> ?`).run(login, login);
    await db.prepare(upsert(db, { table: "whitelist_overrides", cols: ["login", "status", "note", "by", "at", "github_id"], key: ["login"] }))
      .run(login, status, note || null, by, new Date().toISOString(), githubId);
  }
  // The note is private: the audit row records only that one was given.
  await audit(db, by, "override", login, { status: status ?? "clear", note: note ? true : undefined, githubId: githubId ?? undefined });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function list(args: string[]): Promise<void> {
  const tier = flag(args, "--tier");
  const repo = flag(args, "--repo");
  const rows = (await contributors(await openDb(), { repo })).filter((c) => !tier || c.tier === tier)
    .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
  console.log(`${"login".padEnd(28)} ${"tier".padEnd(16)} ${"merged".padStart(6)} ${"closed".padStart(6)} ${"open".padStart(5)} ${"rate".padStart(5)}`);
  for (const c of rows) {
    console.log(`${c.login.padEnd(28)} ${TIER_LABEL[c.tier].padEnd(16)} ${String(c.merged).padStart(6)} ${String(c.closed).padStart(6)} ${String(c.open).padStart(5)} ${(c.rate === null ? "-" : `${Math.round(c.rate * 100)}%`).padStart(5)}`);
  }
}

async function show(args: string[]): Promise<void> {
  const login = args[0];
  if (!login) throw new Error("usage: whitelist show <login>");
  const db = await openDb();
  const c = (await contributors(db, { login }))[0];
  const w = await isWhitelisted(db, login, null);
  if (!c) {
    console.log(`${login}: no PRs in the mirror; ${w.ok ? "allowed" : "not allowed"} (${w.reason})`);
    return;
  }
  console.log(`${c.login}\n  tier: ${TIER_LABEL[c.tier]} (${w.reason})\n  merged ${c.merged}, closed unmerged ${c.closed}, open ${c.open}\n  last merge: ${c.last_merge ?? "-"}\n  repos: ${c.repos}`);
  if (c.override) console.log(`  override: ${c.override}${c.note ? ` — ${c.note}` : ""}`);
}

function override(status: "allow" | "deny" | null) {
  return async (args: string[]): Promise<void> => {
    const note = flag(args, "--note") ?? null;
    const login = args[0];
    if (!login) throw new Error(`usage: whitelist ${status ?? "clear"} <login>${status ? " [--note TEXT]" : ""}`);
    const id = status === "allow" ? await githubUserId(login) : status === "deny" ? await githubUserId(login).catch(() => null) : null;
    await setOverride(await openDb(), login, status, note, "cli", id);
    console.log(`${login}: ${status ?? "override cleared"}`);
  };
}

async function rule(args: string[]): Promise<void> {
  const db = await openDb();
  const cur = await getRule(db);
  const m = flag(args, "--min-merged");
  const r = flag(args, "--min-rate");
  if (m !== undefined || r !== undefined) {
    await setRule(db, { minMerged: m === undefined ? cur.minMerged : Number(m), minRate: r === undefined ? cur.minRate : Number(r) }, "cli");
  }
  const now = await getRule(db);
  console.log(`whitelisted: at least ${now.minMerged} merged PRs and a merge rate of at least ${now.minRate}`);
}

const SUB: Record<string, (args: string[]) => void | Promise<void>> = {
  list, show, allow: override("allow"), deny: override("deny"), clear: override(null), rule,
};

export const commands = {
  whitelist: {
    summary: "contributor whitelist: list [--tier T] [--repo R] | show LOGIN | allow|deny LOGIN [--note T] | clear LOGIN | rule [--min-merged N] [--min-rate R]",
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      const fn = sub ? SUB[sub] : undefined;
      if (!fn) {
        console.log(`usage: autocraft-server whitelist ${Object.keys(SUB).join("|")} ...`);
        process.exit(sub ? 1 : 0);
      }
      await fn(rest);
    },
  },
};

// Per-repo list of optional checks, set by an operator: checks whose failure does not stop a merge, make main red
// or count as a failure to fix. Exact check names. Every other check must still be green.
import { audit } from "./dash/audit.ts";
import * as kx from "./db/kx.ts";
import { setting } from "./settings-read.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";

const key = (repo: string) => `optional_checks:${repo}`;

const parseList = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
};

export async function optionalChecks(db: Db, repo: string): Promise<string[]> {
  return parseList(await setting(db, key(repo)));
}

/** optionalChecks() of every repo, read in one query. */
export async function optionalChecksOf(db: Db): Promise<(repo: string) => string[]> {
  const rows = new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"])
    .where((eb) => kx.like(db, "key", eb.val(`${kx.likeEscape("optional_checks:")}%`), "\\")))).map((r) => [r.key, r.value ?? undefined]));
  return (repo) => parseList(rows.get(key(repo)));
}

async function save(db: Db, repo: string, names: string[]): Promise<void> {
  if (!names.length) await db.run(db.k.deleteFrom("main.settings").where("key", "=", key(repo)));
  else await db.run(db.k.insertInto("main.settings").values({ key: key(repo), value: JSON.stringify(names) }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
}

/** Returns false when nothing changed. */
export async function setOptionalCheck(db: Db, by: string, repo: string, name: string, on: boolean): Promise<boolean> {
  const check = name.trim();
  if (!check) throw new Error("the check name is empty");
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new Error(`${repo} is not tracked`);
  const cur = await optionalChecks(db, repo);
  if (cur.includes(check) === on) return false;
  await save(db, repo, on ? [...cur, check] : cur.filter((c) => c !== check));
  await audit(db, by, on ? "optional-check-add" : "optional-check-remove", repo, { check });
  return true;
}

type CheckLike = { name: string; state: string };

/**
 * The CI state merging acts on: a failure whose failing checks are all on the optional list reads as if those
 * checks had not run (success when nothing else is pending or failing and some other check succeeded).
 * The stored `overall` and `checks` stay as GitHub reported them.
 */
export function effectiveOverall(overall: string, checks: CheckLike[], optional: string[]): string {
  if (overall !== "failure" || !optional.length) return overall;
  const failing = checks.filter((c) => c.state === "failure");
  if (!failing.length || failing.some((c) => !optional.includes(c.name))) return overall;
  const rest = checks.filter((c) => c.state !== "failure").map((c) => c.state);
  if (rest.includes("pending")) return "pending";
  return rest.includes("success") ? "success" : "none";
}

/** effectiveOverall with the repo's list and the PR's stored checks (JSON text or parsed). */
export async function effectiveCi(db: Db, repo: string, overall: string, checks: string | CheckLike[] | null | undefined): Promise<string> {
  if (overall !== "failure") return overall;
  return effectiveCiWith(await optionalChecks(db, repo), overall, checks);
}

/** effectiveCi with the repo's optional list given (optionalChecksOf). */
export function effectiveCiWith(optional: string[], overall: string, checks: string | CheckLike[] | null | undefined): string {
  if (overall !== "failure") return overall;
  let list: CheckLike[] = [];
  try { list = typeof checks === "string" ? (JSON.parse(checks) as CheckLike[]) : checks ?? []; } catch { /* unreadable: stays failure */ }
  return effectiveOverall(overall, list, optional);
}

/** Check names seen on the repo's recent PRs and default-branch heads, for the add control. */
export async function seenChecks(db: Db, repo: string): Promise<string[]> {
  const names = new Set<string>();
  const rows = (await Promise.all([
    db.all(db.k.selectFrom("main.pr_checks").select("checks").where("repo", "=", repo).orderBy("fetched_at", "desc").limit(40)),
    db.all(db.k.selectFrom("main.main_ci").select("checks").where("repo", "=", repo).orderBy("updated_at", "desc").limit(10)),
  ])).flat();
  for (const r of rows) {
    try { for (const c of JSON.parse(r.checks) as { name?: string }[]) if (c.name) names.add(c.name); } catch { /* skip */ }
  }
  return [...names].sort();
}

export const commands = {
  "optional-checks": {
    summary: "optional-checks [--repo R] | add R NAME | remove R NAME: the checks whose failure does not stop a merge",
    async run(args: string[]): Promise<void> {
      const { connect } = await import("./db.ts");
      const db = await openDb();
      const [verb, repo, ...rest] = args;
      if (verb === "add" || verb === "remove") {
        const name = rest.join(" ");
        if (!repo || !name) { console.error("usage: autocraft-server optional-checks add|remove REPO NAME"); process.exit(2); }
        try {
          const changed = await setOptionalCheck(db, "cli", repo, name, verb === "add");
          console.log(changed ? `${repo}: ${verb === "add" ? "added" : "removed"} ${name}` : `${repo}: ${name} was ${verb === "add" ? "already" : "not"} listed`);
        } catch (e) {
          console.error((e as Error).message);
          process.exit(1);
        }
        return;
      }
      const only = verb === "--repo" ? repo : undefined;
      if (verb && !only) { console.error("usage: autocraft-server optional-checks [--repo R] | add R NAME | remove R NAME"); process.exit(2); }
      const repos = (await db.all(db.k.selectFrom("main.tracked_repos").select("name").orderBy("name"))).map((r) => r.name).filter((r) => !only || r === only);
      for (const r of repos) {
        const list = await optionalChecks(db, r);
        if (list.length || only) console.log(`${r}: ${list.length ? list.join("; ") : "none"}`);
      }
    },
  },
};

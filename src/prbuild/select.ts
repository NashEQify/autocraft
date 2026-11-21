// The PRs that get our own build (pr-builds feature): open, non-draft PRs of a public repo whose head has no build yet.
// Scope per repo (settings `pr_builds_scope:<repo>`): "outside" (default) builds only outside authors' PRs, "all" every PR.
import { isOutsideAuthor, holdMap } from "../outside.ts";
import { currentHeadExpr } from "../verify/results.ts";
import { baseScopeRepos } from "../pilot.ts";
import { isFastTracked } from "../fasttrack.ts";
import { cachedRust, type RustCheck } from "../verify/candidates.ts";
import { setting as settingValue } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export type PrBuildScope = "outside" | "all";
export const DEFAULT_PER_DAY = 10;
export const DAY_MS = 24 * 3600_000;
const SCOPE_KEY = (repo: string): string => `pr_builds_scope:${repo}`;
const PER_DAY_KEY = "pr_builds_per_day";

const setting = async (db: Db, key: string): Promise<string | null> =>
  await settingValue(db, key) ?? null;

export async function scopeOf(db: Db, repo: string): Promise<PrBuildScope> {
  return await setting(db, SCOPE_KEY(repo)) === "all" ? "all" : "outside";
}

export async function setScope(db: Db, repo: string, scope: PrBuildScope): Promise<void> {
  await db.run(db.k.insertInto("main.settings").values({ key: SCOPE_KEY(repo), value: scope }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
}

/** Builds a repo may start in 24 hours; 0 starts none. */
export async function perDayOf(db: Db): Promise<number> {
  const v = Number(await setting(db, PER_DAY_KEY));
  return await setting(db, PER_DAY_KEY) !== null && Number.isInteger(v) && v >= 0 ? v : DEFAULT_PER_DAY;
}

export async function setPerDay(db: Db, n: number): Promise<void> {
  await db.run(db.k.insertInto("main.settings").values({ key: PER_DAY_KEY, value: String(n) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
}

export type PrBuildCandidate = { repo: string; number: number; head: string; /** Whether the repo is known to be a Rust workspace at the head; null before its crate list was fetched. */ rust: boolean | null };

/** Whether the worker would claim a build task for the PR: its repo is in the pipeline's scope, or the PR is fast-tracked (as `claim` in src/build/tasks.ts). */
export async function inBuildScope(db: Db, repo: string, number: number, scope?: Set<string>): Promise<boolean> {
  if (scope === undefined) scope = await baseScopeRepos(db);
  return scope.has(repo) || await isFastTracked(db, repo, number);
}

/** The PRs to build now, oldest first, within the repo's daily cap. Writes nothing. */
export async function selectPrBuilds(db: Db, repo: string, o: { rust?: RustCheck; now?: number } = {}): Promise<PrBuildCandidate[]> {
  if (!await db.get(db.k.selectFrom("repos").select((eb) => eb.lit(1).as("one")).where("name", "=", repo).where("visibility", "=", "public"))) return [];
  const rust = o.rust ?? cachedRust;
  const used = (await db.get(db.k.selectFrom("main.pr_builds").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", repo)
    .where("created_at", ">", new Date((o.now ?? Date.now()) - DAY_MS).toISOString())))!.n;
  const room = await perDayOf(db) - used;
  if (room <= 0) return [];
  const rows = await db.all(db.k.selectFrom("items as i").leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "i.repo").onRef("c.number", "=", "i.number"))
    .select((eb) => ["i.number", "i.author", "i.author_association", "i.author_type", currentHeadExpr(eb).as("head")])
    .where("i.repo", "=", repo).where("i.kind", "=", "pr").where("i.state", "=", "OPEN").where((eb) => eb(eb.fn.coalesce("i.is_draft", eb.lit(0)), "=", 0))
    .orderBy("i.created_at", (o) => o.asc().nullsFirst()).orderBy("i.number"));
  const all = await scopeOf(db, repo) === "all";
  const held = await holdMap(db);
  const have = async (number: number, head: string) => await db.get(db.k.selectFrom("main.pr_builds").select((eb) => eb.lit(1).as("one"))
    .where("repo", "=", repo).where("number", "=", number).where("head_sha", "=", head));
  const scope = await baseScopeRepos(db);
  const out: PrBuildCandidate[] = [];
  for (const r of rows) {
    if (!r.head || await have(r.number, r.head) || held.has(`${repo}#${r.number}`)) continue;
    if (!await inBuildScope(db, repo, r.number, scope)) continue;
    if (!all && !await isOutsideAuthor(db, r)) continue;
    const isRust = rust(repo, r.head);
    if (isRust === false) continue;
    out.push({ repo, number: r.number, head: r.head, rust: isRust });
    if (out.length >= room) break;
  }
  return out;
}

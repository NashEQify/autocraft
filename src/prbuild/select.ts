// The PRs that get our own build (pr-builds feature): open, non-draft PRs of a public repo whose head has no build yet.
// Scope per repo (settings `pr_builds_scope:<repo>`): "outside" (default) builds only outside authors' PRs, "all" every PR.
import { isOutsideAuthor, holdMap } from "../outside.ts";
import { CURRENT_HEAD_SQL } from "../verify/results.ts";
import { baseScopeRepos } from "../pilot.ts";
import { isFastTracked } from "../fasttrack.ts";
import { cachedRust, type RustCheck } from "../verify/candidates.ts";
import { setting as settingValue } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

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
  await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCOPE_KEY(repo), scope);
}

/** Builds a repo may start in 24 hours; 0 starts none. */
export async function perDayOf(db: Db): Promise<number> {
  const v = Number(await setting(db, PER_DAY_KEY));
  return await setting(db, PER_DAY_KEY) !== null && Number.isInteger(v) && v >= 0 ? v : DEFAULT_PER_DAY;
}

export async function setPerDay(db: Db, n: number): Promise<void> {
  await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(PER_DAY_KEY, String(n));
}

export type PrBuildCandidate = { repo: string; number: number; head: string; /** Whether the repo is known to be a Rust workspace at the head; null before its crate list was fetched. */ rust: boolean | null };

type Row = { number: number; author: string | null; author_association: string | null; author_type: string | null; head: string | null };

/** Whether the worker would claim a build task for the PR: its repo is in the pipeline's scope, or the PR is fast-tracked (as `claim` in src/build/tasks.ts). */
export async function inBuildScope(db: Db, repo: string, number: number, scope?: Set<string>): Promise<boolean> {
  if (scope === undefined) scope = await baseScopeRepos(db);
  return scope.has(repo) || await isFastTracked(db, repo, number);
}

/** The PRs to build now, oldest first, within the repo's daily cap. Writes nothing. */
export async function selectPrBuilds(db: Db, repo: string, o: { rust?: RustCheck; now?: number } = {}): Promise<PrBuildCandidate[]> {
  if (!await db.prepare("SELECT 1 FROM repos WHERE name = ? AND visibility = 'public'").get(repo)) return [];
  const rust = o.rust ?? cachedRust;
  const used = (await db.prepare("SELECT COUNT(*) AS n FROM main.pr_builds WHERE repo = ? AND created_at > ?").get(repo, new Date((o.now ?? Date.now()) - DAY_MS).toISOString()) as { n: number }).n;
  const room = await perDayOf(db) - used;
  if (room <= 0) return [];
  const rows = await db.prepare(`SELECT i.number, i.author, i.author_association, i.author_type, ${CURRENT_HEAD_SQL} AS head FROM items i
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND COALESCE(i.is_draft, 0) = 0 ORDER BY i.created_at, i.number`).all(repo) as Row[];
  const all = await scopeOf(db, repo) === "all";
  const held = await holdMap(db);
  const have = db.prepare("SELECT 1 FROM main.pr_builds WHERE repo = ? AND number = ? AND head_sha = ?");
  const scope = await baseScopeRepos(db);
  const out: PrBuildCandidate[] = [];
  for (const r of rows) {
    if (!r.head || await have.get(repo, r.number, r.head) || held.has(`${repo}#${r.number}`)) continue;
    if (!await inBuildScope(db, repo, r.number, scope)) continue;
    if (!all && !isOutsideAuthor(db, r)) continue;
    const isRust = rust(repo, r.head);
    if (isRust === false) continue;
    out.push({ repo, number: r.number, head: r.head, rust: isRust });
    if (out.length >= room) break;
  }
  return out;
}

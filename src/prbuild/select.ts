// The PRs that get our own build (pr-builds feature): open, non-draft PRs of a public repo whose head has no build yet.
// Scope per repo (settings `pr_builds_scope:<repo>`): "outside" (default) builds only outside authors' PRs, "all" every PR.
import { loadHolds, isOutsideAuthor, loadInsiders } from "../data/intake/index.ts";
import { config, saveSettings, withConfig } from "../data/control/index.ts";
import { loadPrBuildState } from "../data/merge/index.ts";
import { listItems, loadRepos } from "../data/mirror/index.ts";
import { cachedRust, type RustCheck } from "../verify/candidates.ts";
import type { Db } from "../db/index.ts";

export type PrBuildScope = "outside" | "all";
export const DEFAULT_PER_DAY = 10;
export const DAY_MS = 24 * 3600_000;

export async function scopeOf(db: Db, repo: string): Promise<PrBuildScope> {
  return await withConfig(db, async () => config(db).repo(repo).prBuildsScope);
}

export async function setScope(db: Db, repo: string, scope: PrBuildScope, by = "system"): Promise<void> {
  await saveSettings(db, [{ key: "pr_builds_scope", repo, value: scope }], by, { action: "build-feature", target: "pr-builds", details: { feature: "pr-builds", scope, repo } });
}

/** Builds a repo may start in 24 hours; 0 starts none. */
export async function perDayOf(db: Db): Promise<number> {
  return await withConfig(db, async () => config(db).prBuildsPerDay);
}

export async function setPerDay(db: Db, n: number, by = "system"): Promise<void> {
  await saveSettings(db, [{ key: "pr_builds_per_day", value: String(n) }], by, { action: "build-feature", target: "pr-builds", details: { feature: "pr-builds", perDay: n } });
}

export type PrBuildCandidate = { repo: string; number: number; head: string; /** Whether the repo is known to be a Rust workspace at the head; null before its crate list was fetched. */ rust: boolean | null };

/** The numbers among `numbers` whose PR the worker would claim a build task for: the PR is in the pipeline's scope. One statement. */
export async function buildScope(db: Db, repo: string, numbers: number[]): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  return new Set((await listItems(db, { repos: [repo], numbers, inScope: true }, "ref")).map((i) => i.number));
}

/** The PRs to build now, oldest first, within the repo's daily cap. Writes nothing. */
export async function selectPrBuilds(db: Db, repo: string, o: { rust?: RustCheck; now?: number } = {}): Promise<PrBuildCandidate[]> {
  return await withConfig(db, async () => {
    const [row, state] = await db.together(() => Promise.all([
      loadRepos(db, { names: [repo] }),
      loadPrBuildState(db, repo, (o.now ?? Date.now()) - DAY_MS),
    ]));
    if (row.get(repo)?.visibility !== "public") return [];
    const room = config(db).prBuildsPerDay - state.usedSince;
    if (room <= 0) return [];
    const all = config(db).repo(repo).prBuildsScope === "all";
    const [items, insiders] = await db.together(() => Promise.all([
      listItems(db, { repos: [repo], kind: "pr", states: ["OPEN"], inScope: true }, "text"),
      all ? Promise.resolve(new Set<string>()) : loadInsiders(db),
    ]));
    const open = items.filter((i) => !i.is_draft && i.head_oid && !state.have.has(`${i.number}@${i.head_oid}`))
      .sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at === null ? -1 : b.created_at === null ? 1 : a.created_at < b.created_at ? -1 : 1) || a.number - b.number);
    const held = await loadHolds(db, open.map((i) => ({ repo, number: i.number })));
    const rust = o.rust ?? cachedRust;
    const out: PrBuildCandidate[] = [];
    for (const r of open) {
      if (held.has(`${repo}#${r.number}`)) continue;
      if (!all && !isOutsideAuthor(r, insiders)) continue;
      const isRust = rust(repo, r.head_oid!);
      if (isRust === false) continue;
      out.push({ repo, number: r.number, head: r.head_oid!, rust: isRust });
      if (out.length >= room) break;
    }
    return out;
  });
}

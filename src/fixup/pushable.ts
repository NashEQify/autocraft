// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable, unless the
// branch is a long-lived one (the default branch, another PR's base, a release branch).
import { slugOf } from "../owners.ts";
import type { Db } from "../db/index.ts";

/** Branch names that are long-lived whatever the repository says. */
const TRUSTED = "('OWNER', 'MEMBER', 'COLLABORATOR')";
const LONG_LIVED = /^(release|main|master|develop|stable|hotfix|integration|next|staging|production|beta|trunk|gh-pages)([/._-].*)?$|^v?\d+(\.\d+)*(\.x)?$/i;

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${slugOf(repo)}`.toLowerCase();
}

export type LongLived = (branch: string) => boolean;

/** Decides whether a branch of `repo` is long-lived: its default branch, the base of any PR, a release-like name, or a head shared by several open PRs. */
export async function longLivedOf(db: Db, repo: string): Promise<LongLived> {
  const names = new Set<string>();
  const d = (await db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch;
  if (d) names.add(d);
  // Every open PR's base counts, whoever opened it: a retargeted PR can only make another PR unpushable, the safe failure.
  for (const r of await db.prepare("SELECT DISTINCT base_ref FROM items WHERE repo = ? AND kind = 'pr' AND base_ref IS NOT NULL").all(repo) as { base_ref: string }[]) names.add(r.base_ref);
  // A same-repo branch that several open PRs use as their head is shared, not one contributor's.
  for (const r of await db.prepare(`SELECT head_ref FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN' AND lower(head_repo) = ? AND head_ref IS NOT NULL AND author_association IN ${TRUSTED} GROUP BY head_ref HAVING COUNT(*) > 1`).all(repo, `${slugOf(repo)}`.toLowerCase()) as { head_ref: string }[]) names.add(r.head_ref);
  return (branch) => names.has(branch) || LONG_LIVED.test(branch);
}

/** longLivedOf() for every repo, from one reading of the default branches and PR branches. */
export async function longLivedAll(db: Db): Promise<(repo: string) => LongLived> {
  const names = new Map<string, Set<string>>();
  const add = (repo: string, branch: string): void => { (names.get(repo) ?? names.set(repo, new Set()).get(repo)!).add(branch); };
  for (const r of await db.prepare("SELECT name, default_branch FROM repos WHERE default_branch IS NOT NULL").all() as { name: string; default_branch: string }[]) if (r.default_branch) add(r.name, r.default_branch);
  for (const r of await db.prepare("SELECT DISTINCT repo, base_ref FROM items WHERE kind = 'pr' AND base_ref IS NOT NULL").all() as { repo: string; base_ref: string }[]) add(r.repo, r.base_ref);
  for (const r of await db.prepare(`SELECT repo, lower(head_repo) AS head_repo, head_ref FROM items WHERE kind = 'pr' AND state = 'OPEN' AND head_ref IS NOT NULL AND author_association IN ${TRUSTED}
    GROUP BY repo, lower(head_repo), head_ref HAVING COUNT(*) > 1`).all() as { repo: string; head_repo: string | null; head_ref: string }[])
    if (r.head_repo === `${slugOf(r.repo)}`.toLowerCase()) add(r.repo, r.head_ref);
  return (repo) => (branch) => !!names.get(repo)?.has(branch) || LONG_LIVED.test(branch);
}

/**
 * A PR is pushable when its head is in the base repository (on a branch that isn't long-lived) or maintainers may
 * modify it. `branch` is the head branch name; a same-repo head without one is not pushable, nor is one whose author cannot write to the repository.
 */
export function pushable(headRepo: string | null | undefined, repo: string, canModify: boolean | number | null | undefined, branch: string | null | undefined, longLived: LongLived = (b) => LONG_LIVED.test(b), protectedBranch = false, authorCanWrite = false): boolean {
  if (sameRepo(headRepo, repo)) return authorCanWrite && !!branch && !protectedBranch && !longLived(branch);
  return !!canModify;
}

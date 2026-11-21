// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable, unless the
// branch is a long-lived one (the default branch, another PR's base, a release branch).
import { slugOf } from "../owners.ts";
import type { Db } from "../db/index.ts";

/** Branch names that are long-lived whatever the repository says. */
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];
const LONG_LIVED = /^(release|main|master|develop|stable|hotfix|integration|next|staging|production|beta|trunk|gh-pages)([/._-].*)?$|^v?\d+(\.\d+)*(\.x)?$/i;

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${slugOf(repo)}`.toLowerCase();
}

export type LongLived = (branch: string) => boolean;

/** Decides whether a branch of `repo` is long-lived: its default branch, the base of any PR, a release-like name, or a head shared by several open PRs. */
export async function longLivedOf(db: Db, repo: string): Promise<LongLived> {
  const names = new Set<string>();
  const d = (await db.get(db.k.selectFrom("repos").select("default_branch").where("name", "=", repo)))?.default_branch;
  if (d) names.add(d);
  // Every open PR's base counts, whoever opened it: a retargeted PR can only make another PR unpushable, the safe failure.
  for (const r of await db.all(db.k.selectFrom("items").select("base_ref").distinct().where("repo", "=", repo).where("kind", "=", "pr").where("base_ref", "is not", null).$narrowType<{ base_ref: string }>())) names.add(r.base_ref);
  // A same-repo branch that several open PRs use as their head is shared, not one contributor's.
  for (const r of await db.all(db.k.selectFrom("items").select("head_ref").where("repo", "=", repo).where("kind", "=", "pr").where("state", "=", "OPEN")
    .where((eb) => eb(eb.fn<string | null>("lower", ["head_repo"]), "=", `${slugOf(repo)}`.toLowerCase()))
    .where("head_ref", "is not", null).where("author_association", "in", TRUSTED).groupBy("head_ref").having((eb) => eb.fn.countAll(), ">", 1)
    .$narrowType<{ head_ref: string }>())) names.add(r.head_ref);
  return (branch) => names.has(branch) || LONG_LIVED.test(branch);
}

/** longLivedOf() for every repo, from one reading of the default branches and PR branches. */
export async function longLivedAll(db: Db): Promise<(repo: string) => LongLived> {
  const names = new Map<string, Set<string>>();
  const add = (repo: string, branch: string): void => { (names.get(repo) ?? names.set(repo, new Set()).get(repo)!).add(branch); };
  for (const r of await db.all(db.k.selectFrom("repos").select(["name", "default_branch"]).where("default_branch", "is not", null).$narrowType<{ default_branch: string }>())) if (r.default_branch) add(r.name, r.default_branch);
  for (const r of await db.all(db.k.selectFrom("items").select(["repo", "base_ref"]).distinct().where("kind", "=", "pr").where("base_ref", "is not", null).$narrowType<{ base_ref: string }>())) add(r.repo, r.base_ref);
  for (const r of await db.all(db.k.selectFrom("items").select((eb) => ["repo", eb.fn<string | null>("lower", ["head_repo"]).as("head_repo"), "head_ref"])
    .where("kind", "=", "pr").where("state", "=", "OPEN").where("head_ref", "is not", null).where("author_association", "in", TRUSTED)
    .groupBy((eb) => ["repo", eb.fn("lower", ["head_repo"]), "head_ref"]).having((eb) => eb.fn.countAll(), ">", 1).$narrowType<{ head_ref: string }>()))
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

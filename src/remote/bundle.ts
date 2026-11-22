// The task bundle of a remote call: what the helper needs to run one prompt as the server would, with the checkouts as
// mounts it fetches itself (public repos from GitHub, private ones as tarballs from the server) and small files inline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ItemRef } from "../../web/src/api/types.ts";
import { CLAUDE_PROMPTS, type ClaudePromptId } from "../prompts/index.ts";
import { repoOfCheckout } from "../sandbox/repo-docs.ts";
import { REPO_DOCS_PATH, REPO_PATH, reposPath } from "../sandbox/command.ts";
import { tierOfModel } from "./mode.ts";
import type { Mount, Tier } from "./protocol.ts";
import { findSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

/** The MCP server of a call's reference documentation in the user-local mode, served per lease; there is no /reference mount. */
export const REFERENCE_SERVER = "reference";

/** The tier of a prompt: that of its default model. */
export const promptTier = (id: ClaudePromptId): Tier => tierOfModel(CLAUDE_PROMPTS[id].models[0]!);

/** The repo and commit of a checkout under the checkout root (`<root>/<repo>/<sha>`), or null for any other directory. */
export function checkoutCommit(dir: string): { repo: string; sha: string } | null {
  const repo = repoOfCheckout(dir), sha = basename(dir);
  return repo && /^[0-9a-f]{40,64}$/.test(sha) ? { repo, sha } : null;
}

const repoRow = async (db: Db, repo: string): Promise<{ owner: string; visibility: string | null }> =>
  (await db.get(db.k.selectFrom("main.repos").select(["owner", "visibility"]).where("name", "=", repo))) ?? { owner: "", visibility: null };

/** A repo at a commit: a git mount for a public repo (with the pull request's head ref when the commit is a head of one of `items`), else a tarball the server serves. */
async function repoMount(db: Db, path: string, repo: string, sha: string, items: ItemRef[]): Promise<Mount> {
  const r = await repoRow(db, repo);
  if (r.visibility !== "public" || !r.owner) return { kind: "tarball", path, repo, sha };
  const pr = await findSeq(items, async (i) => i.repo === repo && await db.get(db.k.selectFrom("main.items").select("number").where("repo", "=", repo).where("number", "=", i.number).where("kind", "=", "pr").where("head_oid", "=", sha)) !== undefined);
  return { kind: "git", path, owner: r.owner, repo, sha, ...(pr && { ref: `refs/pull/${pr.number}/head` }) };
}

/** The files of a small host directory (no subdirectories), inline. */
function filesMount(path: string, dir: string): Mount {
  const files = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort().map((name) => ({ name, base64: readFileSync(join(dir, name)).toString("base64") }));
  return { kind: "files", path, files };
}

/** The read-only mounts of a sandboxed call: the item's checkout at /repo, the workspace at /repos/<name> (public repos only), the repo docs at /repo-docs. */
export async function bundleMounts(db: Db, at: { repo: string; sha: string }, items: ItemRef[], shared: { name: string; dir: string }[] = [], docsDir?: string): Promise<Mount[]> {
  const out: Mount[] = [await repoMount(db, REPO_PATH, at.repo, at.sha, items)];
  for (const s of shared) {
    const c = checkoutCommit(s.dir);
    if (c) out.push(await repoMount(db, reposPath(s.name), c.repo, c.sha, items));
  }
  if (docsDir) out.push(filesMount(REPO_DOCS_PATH, docsDir));
  return out;
}

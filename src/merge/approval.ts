// Per-repo approval for the pipeline to merge pull requests there. Set only
// from the dashboard by an operator (src/dash/api/admin.ts). Tracked repos
// include ones we do not maintain, so merging is opt-in per repo.
import { audit } from "../dash/audit.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type MergeApproval = { by: string; at: string };
const key = (repo: string) => `merge_approved:${repo}`;

export async function mergeApprovalOf(db: Db, repo: string): Promise<MergeApproval | null> {
  const value = await setting(db, key(repo));
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as MergeApproval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export async function setMergeApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  if ((await mergeApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?)").run(key(repo), JSON.stringify({ by, at: new Date().toISOString() }));
  else await db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  await audit(db, by, approved ? "merge-approve" : "merge-revoke", repo);
  return true;
}

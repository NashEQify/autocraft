// Per-repo approval for the pipeline to open fix PRs for issues there (push to the pipeline fork, open a PR,
// comment on the issue). Set only from the dashboard by an operator (src/dash/api/admin.ts).
import { audit } from "../dash/audit.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type FixIssueApproval = { by: string; at: string };
const key = (repo: string) => `fixissue_approved:${repo}`;

export async function fixIssueApprovalOf(db: Db, repo: string): Promise<FixIssueApproval | null> {
  const value = await setting(db, key(repo));
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as FixIssueApproval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export async function setFixIssueApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  if ((await fixIssueApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?)").run(key(repo), JSON.stringify({ by, at: new Date().toISOString() }));
  else await db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  await audit(db, by, approved ? "fixissue-approve" : "fixissue-revoke", repo);
  return true;
}

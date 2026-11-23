// Per-repo approval for the pipeline to open fix PRs for issues there (push to the pipeline fork, open a PR,
// Set from the dashboard by an operator or a maintainer with write access to the repo (src/dash/api/admin.ts).
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
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new Error(`${repo} is not tracked`);
  if ((await fixIssueApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.run(db.k.insertInto("main.settings").values({ key: key(repo), value: JSON.stringify({ by, at: new Date().toISOString() }) }));
  else await db.run(db.k.deleteFrom("main.settings").where("key", "=", key(repo)));
  await audit(db, by, approved ? "fixissue-approve" : "fixissue-revoke", repo);
  return true;
}

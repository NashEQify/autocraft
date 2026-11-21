// Per-repo approval for the pipeline to push fix-up commits to contributors'
// branches there. Set only from the dashboard by an operator
// (src/dash/api/admin.ts); pushing is opt-in per repo like merging.
import { audit } from "../dash/audit.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type PushApproval = { by: string; at: string };
const key = (repo: string) => `push_approved:${repo}`;

export async function pushApprovalOf(db: Db, repo: string): Promise<PushApproval | null> {
  const value = await setting(db, key(repo));
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as PushApproval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export async function setPushApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  if ((await pushApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?)").run(key(repo), JSON.stringify({ by, at: new Date().toISOString() }));
  else await db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  await audit(db, by, approved ? "push-approve" : "push-revoke", repo);
  return true;
}

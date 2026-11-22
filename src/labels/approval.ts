// Per-repo approval to write labels to GitHub. Set only from the dashboard by an
// operator (src/dash/api/admin.ts); the CLI reads it and has no way to set it.
import { audit } from "../dash/audit.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type Approval = { by: string; at: string };
const key = (repo: string) => `labels_approved:${repo}`;

export async function approvalOf(db: Db, repo: string): Promise<Approval | null> {
  const value = await setting(db, key(repo));
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as Approval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export async function setApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new Error(`${repo} is not tracked`);
  const had = await approvalOf(db, repo) !== null;
  if (had === approved) return false;
  if (approved) {
    await db.run(db.k.insertInto("main.settings").values({ key: key(repo), value: JSON.stringify({ by, at: new Date().toISOString() }) }));
  } else {
    await db.run(db.k.deleteFrom("main.settings").where("key", "=", key(repo)));
  }
  await audit(db, by, approved ? "labels-approve" : "labels-revoke", repo);
  return true;
}

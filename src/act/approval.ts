// Per-repo approval for the pipeline to post comments and close items there.
// Set only from the dashboard by an operator (src/dash/api/admin.ts).
import { audit } from "../dash/audit.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type CommentApproval = { by: string; at: string };
const key = (repo: string) => `comment_approved:${repo}`;

export async function commentApprovalOf(db: Db, repo: string): Promise<CommentApproval | null> {
  const value = await setting(db, key(repo));
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as CommentApproval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export async function setCommentApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select((eb) => eb.lit(1).as("one")).where("name", "=", repo))) throw new Error(`${repo} is not tracked`);
  if ((await commentApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.run(db.k.insertInto("main.settings").values({ key: key(repo), value: JSON.stringify({ by, at: new Date().toISOString() }) }));
  else await db.run(db.k.deleteFrom("main.settings").where("key", "=", key(repo)));
  await audit(db, by, approved ? "comment-approve" : "comment-revoke", repo);
  return true;
}

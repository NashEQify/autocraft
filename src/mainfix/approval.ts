// Per-repo approval for the pipeline to act on a red default branch: rerun the failed jobs, and open an issue
// when an operator answered a decision that asks for it. Set only from the dashboard by an operator (src/dash/api/admin.ts).
import { audit } from "../dash/audit.ts";
import { setting, settings } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export type MainFixApproval = { by: string; at: string };
const key = (repo: string) => `mainfix_approved:${repo}`;

const parse = (value: string): MainFixApproval | null => {
  try {
    return JSON.parse(value) as MainFixApproval;
  } catch {
    return null;
  }
};

export async function mainFixApprovalOf(db: Db, repo: string): Promise<MainFixApproval | null> {
  const value = await setting(db, key(repo));
  return value === undefined ? null : parse(value);
}

/** The approvals of many repos in one read; repos without one are left out. */
export async function mainFixApprovals(db: Db, repos: string[]): Promise<Map<string, MainFixApproval | null>> {
  const out = new Map<string, MainFixApproval | null>();
  if (!repos.length) return out;
  const byKey = new Map(repos.map((r) => [key(r), r]));
  for (const [k, value] of await settings(db, [...byKey.keys()])) out.set(byKey.get(k)!, parse(value));
  return out;
}

// Returns false when nothing changed.
export async function setMainFixApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new Error(`${repo} is not tracked`);
  if ((await mainFixApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) await db.run(db.k.insertInto("main.settings").values({ key: key(repo), value: JSON.stringify({ by, at: new Date().toISOString() }) }));
  else await db.run(db.k.deleteFrom("main.settings").where("key", "=", key(repo)));
  await audit(db, by, approved ? "mainfix-approve" : "mainfix-revoke", repo);
  return true;
}

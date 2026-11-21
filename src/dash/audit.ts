import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

// An unauthenticated caller can make this row by signing in with any GitHub
// account, so it is written once per login per hour; later refusals add to the
// `refused` count in that row's details.
export async function auditRefusedSignIn(db: Db, login: string, details: Record<string, unknown>): Promise<void> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const last = await db.get(db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "details"])
    .where("action", "=", "sign-in-refused").where("login", "=", login).where("at", ">", since).orderBy("at", "desc").limit(1));
  if (!last) return await audit(db, login, "sign-in-refused", login, { ...details, refused: 1 });
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(last.details ?? "{}") as Record<string, unknown>;
  } catch { /* unreadable: start the count again */ }
  const refused = (typeof prev.refused === "number" ? prev.refused : 1) + 1;
  await db.run(db.k.updateTable("audit").set({ details: JSON.stringify({ ...prev, refused }) }).where(kx.rowid("audit"), "=", last.rowid));
}

export async function audit(db: Db, login: string, action: string, target: string | null, details?: unknown): Promise<void> {
  await db.run(db.k.insertInto("audit").values({
    at: new Date().toISOString(), login, action, target, details: details === undefined ? null : JSON.stringify(details),
  }));
}

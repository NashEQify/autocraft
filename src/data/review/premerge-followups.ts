// premerge_followups: the follow-up issue of a PR approved for merge, one row per PR head whose pre-merge review had defects that do not stop the merge.
import type { Selectable } from "kysely";
import type { Db } from "../../db/index.ts";
import type { DB } from "../../db/types.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { noKeys, pushTo, refKey } from "./rows.ts";
import type { RefKey } from "./types.ts";

export type PremergeFollowupRow = Selectable<DB["premerge_followups"]>;

/** The rows of each PR, oldest first. */
export async function loadPremergeFollowups(db: Db, keys: KeySource): Promise<Map<RefKey, PremergeFollowupRow[]>> {
  const out = new Map<RefKey, PremergeFollowupRow[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.premerge_followups as f").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "f.repo").onRef("kk.number", "=", "f.number"))
    .select(kx.cols("premerge_followups", "f")).orderBy("f.at").orderBy("f.head_oid"));
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), { ...r, number: Number(r.number), issue_number: r.issue_number === null ? null : Number(r.issue_number) });
  return out;
}

/** Writes the `filing` row of a head unless the head has a row already; true when this call wrote it. */
export async function claimPremergeFollowup(db: Db, r: { repo: string; number: number; head: string; at: string }): Promise<boolean> {
  const q = queryDb(db);
  const got = await q.all(q.k.insertInto("main.premerge_followups")
    .values({ repo: r.repo, number: r.number, head_oid: r.head, issue_number: null, url: null, state: "filing", at: r.at, note: null })
    .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doNothing())
    .returning(["head_oid"]));
  return got.length > 0;
}

/** Settles a head's row: filed with the issue it opened or commented on, or failed with GitHub's reason. */
export async function settlePremergeFollowup(db: Db, r: { repo: string; number: number; head: string; at: string; state: "filed" | "failed"; issue?: { number: number; url: string } | null; note?: string | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.premerge_followups")
    .set({ state: r.state, at: r.at, issue_number: r.issue?.number ?? null, url: r.issue?.url ?? null, note: r.note ?? null })
    .where("repo", "=", r.repo).where("number", "=", r.number).where("head_oid", "=", r.head));
}

/** Removes a head's `filing` row after a write that sent nothing, so a later run tries the head again. */
export async function dropPremergeFollowup(db: Db, r: { repo: string; number: number; head: string }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.premerge_followups").where("repo", "=", r.repo).where("number", "=", r.number).where("head_oid", "=", r.head).where("state", "=", "filing"));
}

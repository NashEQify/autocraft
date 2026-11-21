// Which autorepins (src/repin/index.ts) have something to do now. Read from the database alone and without the modules the
// work needs, so the runner can ask on every tick.
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** An attempt that did not finish is tried again after this long. */
export const RETRY_MS = 60_000;
/** A lockfile task that has not ended this long after it was queued (no build worker took it, say) ends the autorepin. */
export const LOCK_MAX_MS = 3 * 3600_000;
/** With `via <branch>`: how often a merge not yet on that branch is looked for again, and how long after the merge it may take to get there. */
export const BRANCH_POLL_MS = 15 * 60_000;
export const BRANCH_MAX_MS = 7 * 24 * 3600_000;

export type RepinRow = {
  repo: string; number: number; ref_repo: string; ref_number: number; ref_branch: string | null; login: string; github_id: number; requested_at: string;
  state: "waiting" | "locking" | "pushed" | "failed" | "cancelled";
  sha: string | null; head: string | null; task_id: number | null; tries: number; to_head: string | null; result: string | null; notice: string | null;
};

// waiting: the dependency's pull request is no longer open (merged or closed), or this one is; locking: the lockfile task
// has ended, or has run out of time; ended: the comment that tells the outcome is still to post.
function due(eb: kx.AnyEb, now: Date): AliasableExpression<SqlBool> {
  const s = kx.schemaEb(eb);
  const retryBefore = new Date(now.getTime() - RETRY_MS).toISOString();
  const lockBefore = new Date(now.getTime() - LOCK_MAX_MS).toISOString();
  return eb.or([
    eb.and([
      eb("a.state", "=", "waiting"),
      eb.or([eb("a.tried_at", "is", null), eb("a.tried_at", "<=", retryBefore)]),
      eb.or([
        eb.exists(s.selectFrom("main.items as i").select(eb.lit(1).as("one")).where("i.repo", "=", eb.ref("a.ref_repo")).where("i.number", "=", eb.ref("a.ref_number")).where("i.state", "!=", "OPEN")),
        eb.not(eb.exists(s.selectFrom("main.items as i").select(eb.lit(1).as("one")).where("i.repo", "=", eb.ref("a.repo")).where("i.number", "=", eb.ref("a.number")).where("i.kind", "=", "pr").where("i.state", "=", "OPEN"))),
      ]),
    ]),
    eb.and([
      eb("a.state", "=", "locking"),
      eb.not(eb.exists(s.selectFrom("main.build_tasks as t").select(eb.lit(1).as("one")).where("t.id", "=", eb.ref("a.task_id")).where("t.state", "in", ["queued", "claimed", "running"]).where("t.queued_at", ">", lockBefore))),
    ]),
    eb.and([eb("a.state", "in", ["pushed", "failed", "cancelled"]), eb("a.notice", "is", null)]),
  ]);
}

/** The autorepins with a step to take, oldest first. */
export async function repinsDue(db: Db, now: Date = new Date()): Promise<RepinRow[]> {
  return await db.all(db.k.selectFrom("main.autorepins as a").select(kx.cols("main.autorepins", "a")).$narrowType<{ state: RepinRow["state"] }>()
    .where((eb) => due(eb, now)).orderBy("a.requested_at").orderBy("a.repo").orderBy("a.number"));
}

export async function anyRepinDue(db: Db, now: Date = new Date()): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("main.autorepins as a").select((eb) => eb.lit(1).as("one")).where((eb) => due(eb, now)).limit(1));
}

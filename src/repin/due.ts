// Which autorepins (src/repin/index.ts) have something to do now. Read from the database alone and without the modules the
// work needs, so the runner can ask on every tick.
import type { Db } from "../db/index.ts";

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
const DUE = `(a.state = 'waiting' AND (a.tried_at IS NULL OR a.tried_at <= ?1) AND (
    EXISTS (SELECT 1 FROM main.items i WHERE i.repo = a.ref_repo AND i.number = a.ref_number AND i.state != 'OPEN')
    OR NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = a.repo AND i.number = a.number AND i.kind = 'pr' AND i.state = 'OPEN')))
  OR (a.state = 'locking' AND NOT EXISTS (SELECT 1 FROM main.build_tasks t WHERE t.id = a.task_id AND t.state IN ('queued', 'claimed', 'running') AND t.queued_at > ?2))
  OR (a.state IN ('pushed', 'failed', 'cancelled') AND a.notice IS NULL)`;

const before = (now: Date): [string, string] => [new Date(now.getTime() - RETRY_MS).toISOString(), new Date(now.getTime() - LOCK_MAX_MS).toISOString()];

/** The autorepins with a step to take, oldest first. */
export async function repinsDue(db: Db, now: Date = new Date()): Promise<RepinRow[]> {
  return await db.prepare(`SELECT a.* FROM main.autorepins a WHERE ${DUE} ORDER BY a.requested_at, a.repo, a.number`).all(...before(now)) as RepinRow[];
}

export async function anyRepinDue(db: Db, now: Date = new Date()): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 FROM main.autorepins a WHERE ${DUE} LIMIT 1`).get(...before(now));
}

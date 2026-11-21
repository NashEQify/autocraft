// What the planner and the fix-up step read of operator fix-ups and pre-approved merges. No writes here.
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { settlesAfter, settlesCheckedAtSql, settlesLoginSql } from "../settlers.ts";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import type { Db } from "../db/index.ts";

/** Fix-up states that count as a try; a row left in `pushing` by a crash counts too. */
const TRY_STATES = ["pushing", "pushed", "failed", "refused", "rejected"];
/** Fix-up states that end the work of an operator fix-up (`linting` is a stored patch waiting for its lint task; `superseded` is one the plan dropped). */
const ENDED_STATES = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];
/** A request counts only while the person who made it still settles on the repo (an operator, or a maintainer under src/settlers.ts): its push is made as them. */
const BY_SETTLES = settlesLoginSql("o.by", "o.repo");
const ENDED_SQL = `EXISTS (SELECT 1 FROM fixups f WHERE f.operator_fix = o.id AND f.source = 'operator' AND f.state IN (${ENDED_STATES.map(() => "?").join(",")}))`;

/** Tries the operator's fix-ups used on the PR; the fix-up limit of the PR applies to them as to the review's. */
export async function operatorTries(db: Db, repo: string, number: number): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM fixups WHERE repo = ? AND number = ? AND source = 'operator' AND state IN (${TRY_STATES.map(() => "?").join(",")})`)
    .get(repo, number, ...TRY_STATES) as { n: number }).n;
}
export const operatorTriesLeft = async (db: Db, repo: string, number: number): Promise<boolean> => await operatorTries(db, repo, number) < FIXUP_MAX_ATTEMPTS;

export type OperatorFix = { id: number; head: string; instructions: string; by: string; preapprovalId: number | null };

/** The operator fix-up of the PR still to work at `head`: queued and without a final fixups row of its own (matched by the request's id). */
export async function queuedOperatorFix(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<OperatorFix | null> {
  const r = await db.prepare(`SELECT id, from_head, instructions, by, preapproval_id FROM operator_fixups o WHERE repo = ? AND number = ? AND from_head = ? AND state = 'queued'
    AND ${BY_SETTLES} AND NOT ${ENDED_SQL}
    ORDER BY id DESC LIMIT 1`).get(settlesAfter(nowMs), repo, number, head, ...ENDED_STATES) as { id: number; from_head: string; instructions: string; by: string; preapproval_id: number | null } | undefined;
  return r ? { id: r.id, head: r.from_head, instructions: r.instructions, by: r.by, preapprovalId: r.preapproval_id } : null;
}

export type OperatorWork = {
  fixHeads: Set<string>; hold: boolean; /** The pushed head of a pre-approved merge waiting for its pre-merge review (state `ci`). */ premergeHeads: Set<string>; /** A pre-approved merge is live (fixup, review, ci or queued). */ preapproved: boolean;
  /** When the first of `fixHeads`' requests stops counting with the clock alone: its maintainer's cached write permission ages out (ms). */
  settleUntil?: number;
};

/** Per PR ("repo#n") at `nowMs`: the heads with an operator fix-up still to work, whether a pre-approved merge is before its merge answer or live at all, and the heads due a pre-merge review. Small tables, read once per pass. */
export async function operatorWork(db: Db, repo?: string, nowMs: number = Date.now()): Promise<Map<string, OperatorWork>> {
  const out = new Map<string, OperatorWork>();
  const get = (r: string, n: number): OperatorWork => {
    const k = `${r}#${n}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { fixHeads: new Set(), hold: false, premergeHeads: new Set(), preapproved: false }));
    return w;
  };
  const q = async (sql: string) => await db.prepare(`${sql}${repo ? " AND repo = ?" : ""}`).all(...(repo ? [repo] : []));
  for (const o of await db.prepare(`SELECT repo, number, from_head, ${settlesCheckedAtSql("o.by", "o.repo")} AS checked_at FROM operator_fixups o WHERE state = 'queued' AND ${BY_SETTLES} AND NOT ${ENDED_SQL}${repo ? " AND repo = ?" : ""}`)
    .all(settlesAfter(nowMs), ...ENDED_STATES, ...(repo ? [repo] : [])) as { repo: string; number: number; from_head: string; checked_at: string | null }[]) {
    const w = get(o.repo, o.number);
    w.fixHeads.add(o.from_head);
    if (o.checked_at) { const until = Date.parse(o.checked_at) + PERM_READ_TTL; if (!(w.settleUntil! <= until)) w.settleUntil = until; }
  }
  for (const p of await q("SELECT repo, number, state, head FROM preapprovals WHERE state IN ('fixup', 'review', 'ci', 'queued')") as { repo: string; number: number; state: string; head: string | null }[]) {
    const w = get(p.repo, p.number);
    w.preapproved = true;
    if (p.state === "queued") continue;
    w.hold = true;
    if (p.state === "ci" && p.head) w.premergeHeads.add(p.head);
  }
  return out;
}

export type OpenRequest = { id: number; repo: string; number: number; head: string; preapprovalId: number | null; started: boolean };

/** Every operator fix-up request still queued (no final fixups row of its own); `started` when a fixups row of it exists (a stored patch or a push under way). */
export async function openOperatorFixups(db: Db, nowMs: number = Date.now()): Promise<OpenRequest[]> {
  const rows = await db.prepare(`SELECT id, repo, number, from_head, preapproval_id, EXISTS (SELECT 1 FROM fixups f WHERE f.operator_fix = o.id) AS started FROM operator_fixups o WHERE state = 'queued' AND ${BY_SETTLES} AND NOT ${ENDED_SQL} AND repo IN (SELECT name FROM main.tracked_repos)`)
    .all(settlesAfter(nowMs), ...ENDED_STATES) as { id: number; repo: string; number: number; from_head: string; preapproval_id: number | null; started: number }[];
  return rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, head: r.from_head, preapprovalId: r.preapproval_id, started: !!r.started }));
}

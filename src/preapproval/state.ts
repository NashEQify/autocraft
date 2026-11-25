// What the planner and the fix-up step read of operator fix-ups and pre-approved merges, over the workflow and changes modules. No writes here.
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import { loadFixupRequests, loadLegPass } from "../data/workflow/index.ts";
import { loadOperatorFixResults, loadPatchFacts, operatorTriesIn } from "../data/changes/index.ts";
import { loadPermissions, permKey, PERM_READ_TTL } from "../data/access/index.ts";
import type { Db } from "../db/index.ts";

/** Tries the operator's fix-ups used on the PR; the fix-up limit of the PR applies to them as to the review's. */
export async function operatorTries(db: Db, repo: string, number: number): Promise<number> {
  return operatorTriesIn((await loadPatchFacts(db, [{ repo, number }])).get(`${repo}#${number}`)?.fixups ?? []);
}
export const operatorTriesLeft = async (db: Db, repo: string, number: number): Promise<boolean> => await operatorTries(db, repo, number) < FIXUP_MAX_ATTEMPTS;

export type OperatorFix = { id: number; head: string; instructions: string; by: string; preapprovalId: number | null };

/**
 * The operator fix-up of the PR still to work at `head`: queued, without a final fixups row of its own, and made by someone who
 * may still act on the repo (its push is made as them).
 */
export async function queuedOperatorFix(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<OperatorFix | null> {
  const r = (await loadFixupRequests(db, { refs: [{ repo, number }], nowMs })).filter((o) => o.from_head === head).at(-1);
  return r ? { id: r.id, head: r.from_head, instructions: r.instructions, by: r.by, preapprovalId: r.preapproval_id } : null;
}

export type OperatorWork = {
  fixHeads: Set<string>; hold: boolean; /** The pushed head of a pre-approved merge waiting for its pre-merge review (state `ci`). */ premergeHeads: Set<string>; /** A pre-approved merge is live (fixup, review, ci or queued). */ preapproved: boolean;
  /** When the first of `fixHeads`' requests stops counting with the clock alone: its maker's cached write permission ages out (ms). */
  settleUntil?: number;
};

/** Per PR ("repo#n") at `nowMs`: the heads with an operator fix-up still to work, whether a pre-approved merge is before its merge answer or live at all, and the heads due a pre-merge review. */
export async function operatorWork(db: Db, repo?: string, nowMs: number = Date.now()): Promise<Map<string, OperatorWork>> {
  const out = new Map<string, OperatorWork>();
  const get = (r: string, n: number): OperatorWork => {
    const k = `${r}#${n}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { fixHeads: new Set(), hold: false, premergeHeads: new Set(), preapproved: false }));
    return w;
  };
  const [requests, pass] = await db.together(() => Promise.all([loadFixupRequests(db, { nowMs }), loadLegPass(db, repo ? { repos: [repo] } : {})]));
  const mine = requests.filter((o) => !repo || o.repo === repo);
  const perms = await loadPermissions(db, mine.map((o) => ({ login: o.by, repo: o.repo })));
  for (const o of mine) {
    const w = get(o.repo, o.number);
    w.fixHeads.add(o.from_head);
    const checked = perms.get(permKey(o.by, o.repo))?.checkedAt;
    if (checked) { const until = Date.parse(checked) + PERM_READ_TTL; if (!(w.settleUntil! <= until)) w.settleUntil = until; }
  }
  for (const p of pass.rows) {
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
  const rows = await loadFixupRequests(db, { nowMs });
  const results = await loadOperatorFixResults(db, rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, head: r.from_head, preapprovalId: r.preapproval_id, started: results.has(r.id) }));
}

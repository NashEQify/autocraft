// What the rows say about a head of a pull request, one rule per question: the planner, the workflow pass, the merge legs and the merge
// itself ask here. Pure.
import type { PushEdge } from "../data/changes/types.ts";

/** A push of ours that moved a PR's head: the head it was made on and its commit. */
export type OwnPush = { from: string; to: string };

/** What a push of ours was. */
export type PushWhat = "fix-up" | "CI fix" | "base merge" | "implementation session's revision" | "autorepin";
/**
 * A recorded push. `lines`: the changed lines that count towards a large fix; null when they were not recorded. `landed`: git reported the push
 * done, so the branch had its commit; one a crash came before landed as well when a head shows its commit. `small`: it changed
 * nothing of the PR that a model wrote (a base merge that left the PR's own diff the same, an autorepin), so it owes no review.
 */
export type RecordedPush = OwnPush & { what: PushWhat; at: string; lines: number | null; landed: boolean; small: boolean };

/** A row of `push_outcomes` that names the head it was made on. */
export type OutcomePush = OwnPush & { action: string; at: string };
/** A row of `own_pushes`: a push recorded right before it was made. */
export type MadePush = OwnPush & { action: string; at: string; lines: number | null; landed: boolean };
/** The commit of an autorepin (src/repin) and the head it was made on. */
export type RepinPush = OwnPush & { at: string };

const WHAT: Record<PushEdge["kind"], PushWhat> = { fixup: "fix-up", cifix: "CI fix", conflict: "base merge" };
const ACTION: Record<string, PushWhat> = { "fixup-push": "fix-up", "cifix-push": "CI fix", "conflict-push": "base merge", "implement-push": "implementation session's revision", "autorepin-push": "autorepin" };

/**
 * Every push AutoCraft made to one PR: the fix-ups of any source, CI fixes, base merges, revisions of its implementations and autorepins.
 * `made` has each one, recorded before the push; the patch rows say what a merge did to the PR's diff. Pushes older than `made` are in their
 * patch rows, the push outcomes and the autorepins' rows alone. A commit that never landed is no PR's head, so its row leads nowhere.
 */
export function ownPushes(made: readonly MadePush[], edges: readonly PushEdge[], outcomes: readonly OutcomePush[], repins: readonly RepinPush[]): RecordedPush[] {
  const out = new Map<string, RecordedPush>();
  const key = (p: OwnPush): string => `${p.from} ${p.to}`;
  for (const e of edges) {
    const was = out.get(key(e));
    const small = e.kind === "conflict" && e.state === "merged" && e.ownDiff === "same";
    if (!was || small) out.set(key(e), { from: e.from, to: e.to, what: WHAT[e.kind], at: e.at, lines: null, landed: false, small });
  }
  for (const o of outcomes) {
    const was = out.get(key(o));
    if (was) { was.landed = true; if (o.at > was.at) was.at = o.at; } else out.set(key(o), { from: o.from, to: o.to, what: ACTION[o.action] ?? "fix-up", at: o.at, lines: null, landed: true, small: false });
  }
  for (const r of repins) if (!out.has(key(r))) out.set(key(r), { from: r.from, to: r.to, what: "autorepin", at: r.at, lines: null, landed: false, small: true });
  for (const m of made) {
    const was = out.get(key(m));
    // A patch row is as old as the patch, this one as the push.
    if (was) { was.lines = m.lines; was.landed ||= m.landed; if (m.at > was.at) was.at = m.at; } else out.set(key(m), { from: m.from, to: m.to, what: ACTION[m.action] ?? "fix-up", at: m.at, lines: m.lines, landed: m.landed, small: m.action === "autorepin-push" });
  }
  return [...out.values()];
}

/**
 * Whether a push is ours: `head` is `base`, or is reached from it through our own pushes alone, step by step. A head whose parent is not
 * recorded, or whose chain passes through a commit we did not push, is not: someone else's commits are under it.
 */
export function chainsOwn(pushes: readonly OwnPush[], base: string, head: string): boolean {
  const reached = new Set([head]);
  for (const h of reached) {
    if (h === base) return true;
    for (const p of pushes) if (p.to === h) reached.add(p.from);
  }
  return false;
}

/** Our pushes that lead to `head`, made after `since` (when a person last chose to go on with the PR), newest first. */
export function pushesSince(pushes: readonly RecordedPush[], head: string, since: string): RecordedPush[] {
  const out: RecordedPush[] = [], reached = new Set([head]);
  for (const h of reached) for (const p of pushes) if (p.to === h && p.from !== h && p.at > since) { out.push(p); reached.add(p.from); }
  return out;
}

/** The head the person chose to go on with: `head` without our pushes since. */
export const approvedHead = (pushes: readonly RecordedPush[], head: string, since: string): string => pushesSince(pushes, head, since).at(-1)?.from ?? head;

/** A push of ours since the person chose to go on changed more than a checked merge does: the head needs a model's review, also of a PR that merges without one. */
export const reviewOwed = (pushes: readonly RecordedPush[], head: string, since: string): boolean => pushesSince(pushes, head, since).some((p) => !p.small);

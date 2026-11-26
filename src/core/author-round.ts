// The review round of the author's new commits on a PR approved for merge (src/workflow/advance.ts runs it): whether a PR waits for it, and
// the head the approver accepted, for the review step and the review gate to act on.
import { authorRound, type OwnPush } from "./evidence.ts";
import type { Db } from "../db/index.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import { loadPrWorkflows, type WorkflowFact } from "../data/workflow/index.ts";

/** A running workflow of the PR itself, approved for merge, whose author pushed past the head it accepted: its review is due at once. */
export const roundWaits = (w: (Pick<WorkflowFact, "approved" | "baseHead" | "own" | "state">) | null | undefined, pushes: readonly OwnPush[], head: string): boolean =>
  !!w && w.own && w.state === "running" && authorRound(w, pushes, head) !== null;

/** The head the approver accepted when someone else's commits lead from it to the PR's `head_oid` (the PR's own live workflow, approved); null otherwise. */
export async function roundHeadOf(db: Db, c: { repo: string; number: number; head_oid: string }): Promise<string | null> {
  const ref = `${c.repo}#${c.number}`;
  const [workflows, pushes] = await db.together(() => Promise.all([loadPrWorkflows(db, [{ repo: c.repo, number: c.number }]), loadOwnPushes(db, [{ repo: c.repo, number: c.number }])]));
  const wf = workflows.get(ref);
  if (wf?.kind !== "pr" || wf.number !== c.number) return null;
  return authorRound({ approved: wf.approvedBy !== null, baseHead: wf.baseHead }, pushes.get(ref) ?? [], c.head_oid);
}

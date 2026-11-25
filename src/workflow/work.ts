// The implementation attempt and the pull request an issue's workflow works on. Pure: the advance pass, the command core and the
// planner give it what they loaded, so they agree on what an earlier workflow left behind.
import type { IssueAttempt } from "../data/implement/types.ts";
import { ENDED_STATES } from "../implement/types.ts";
import type { ItemWorkflow } from "./types.ts";

/** The PR of the issue's current attempt, or of one that ended in the workflow: the one `workOf` may name. */
export function candidatePr(a: IssueAttempt | null | undefined, w: Pick<ItemWorkflow, "startedAt">): number | null {
  if (!a) return null;
  const { state, prNumber, updatedAt } = a.attempt;
  if (prNumber !== null && (!ENDED_STATES.has(state) || updatedAt >= w.startedAt)) return prNumber;
  // The latest attempt of this workflow that opened a PR.
  return a.prAttempts.find((p) => p.createdAt >= w.startedAt)?.prNumber ?? null;
}

/** The PR was merged or closed before the workflow started. */
export const overBefore = (pr: { state: string; closed_at: string | null } | null | undefined, startedAt: string): boolean =>
  !!pr && pr.state !== "OPEN" && pr.closed_at !== null && pr.closed_at < startedAt;

/**
 * What an implement workflow works on: the issue's current attempt, and its PR (`pr`: the item of `candidatePr`). An attempt that ended before
 * the workflow started is none of it, nor one whose PR was merged or closed before that (its end is recorded a moment later).
 */
export function workOf(
  a: IssueAttempt | null | undefined, w: Pick<ItemWorkflow, "startedAt">, pr: { state: string; closed_at: string | null } | null | undefined,
): { attempt: IssueAttempt | null; pr: number | null } {
  if (!a || overBefore(pr, w.startedAt)) return { attempt: null, pr: null };
  return { attempt: ENDED_STATES.has(a.attempt.state) ? null : a, pr: candidatePr(a, w) };
}

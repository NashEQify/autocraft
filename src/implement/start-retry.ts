// AutoCraft's own retries of an implementation whose workspace did not start before its plan call: a failure on our side
// (the environment set-up, a pod that did not come up) needs no person's judgement. The attempt stays in `planning` with a
// `start-failed` round, and the plan bucket runs again after a failure backoff (the Implement stage's registry wait
// "Implementation start retry"). The failure after IMPLEMENT_START_RETRIES retries makes the attempt stuck, which asks a
// maintainer. Failures after a model call keep their own handling.
import { implementStartDelayMs, IMPLEMENT_START_RETRIES } from "../core/backoff.ts";
import type { ImplementationState, RoundKind } from "../data/implement/types.ts";

export { IMPLEMENT_START_RETRIES };

type R = { kind: RoundKind; at: string };

/** When the start failures in a row failed: the `start-failed` rounds after the newest question, answer or guidance round. */
export function startFailureTimes(rounds: readonly R[]): string[] {
  let from = 0;
  rounds.forEach((r, i) => { if (r.kind === "question" || r.kind === "answer" || r.kind === "guidance") from = i + 1; });
  return rounds.slice(from).filter((r) => r.kind === "start-failed").map((r) => r.at);
}

/**
 * A stuck attempt AutoCraft takes up again itself: stuck because its workspace did not start (cause `workspace-lost`), before
 * any plan call (no stored plan call), not by a cancel, unanswered, and with no `start-failed` round: it got stuck on its first
 * failed start, so it gets the retries an attempt that fails to start now gets.
 */
export function stuckOnStart(o: { state: ImplementationState; planCallId: number | null; reason: string | null; cause: string | null; answered: boolean; rounds: readonly R[] }): boolean {
  return o.state === "stuck" && o.cause === "workspace-lost" && o.planCallId === null && !o.answered
    && !/cancelled while the workspace started/.test(o.reason ?? "") && !o.rounds.some((r) => r.kind === "start-failed");
}

/**
 * The retry due for the attempt: in `planning` after start failures, when the newest one's backoff ends; for a stuck attempt
 * AutoCraft takes up again (stuckOnStart), at once, counted as one failure. Null when no retry is due.
 */
export function startRetryOf(o: Parameters<typeof stuckOnStart>[0]): { failures: number; dueAt: number } | null {
  if (stuckOnStart(o)) return { failures: 1, dueAt: 0 };
  if (o.state !== "planning") return null;
  const times = startFailureTimes(o.rounds);
  if (!times.length || times.length > IMPLEMENT_START_RETRIES) return null;
  return { failures: times.length, dueAt: Date.parse(times.at(-1)!) + implementStartDelayMs(times.length) };
}

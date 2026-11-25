// The question a started PR comes back with when its plan waits for a person. Pure.
import { MAINTAINER_ANSWER_WAIT, unapprovedStop } from "../core/decide.ts";
import type { Plan, PrFacts } from "../core/plan.ts";
import { afterSteps, type Conflict, type ReviewView } from "./recommend.ts";
import type { Blocker, PlanPart, Recommendation } from "./types.ts";

/** `blocker` and `params` are what an approved item stops at; one not approved comes back with `rec` alone. */
export type Question = { blocker: Blocker; params: Record<string, unknown>; rec: Recommendation };

/** Whether the plan stops for a maintainer's answer: its steps are done, or a review verdict needs a person. */
const waitsForAnswer = (p: Plan): boolean => p.wait === MAINTAINER_ANSWER_WAIT || p.state === "opus-hold" || p.state === "opus-close";

/** The question of the PR whose facts are `f` and whose plan is `p`; null when nothing is to be asked. `parts`: the workflow's plan; `conflict`: the conflict with the base branch. */
export function questionFor(f: PrFacts, p: Plan, o: { approved: boolean; review: ReviewView | null; parts: readonly PlanPart[]; conflict: Conflict | null }): Question | null {
  if (o.approved || !waitsForAnswer(p)) return null;
  return { blocker: "other", params: {}, rec: afterSteps(o.review, o.parts, unapprovedStop(f), o.conflict) };
}

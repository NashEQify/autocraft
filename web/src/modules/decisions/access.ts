import type { Decision, User } from "../../api/types";
import { canAct, canRun } from "../../registry/permissions";

export const canActOn = (user: User, ds: Decision[]): boolean =>
  ds.every((d) => d.canSettle) && canAct(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

/** Snooze and prepare again: the user runs every repo the decision covers. */
export const canRunDecision = (user: User, d: Decision): boolean =>
  (d.items.length ? d.items.map((i) => i.repo) : [d.repo]).every((r) => canRun(user, r));

/** Undo and retry: an operator takes back any answer, a maintainer only their own. */
export const canTakeBack = (user: User, d: Decision): boolean => canActOn(user, [d]) && (user.role === "operator" || d.answeredBy?.toLowerCase() === user.login.toLowerCase());

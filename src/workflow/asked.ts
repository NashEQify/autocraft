// Who a workflow's question goes to.
import { RULE_STARTER, type ItemWorkflow } from "./types.ts";

/** The people the workflow asks: who started it and who approved the merge, without the automatic merge rule. */
export const askedLogins = (wf: Pick<ItemWorkflow, "startedBy" | "approvedBy">): string[] =>
  [...new Set([wf.startedBy, wf.approvedBy].filter((l): l is string => !!l && l !== RULE_STARTER))];

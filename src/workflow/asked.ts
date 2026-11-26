// Who an item's open question goes to: the people who started the workflow and approved it for merge. Only they see it as theirs
// (Home, the rail badge, Discord alerts, the agent's own items); anyone with write access may still answer it. A row the automatic
// merge rule started asks nobody until a person takes it over.
import { RULE_STARTER, type ItemWorkflow } from "./types.ts";

/** The logins a workflow's question goes to, in the order started, approved; empty for a rule row nobody took over. */
export function askedLogins(wf: Pick<ItemWorkflow, "startedBy" | "approvedBy">): string[] {
  const out: string[] = [];
  for (const login of [wf.startedBy, wf.approvedBy]) {
    if (login && login !== RULE_STARTER && !out.some((o) => o.toLowerCase() === login.toLowerCase())) out.push(login);
  }
  return out;
}

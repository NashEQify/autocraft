// Who an item's open question goes to: the people who started the workflow and approved it for merge. Only they see it as theirs
// (Home, the rail badge, Discord alerts, the agent's own items); anyone with write access may still answer it. A row the automatic
// merge rule started asks nobody until a person takes it over: it has no open question, and its state line says why it stopped and
// what AutoCraft would do (status.ts stateLine). A person's yes still runs that and takes the item over.
import { openRecommendation, RULE_STARTER, type ItemWorkflow, type Recommendation } from "./types.ts";

/** The logins a workflow's question goes to, in the order started, approved; empty for a rule row nobody took over. */
export function askedLogins(wf: Pick<ItemWorkflow, "startedBy" | "approvedBy">): string[] {
  const out: string[] = [];
  for (const login of [wf.startedBy, wf.approvedBy]) {
    if (login && login !== RULE_STARTER && !out.some((o) => o.toLowerCase() === login.toLowerCase())) out.push(login);
  }
  return out;
}

/** A row the automatic merge rule started and no person approved: it asks nobody. */
export const asksNobody = (wf: Pick<ItemWorkflow, "startedBy" | "approvedBy">): boolean => askedLogins(wf).length === 0;

/** The question the workflow asks and who it goes to; null when no recommendation is open or the row asks nobody. */
export function openQuestion(wf: Pick<ItemWorkflow, "state" | "rec" | "startedBy" | "approvedBy"> | null): { rec: Recommendation; to: string[] } | null {
  const rec = openRecommendation(wf);
  const to = wf ? askedLogins(wf) : [];
  return rec && to.length ? { rec, to } : null;
}

/** `login` is one of the people the workflow's open question goes to. */
export const isAsked = (wf: Pick<ItemWorkflow, "state" | "rec" | "startedBy" | "approvedBy">, login: string): boolean =>
  openQuestion(wf)?.to.some((l) => l.toLowerCase() === login.toLowerCase()) ?? false;

// A PR the automatic merge rule takes up by itself (core/rules.ts autoEligible) and that then stops for a person's judgement gets a
// workflow row of its own, started by the rule (RULE_STARTER): it comes back with one recommendation, built like any other item's from
// its review and its wait (ask.ts questionFor), with why the rule stopped (`stop`). It asks nobody (asked.ts): no alert and no open
// question anywhere, only its state line "Stopped: <reason>. AutoCraft would: <recommendation>". A person with write access answers it
// the same way as any question, and takes it over, so the merge is then theirs. The row enters at Review and is not approved: until a
// person answers, nothing runs as anyone.
//
// Only waits that need judgement make a row: the end of the steps (`answer`: an unsure or hold review, a pre-merge defect, a statement
// conflict, sensitive files), a failed verification and a screenshot regression. Waits that clear by themselves (CI, GitHub's
// mergeable state, a check that has not read the diff yet) make none. Nothing is started while the pipeline is off.
//
// One live rule row per PR. A row nobody answered ends as `superseded` when the author pushes (advance.ts), and the rule takes the PR
// back: a later stop may start a new row. Once a person answered or ended a row, or started any workflow on the PR, the rule starts none.
import type { WaitCode } from "../core/codes.ts";
import { conflictPath, decidePr, onAutoPath } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import type { Plan, PlanState, PrFacts } from "../core/plan.ts";
import { EXTRAS_PENDING_REASON, UNCHECKED_REASON } from "../core/sensitive.ts";
import { readConfig, SETTINGS } from "../data/control/index.ts";
import { listPlans } from "../data/planner/index.ts";
import { loadReviewRows, type ReviewRow } from "../data/review/index.ts";
import { loadStartedRefs, recordEvents, saveWorkflows, startWorkflows } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { questionFor } from "./ask.ts";
import { planOf, ruleStopped } from "./recommend.ts";
import { RULE_STARTER, WEIGHT_NORMAL, type PlanPart, type Recommendation, type WorkflowState } from "./types.ts";

/** The waits of a stop that only a person's judgement settles. */
export const JUDGEMENT_WAITS: readonly WaitCode[] = ["answer", "verification-failed", "screenshots"];
/** Reasons of the rule that go by themselves once a check has read the diff and the files beside it. */
const PASSING: ReadonlySet<string> = new Set([EXTRAS_PENDING_REASON, UNCHECKED_REASON]);
/** The plan states those waits come from; a stored plan keeps its state while other work on the item is due, unlike its wait. */
const JUDGEMENT_STATES: readonly PlanState[] = ["needs-decision", "opus-hold", "opus-close", "verify-failed", "verify-error"];
/** Every workflow state but a rule row's that the rule took back: a PR with a row in one of these gets no rule row. */
const KEEPS_OFF: WorkflowState[] = ["running", "waiting", "blocked", "recommending", "done", "stopped", "closed", "backlog"];

export type AutoStop = { repo: string; number: number; head: string; code: WaitCode; plan: PlanPart[]; rec: Recommendation };

/** The judgement stop of a PR on the auto path, with the recommendation it comes back with; null for any other PR or wait. Pure. */
export function autoStop(f: PrFacts, p: Plan, reviews: readonly ReviewRow[]): AutoStop | null {
  if (f.ghState !== "OPEN" || f.draft || !f.head || !onAutoPath(f)) return null;
  const code = p.waitCode ?? null;
  if (code === null || p.waitKind !== "person" || !JUDGEMENT_WAITS.includes(code) || p.reasons.some((r) => PASSING.has(r))) return null;
  const review = reviews.find((r) => r.head === f.head) ?? null;
  const plan = review ? planOf(review.fixes, []) : [];
  const view = review ? { verdict: review.verdict, sure: review.sure, rec: review.workflow?.recommendation ?? null } : null;
  const conflict = f.mergeable === "CONFLICTING" ? { path: conflictPath(f) } : null;
  const q = questionFor(f, p, { approved: false, review: view, parts: plan, conflict });
  return q ? { repo: f.repo, number: f.number, head: f.head, code, plan, rec: ruleStopped(q.rec, p.reasons) } : null;
}

/**
 * The judgement stops of open auto-path PRs that the rule may start a row for: candidates from the stored plans (on the auto path as the
 * planner stored them, in a judgement state), decided on fresh facts. Reads only.
 */
export async function findAutoStops(db: Db, o: { repos?: string[] } = {}): Promise<AutoStop[]> {
  const plans = await listPlans(db, { kind: "pr", open: true, auto: true, states: [...JUDGEMENT_STATES], ...(o.repos ? { repos: o.repos } : {}) });
  if (!plans.length) return [];
  const started = await loadStartedRefs(db, { states: KEEPS_OFF, refs: plans });
  const refs = plans.filter((p) => !started.has(`${p.repo}#${p.number}`)).map((p) => ({ repo: p.repo, number: p.number }));
  if (!refs.length) return [];
  const facts = await loadPrFacts(db, { refs: refs.map((r) => `${r.repo}#${r.number}`) });
  const reviews = await loadReviewRows(db, refs);
  return facts.flatMap((f) => autoStop(f, decidePr(f), reviews.get(`${f.repo}#${f.number}`) ?? []) ?? []);
}

/**
 * Starts the workflow of each judgement stop, in the state that waits for its answer, and returns how many it started: the rows, their
 * question and their events in one write, a few statements whatever their number. A PR someone started meanwhile keeps their workflow.
 */
export async function startAutoStops(db: Db, at: string = new Date().toISOString()): Promise<number> {
  if (!(await readConfig(db, [SETTINGS.pipelineEnabled.name])).pipelineEnabled) return 0;
  const stops = await findAutoStops(db);
  if (!stops.length) return 0;
  return await db.write(async () => {
    const ids = await startWorkflows(db, stops.map((s) => ({
      repo: s.repo, number: s.number, kind: "pr" as const, entry: "review" as const, weight: WEIGHT_NORMAL, startedBy: RULE_STARTER, startedVia: "cli" as const, baseHead: s.head, plan: s.plan, at,
    })));
    const started = stops.flatMap((s) => { const id = ids.get(`${s.repo}#${s.number}`); return id === undefined ? [] : [{ s, id }]; });
    await saveWorkflows(db, started.map(({ s, id }) => ({ id, at, patch: { state: "recommending", acceptedHead: s.head, rec: s.rec, recAt: at, recHead: s.head } })));
    await recordEvents(db, started.map(({ s, id }) => ({ workflowId: id, repo: s.repo, number: s.number, login: RULE_STARTER, via: "cli" as const, kind: "set" as const, line: s.rec.text, at })));
    return started.length;
  });
}

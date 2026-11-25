// The Plan cache: `item_plans` holds what the planner decided for each PR and item at the end of its last pass, for the
// dashboard to read. The planner is its only writer. This file turns a PlanSet into rows; data/planner savePlans writes the rows
// that changed and deletes the rows of items that left the Plans, in one transaction.
import { holdWait } from "../outside.ts";
import { cifixBucket, fixupOf, mergeEntry, queueEntry } from "./decide.ts";
import { pushAllowed } from "./gates.ts";
import { nextStep } from "./decide-item.ts";
import { isWork } from "./assignment.ts";
import type { Action, ItemFacts, MergePath, Plan, PrFacts, WaitKind } from "./plan.ts";
import { isQueueState } from "./plan.ts";
import { statusOf, type ItemStatus } from "./item-status.ts";
import { loadPlanSet, type PlanSet, type PlanSetOptions } from "./plan-set.ts";
import { diffPlans, loadStoredPlans, savePlans, type PlanDiff, type StoredPlans } from "../data/planner/index.ts";
import type { Db } from "../db/index.ts";

/** The merge-queue fields of a PR whose Plan is in a queue state: what the Queue page and the flow counts show besides the Plan's own state, reasons and note. */
export type QueueView = {
  author: string | null; tier: string; head: string; size: string; label: string | null; /** Null for a merge-entry PR, which has no review. */ verdict: "take" | "take-fix" | null; reason: string; fixes: number;
  ci: string; mergeable: string; path: MergePath; eligible: boolean; refusedReason: string | null;
  reviewedAt: string; blockedLive: boolean; noCi: boolean; runsWaiting: number; runsBlocked: "off" | "failed" | "unsupported" | null;
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  conflictNote?: string; mainFix?: true;
};

export type FixupBucket = "fix" | "unapproved" | "asked" | "hold";
export type CifixBucket = "cifix-queued" | "cifix-rerun" | "cifix-failed";

/** What the dashboard reads besides the Plan columns, per row; keys are left out when empty. */
export type PlanView = {
  /** The Work page's next-step text; absent for a PR outside the item facts (merged, or in an untracked repo). */
  next?: string;
  /** In the pipeline's scope and not our own integration PR. */
  scope?: true;
  /** Settled label of the current classification run. */
  label?: string;
  /** GitHub state of a PR. */
  gh?: "OPEN" | "MERGED" | "CLOSED";
  fixup?: FixupBucket;
  cifix?: CifixBucket;
  queue?: QueueView;
  /** Who the wait is on, as the planner typed it; absent when nothing is awaited (read by the liveness check). */
  waitKind?: WaitKind;
  /** Phase, wait and next step; `since` is when phase or wait last changed. */
  status: ItemStatus;
};

export type PlanRow = {
  repo: string; number: number; kind: "pr" | "issue"; head: string | null; state: string; item_state: string | null;
  actions: string; wait: string | null; reasons: string; note: string | null; view: string;
};

const CIFIX_BUCKETS: Record<string, CifixBucket> = { work: "cifix-queued", formatting: "cifix-queued", collect: "cifix-queued", linting: "cifix-queued", rerun: "cifix-rerun", "rerun-wait": "cifix-rerun", "comment-wait": "cifix-queued", failed: "cifix-failed", capped: "cifix-failed" };

/** The fix-up bucket the flow counts show for a PR: a take-fix review's own, or a pre-merge round's. */
function fixupBucketOf(f: PrFacts, plan: Plan): FixupBucket | undefined {
  const x = fixupOf(f);
  if (x) return x.bucket === "fix" || x.bucket === "unapproved" || x.bucket === "asked" ? x.bucket : "hold";
  if (f.premerge && plan.actions.some((a) => a.kind === "fixup" && a.params?.source === "premerge")) return f.pushable && pushAllowed(f, "fixup") ? "fix" : f.pushable ? "unapproved" : "hold";
  return undefined;
}

function queueViewOf(f: PrFacts, plan: Plan): QueueView {
  // A merge-entry PR is queued at its own head without a review; it joined the queue when its workflow started.
  const r = mergeEntry(f) ? null : f.review!;
  const head = r?.head ?? f.head ?? "";
  const merged = plan.state === "merged";
  const x = queueEntry(f, merged, !merged);
  return {
    author: f.author, tier: f.tier, head, size: f.size, label: f.label, verdict: r ? r.verdict as "take" | "take-fix" : null, reason: r?.reason ?? "", fixes: r?.fixes ?? 0, ci: f.ci, mergeable: f.mergeable,
    path: plan.path, eligible: plan.eligible, refusedReason: null,
    reviewedAt: r?.at ?? f.workflow?.startedAt ?? "", blockedLive: plan.state === "changes-requested" && !!f.changesRequested?.live, noCi: x.noCi,
    runsWaiting: f.runs?.waiting ?? 0, runsBlocked: f.runs?.blocked ?? null, verify: f.verification,
    ...(plan.conflictNote !== null ? { conflictNote: plan.conflictNote } : {}), ...(f.mainFix ? { mainFix: true as const } : {}),
  };
}

function viewOf(pr: { facts: PrFacts; plan: Plan } | null, item: { facts: ItemFacts; plan: Parameters<typeof nextStep>[0] } | null, wait: string | null, waitKind: WaitKind | null, plannedAt: string): PlanView {
  const v = { status: { phase: "Triage", waiting: null, next: null, since: plannedAt } } as PlanView;
  if (item) {
    v.next = nextStep(item.plan, item.facts, pr?.facts ?? null);
    if (item.facts.inScope && !item.facts.integration) v.scope = true;
    if (item.facts.classification.label) v.label = item.facts.classification.label;
  } else if (pr && pr.facts.inScope && !pr.facts.integration) v.scope = true;
  if (pr) {
    v.gh = pr.facts.ghState;
    const fx = fixupBucketOf(pr.facts, pr.plan);
    if (fx) v.fixup = fx;
    const cf = cifixBucket(pr.facts);
    if (cf && CIFIX_BUCKETS[cf]) v.cifix = CIFIX_BUCKETS[cf];
    if (isQueueState(pr.plan.state) && pr.facts.review) v.queue = queueViewOf(pr.facts, pr.plan);
  }
  if (wait !== null && waitKind) v.waitKind = waitKind;
  v.status = {
    ...statusOf({ gh: pr?.facts.ghState ?? null, state: pr?.plan.state ?? null, itemState: item?.plan.state ?? null, wait, waitKind, next: v.next ?? null, reviewBlocked: pr?.facts.reviewHold?.kind === "blocked", inPipeline: item?.facts.inScope ?? pr?.facts.inScope, ...((item?.facts.outsideHold ?? pr?.facts.outsideHold) ? { outside: (item?.facts.outsideHold ?? pr?.facts.outsideHold)! } : {}) }),
    since: plannedAt,
  };
  return v;
}

/** The actions as a row stores them: what is due, without who permits it. */
const storedActions = (actions: readonly Action[]): string => JSON.stringify(actions.map(({ permission: _, ...a }) => a));

/** One row per PR or item of the set. A PR with item facts gets both its plans in one row. */
export function planRows(plans: PlanSet, plannedAt: string = new Date().toISOString()): PlanRow[] {
  const prs = new Map(plans.prs.map((p) => [`${p.facts.repo}#${p.facts.number}`, p]));
  const rows: PlanRow[] = [];
  for (const { facts: f, plan: item } of plans.items) {
    const ref = `${f.repo}#${f.number}`;
    const pr = prs.get(ref) ?? null;
    prs.delete(ref);
    const actions = [...item.actions, ...(pr?.plan.actions ?? [])];
    const work = actions.some(isWork);
    const hold = f.outsideHold ?? pr?.facts.outsideHold;
    const wait = hold ? holdWait(hold) : work ? null : pr?.plan.wait ?? item.wait;
    const waitKind = hold ? "system" as const : work ? null : pr?.plan.wait != null ? pr.plan.waitKind : item.waitKind;
    rows.push({
      repo: f.repo, number: f.number, kind: f.kind, head: pr?.facts.head ?? null, state: pr ? pr.plan.state : item.state, item_state: item.state,
      actions: storedActions(actions), wait, reasons: JSON.stringify(pr?.plan.reasons ?? []), note: pr?.plan.note ?? null,
      view: JSON.stringify(viewOf(pr, { facts: f, plan: item }, wait, waitKind, plannedAt)),
    });
  }
  // PRs outside the item facts: merged ones with a take review, and PRs of repos that are not tracked.
  for (const { facts: f, plan } of prs.values()) {
    rows.push({ repo: f.repo, number: f.number, kind: "pr", head: f.head, state: plan.state, item_state: null, actions: storedActions(plan.actions), wait: plan.wait, reasons: JSON.stringify(plan.reasons), note: plan.note, view: JSON.stringify(viewOf({ facts: f, plan }, null, plan.wait, plan.waitKind, plannedAt)) });
  }
  return rows;
}

export type PlanHistoryRow = { id: number; head: string | null; oldState: string | null; newState: string; oldWait: string | null; wait: string | null; reasons: string[]; at: string };

export type PlanCacheDiff = { rows: PlanRow[]; at: string; stored: StoredPlans; changed: boolean; diff: PlanDiff };

/** What the Plans change in the stored rows; nothing is written. `stored`: the stored rows, when the caller read them. */
export async function planCacheDiff(db: Db, plans: PlanSet, stored?: StoredPlans, at: string = new Date().toISOString()): Promise<PlanCacheDiff> {
  const rows = planRows(plans, at);
  const have = stored ?? await loadStoredPlans(db);
  const diff = diffPlans(rows, have);
  return { rows, at, stored: have, changed: diff.changed.length > 0 || diff.gone.length > 0, diff };
}

/** Writes what planCacheDiff() found; inside the caller's transaction when one is open. */
export const writePlanDiff = async (db: Db, d: PlanCacheDiff): Promise<{ written: number; deleted: number }> => await savePlans(db, d.rows, d.at, d.stored, d.diff);

/** Writes the rows that differ from the stored ones and deletes the stored rows with no Plan. Returns the numbers written and deleted. */
export async function writePlanCache(db: Db, plans: PlanSet, plannedAt: string = new Date().toISOString()): Promise<{ written: number; deleted: number }> {
  return await savePlans(db, planRows(plans, plannedAt), plannedAt);
}

/** Plans decided and cached at once. */
export async function refreshPlanCache(db: Db, opts: PlanSetOptions = {}): Promise<{ written: number; deleted: number }> {
  return await writePlanCache(db, await loadPlanSet(db, opts));
}

export { prunePlanHistory } from "../data/planner/index.ts";

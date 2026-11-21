// The Plans of every PR and item at one moment: facts loaded once, decided once. The planner builds one per pass; lanes and
// executors read it through planned() / plannedItems() instead of loading facts again.
import { latestRun } from "../classify/settled.ts";
import { decideItem } from "./decide-item.ts";
import { decidePr } from "./decide.ts";
import { loadPass, loadPrFacts } from "./facts.ts";
import { loadItemFacts } from "./issue-facts.ts";
import type { ItemFacts, ItemPlan, PassFacts, Plan, PrFacts } from "./plan.ts";
import type { Db } from "../db/index.ts";

export type PrPlan = { facts: PrFacts; plan: Plan };
export type ItemPlanned = { facts: ItemFacts; plan: ItemPlan };

export type PlanSet = {
  /** The classification run both loads used. */
  run: string | null;
  /** Time of the decisions, ms. */
  now: number;
  /** The instance-wide inputs every PR was decided with. */
  pass: PassFacts;
  prs: PrPlan[];
  items: ItemPlanned[];
};

export type PlanSetOptions = {
  run?: string | null; now?: number; model?: string;
  /** Only these items, as "repo#number": their facts equal their entries in a full load at the same moment. */
  refs?: Iterable<string>;
};

/** Loads PR and item facts once and decides them. */
export async function loadPlanSet(db: Db, opts: PlanSetOptions = {}): Promise<PlanSet> {
  const now = opts.now ?? Date.now();
  const run = opts.run !== undefined ? opts.run : await latestRun(db);
  const load = { now, run, ...(opts.refs ? { refs: [...opts.refs] } : {}) };
  const pass = loadPass(now);
  const prs = (await loadPrFacts(db, load)).map((facts): PrPlan => ({ facts, plan: decidePr(facts, pass) }));
  const items = (await loadItemFacts(db, { ...load, ...(opts.model ? { model: opts.model } : {}) })).map((facts): ItemPlanned => ({ facts, plan: decideItem(facts) }));
  return { run, now, pass, prs, items };
}

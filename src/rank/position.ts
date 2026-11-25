// Queue position: the place of an open item among the items whose next step is the same queued stage.
// Items are those in the pipeline's scope, ordered by the work rank with started items first (their workflow weight); the Merge
// stage follows the Merge tab's order. Items whose next step is not a queued stage (a person's answer, a running job, held, done) have none.
// The place is current, not an estimate.
import type { QueueSlot } from "../../web/src/api/types.ts";
import { sortSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openItemKeys } from "../data/mirror/index.ts";
import { listPlans } from "../data/planner/index.ts";
import { loadRankScores } from "../data/triage/index.ts";
import { loadHolds, loadWorkScores } from "../data/workflow/index.ts";

/** Next step text → queued stage and the Queue tab that lists it. Steps not listed here are not queued. */
const QUEUED: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

const BATCHED = new Set(["batch-checking", "in-batch"]);

type Entry = { repo: string; number: number; score: number } & Pick<QueueSlot, "stage" | "tab">;
export type Stages = Map<string, Entry[]>;

/** Work score of an item with started ones raised (the workflow weight), one lookup per repo. */
export function scoreLookup(db: Db): (repo: string, number: number) => Promise<number | undefined> {
  // The read in flight is kept, so lookups made together read each repo once.
  const by = new Map<string, Promise<Map<string, number>>>();
  return async (repo, number) => {
    let m = by.get(repo);
    if (!m) by.set(repo, (m = repoScores(db, repo)));
    return (await m).get(`${repo}#${number}`);
  };
}

async function repoScores(db: Db, repo: string): Promise<Map<string, number>> {
  const [ranks, work] = await db.together(() => Promise.all([loadRankScores(db, { repos: [repo] }), loadWorkScores(db, openItemKeys({ repos: [repo] }))]));
  return new Map([...ranks, ...work]);
}

/** The Merge tab's order, the same as every other stage's: started items first, then the work rank, then repo and number. Batched PRs are listed under their batch, not here. */
export async function mergeOrder<T extends { repo: string; number: number; state?: string }>(db: Db, entries: T[]): Promise<T[]> {
  const score = scoreLookup(db);
  const s = async (e: T): Promise<number> => await score(e.repo, e.number) ?? 0;
  return await sortSeq(entries.filter((e) => !BATCHED.has(e.state ?? "")), async (a, b) => await s(b) - await s(a) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

/** Orders items by stage: best first by score. */
export function orderStages(items: { repo: string; number: number; score: number; next: string }[]): Stages {
  const by: Stages = new Map();
  for (const i of items) {
    const q = QUEUED[i.next];
    if (!q) continue;
    const list = by.get(q.stage) ?? [];
    list.push({ repo: i.repo, number: i.number, score: i.score, ...q });
    by.set(q.stage, list);
  }
  for (const list of by.values()) list.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.number - b.number);
  return by;
}

/** Orders the pipeline's open ranked items by stage, from the Plan cache: the next-step text of each item in scope, and the batch states of the PRs. */
export async function computeStages(db: Db): Promise<Stages> {
  const plans = await listPlans(db, { open: true, scope: true });
  const refs = plans.map((p) => ({ repo: p.repo, number: p.number }));
  const [ranks, work, held] = await db.together(() => Promise.all([loadRankScores(db, refs), loadWorkScores(db, refs), loadHolds(db, { refs })]));
  const out: { repo: string; number: number; score: number; next: string }[] = [];
  for (const p of plans) {
    const step = p.view.next ?? "";
    const k = `${p.repo}#${p.number}`;
    // An item without a rank is not queued. A held PR has no place in the merge order, and batched PRs are listed under their batch on the Merge tab.
    if (!ranks.has(k) || !QUEUED[step] || (step === "Merge queue" && (held.has(k) || BATCHED.has(p.state)))) continue;
    out.push({ repo: p.repo, number: p.number, score: work.get(k) ?? ranks.get(k)!, next: step });
  }
  return orderStages(out);
}

/** Slots of `repo#number` for the items in `visible` repos; places count only visible items. Pure over the ordered stages. */
export function slotsOf(byStage: Stages, visible: Iterable<string>): Map<string, QueueSlot> {
  const seen = new Set(visible);
  const out = new Map<string, QueueSlot>();
  for (const list of byStage.values()) {
    let place = 0;
    for (const e of list) {
      if (!seen.has(e.repo)) continue;
      const key = `${e.repo}#${e.number}`;
      out.set(key, { stage: e.stage, tab: e.tab, place: ++place });
    }
  }
  return out;
}

/** One pass for all items: call it once per request, not per item. */
export const queueSlots = async (db: Db, visible: Iterable<string>): Promise<Map<string, QueueSlot>> => slotsOf(await computeStages(db), visible);

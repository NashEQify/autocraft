// Queue position: the place of an open item among the items whose next step is the same queued stage.
// Items are those in the pipeline's scope (repo switch on or fast-tracked, the pilot, not our own integration PRs),
// ordered by the work rank with fast-tracked items first (src/fasttrack.ts); the Merge stage follows the Merge tab's order.
// Items whose next step is not a queued stage (a person's answer, a running job, held, done) have none.
// The place is current, not an estimate.
import type { QueueSlot } from "../../web/src/api/types.ts";
import { workScores } from "../fasttrack.ts";
import { targetKeys } from "../act/order.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { sortSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { inList, jsonBool, jsonText, like } from "../db/kx.ts";

/** Next step text → queued stage and the Queue tab that lists it. Steps not listed here are not queued. */
const QUEUED: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

const BATCHED = new Set(["batch-checking", "in-batch"]);

/** The Act stage is queued by the order the Act step works in (priority level, then the time of the answer), not by the work rank. */
const ACT_SLOT: Pick<QueueSlot, "stage" | "tab"> = { stage: "Act", tab: "act" };

type Entry = { repo: string; number: number; score: number } & Pick<QueueSlot, "stage" | "tab">;
export type Stages = Map<string, Entry[]>;

/** Work score of an item with fast-tracked ones raised, one lookup per repo. */
export function scoreLookup(db: Db): (repo: string, number: number) => Promise<number | undefined> {
  // The read in flight is kept, so lookups made together read each repo once.
  const by = new Map<string, Promise<Map<number, number>>>();
  return async (repo, number) => {
    let m = by.get(repo);
    if (!m) by.set(repo, (m = workScores(db, repo)));
    return (await m).get(number);
  };
}

/** The Merge tab's order, the same as every other stage's: fast-tracked first, then the work rank, then repo and number. Batched PRs are listed under their batch, not here. */
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
  const held = new Set((await db.all(db.k.selectFrom("main.merge_holds").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`));
  const rows = await db.all(db.k.selectFrom("main.item_plans as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number").on("i.state", "=", "OPEN"))
    .innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "p.repo").onRef("r.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.state", jsonText(db, "p.view", "$.next").as("next")])
    .where((eb) => eb(jsonBool(db, "p.view", "$.scope"), "=", 1)));
  const score = scoreLookup(db);
  const out: { repo: string; number: number; score: number; next: string }[] = [];
  for (const r of rows) {
    const step = r.next ?? "";
    const k = `${r.repo}#${r.number}`;
    // A held PR has no place in the merge order, and batched PRs are listed under their batch on the Merge tab.
    if (!QUEUED[step] || (step === "Merge queue" && (held.has(k) || BATCHED.has(r.state)))) continue;
    out.push({ repo: r.repo, number: r.number, score: await score(r.repo, r.number) ?? 0, next: step });
  }
  const stages = orderStages(out);
  const act = await actEntries(db);
  if (act.length) stages.set("Act", act);
  return stages;
}

const EPOCH_CAP = 1e10;

/** Items with an answered close the Act step has not carried out yet, in the step's order. Repos not approved for commenting and disputed answers have no place. */
async function actEntries(db: Db): Promise<Entry[]> {
  const rows = await db.all(db.k.selectFrom("main.item_plans").select(["repo", "number", "actions"])
    .where((eb) => like(db, "actions", eb.val('%"kind":"act"%'))));
  const targets: { decisionId: string; repo: string; number: number }[] = [];
  const approved = new Map<string, boolean>();
  for (const r of rows) {
    let acts: { kind?: string; params?: { ask?: boolean; group?: boolean; decisionId?: string } }[];
    try { acts = JSON.parse(r.actions ?? "[]"); } catch { continue; }
    const t = acts.find((a) => a.kind === "act" && !a.params?.ask && !a.params?.group && a.params?.decisionId);
    if (!t) continue;
    if (!approved.has(r.repo)) approved.set(r.repo, await commentApprovalOf(db, r.repo) !== null);
    if (approved.get(r.repo)) targets.push({ decisionId: t.params!.decisionId!, repo: r.repo, number: r.number });
  }
  if (!targets.length) return [];
  const keys = await targetKeys(db, targets);
  const disputed = new Set((await db.all(db.k.selectFrom("main.decisions").select("id").where("exec_state", "=", "disputed").where(inList(db, "id", targets.map((t) => t.decisionId))))).map((x) => x.id));
  return targets.filter((t) => !disputed.has(t.decisionId)).map((t) => {
    const k = keys.get(t.decisionId);
    const sec = k?.at ? Date.parse(k.at) / 1000 : 0;
    return { repo: t.repo, number: t.number, score: (k?.band ?? 2) * EPOCH_CAP + (EPOCH_CAP - (Number.isFinite(sec) ? sec : 0)), ...ACT_SLOT };
  }).sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.number - b.number);
}

const cache = new WeakMap<Db, { sig: string; stages: Stages }>();

// Recomputed when the Plan cache, the work rank, fast track or merge holds change (the `plans` and `steps` topics).
async function stages(db: Db): Promise<Stages> {
  const sig = JSON.stringify(await db.get(db.k.selectNoFrom((eb) => [
    eb.selectFrom("change_seq").select("seq").where("topic", "=", "steps").as("s"),
    eb.selectFrom("change_seq").select("seq").where("topic", "=", "plans").as("p"),
  ])) ?? null);
  const hit = cache.get(db);
  if (hit && hit.sig === sig) return hit.stages;
  const fresh = await computeStages(db);
  cache.set(db, { sig, stages: fresh });
  return fresh;
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
      // An item with a place in a pipeline stage keeps it; the Act place is for items with no other.
      if (e.stage === "Act" && out.has(key)) continue;
      out.set(key, { stage: e.stage, tab: e.tab, place: ++place });
    }
  }
  return out;
}

/** One pass for all items: call it once per request, not per item. */
export const queueSlots = async (db: Db, visible: Iterable<string>): Promise<Map<string, QueueSlot>> => slotsOf(await stages(db), visible);

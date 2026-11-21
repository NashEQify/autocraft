// The classify steps: Jev on every item that needs a verdict, then Haiku on the
// items Jev is under 90 % sure of. When Jev is unavailable (src/agents/jev.ts),
// Haiku classifies the due items itself and its verdict settles them. Uses the
// classifiers in src/classify/run.ts.
//
// "Changed" means the classifier's input changed: input_hash is a hash of the
// classification scheme (labels and rules) and the item as the classifier sees
// it (title, body, size). A new scheme or an edited title or body makes the item
// due again; a new comment or label does not. Verdicts from before input_hash
// existed count as changed when the item was updated after the verdict.
import { refOf, type Item } from "../classify/parse.ts";
import { takersFirst } from "../agents/call.ts";
import { freeSlots } from "../agents/accounts.ts";
import { jevAvailable } from "../agents/jev.ts";
import { haikuBatches, runHaiku, runJev } from "../classify/run.ts";
import { fillClassHashes } from "../itemhash.ts";
import { itemOf, plannedItems } from "../core/select-items.ts";
import type { StepContext } from "./steps.ts";
import { latestRun } from "../classify/settled.ts";
import { assignAreas, type AssignResult } from "../areas/assign.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export { inputHash } from "../itemhash.ts";

// Jev's top probability from which its label stands without a second opinion.
export const SURE = 0.9;
// Area questions per classify job, not counted against its limit: bulk assignment is the areas-rescan step.
const AREAS_PER_CLASSIFY_JOB = 100;
const JEV_CHUNK = 40, HAIKU_PER_CALL = 25;


/**
 * runJev and runHaiku write one token_usage row per agent name (`jev-<ref>`,
 * `haiku-NN`) with INSERT OR REPLACE. Rows from earlier passes with those
 * names are renamed first so their cost stays on record.
 */
async function keepUsage(db: Db, run: string, agents: string[]): Promise<void> {
  const q = db.prepare("UPDATE main.token_usage SET agent = agent || '@' || COALESCE(started_at, '') WHERE run_id = ? AND agent = ?");
  for (const a of agents) await q.run(run, a);
}

/** Items sent to a model so far in this job, saved as the job's handled count. */
const sentCounter = (ctx: StepContext) => {
  let sent = 0;
  return (n: number) => ctx.handled((sent += n));
};

async function jevPass(ctx: StepContext, run: string, todo: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<Set<string>> {
  const { db } = ctx;
  const setHash = db.prepare("UPDATE main.classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'jev' AND run_id = ? AND at >= ?");
  const done = new Set<string>();
  for (let i = 0; i < todo.length && !await ctx.cancelled() && await jevAvailable(db); i += JEV_CHUNK) {
    const chunk = todo.slice(i, i + JEV_CHUNK);
    await keepUsage(db, run, chunk.map((x) => `jev-${refOf(x)}`));
    const t0 = new Date().toISOString();
    sent(chunk.length);
    await runJev(db, run, chunk);
    for (const x of chunk) if ((await setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0)).changes) done.add(refOf(x));
    await ctx.progress(`Jev: ${Math.min(i + JEV_CHUNK, todo.length)} of ${todo.length} items`);
  }
  return done;
}

/** The items the Plans send to Haiku for a second opinion in `run`: Jev is unsure of the type or of a flag and Haiku has no verdict as new as Jev's. */
async function haikuItems(db: Db, run: string, limit: number): Promise<Item[]> {
  return await mapSeq((await takersFirst(db, await plannedItems(db, "classify", { run, bucket: "haiku" }), (p) => [p.facts.repo], (p) => [p.facts])).slice(0, limit), async (p) => await itemOf(db, p.facts.repo, p.facts.number));
}

async function haikuPass(ctx: StepContext, run: string, todo: Item[], sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const count = db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE classifier = 'haiku' AND run_id = ? AND at >= ?");
  const t0 = new Date().toISOString();
  // A chunk holds one batch for every call the accounts can take at once (at least 4), so the calls fill the free slots.
  for (let i = 0, size = 0; i < todo.length && !await ctx.cancelled(); i += size) {
    size = HAIKU_PER_CALL * Math.max(4, await freeSlots(db));
    const chunk = todo.slice(i, i + size);
    await keepUsage(db, run, Array.from({ length: (await haikuBatches(db, chunk, HAIKU_PER_CALL)).length }, (_, n) => `haiku-${String(n).padStart(2, "0")}`));
    // The first call of the pass runs alone and writes the prompt cache; the rest read it. Items no Task Runner may take are not sent.
    sent(await runHaiku(db, run, chunk, HAIKU_PER_CALL, undefined, { cold: i === 0 }));
    await ctx.progress(`Haiku: ${Math.min(i + size, todo.length)} of ${todo.length} items`);
  }
  return (await count.get(run, t0) as { n: number }).n;
}

/**
 * Haiku classifies the items alone. Its verdict carries the item's input hash, which keeps the item from being due for Jev
 * until it changes, and replaces a Jev verdict of the item's earlier text. Returns the number of items Haiku answered.
 */
async function haikuOnlyPass(ctx: StepContext, run: string, items: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const t0 = new Date().toISOString();
  await haikuPass(ctx, run, items, sent);
  const setHash = db.prepare("UPDATE main.classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'haiku' AND run_id = ? AND at >= ?");
  // A Jev row of the item's earlier text goes; one without a hash (older rows) is kept, it is current until the item changes.
  const dropStale = db.prepare("DELETE FROM main.classifications WHERE repo = ? AND number = ? AND classifier = 'jev' AND run_id = ? AND input_hash IS NOT NULL AND input_hash <> ?");
  let n = 0;
  for (const x of items) {
    if (!(await setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0)).changes) continue;
    await dropStale.run(x.repo, x.number, run, hashes.get(refOf(x))!);
    n++;
  }
  return n;
}

/**
 * Open items the Plans send to Jev in `run`, with each due item's input hash. "all" takes only items without a verdict.
 * The hashes are stored on the item row (src/itemhash.ts), so no body is read for items that are up to date.
 */
async function jevItems(db: Db, run: string, mode: "new" | "all"): Promise<{ open: number; due: Item[]; hashes: Map<string, string> }> {
  await fillClassHashes(db);
  const open = (await db.prepare("SELECT COUNT(*) AS n FROM items i JOIN tracked_repos t ON t.name = i.repo WHERE i.state = 'OPEN'").get() as { n: number }).n;
  const hash = db.prepare("SELECT class_hash AS h FROM items WHERE repo = ? AND number = ?");
  const due: Item[] = [], hashes = new Map<string, string>();
  for (const p of await plannedItems(db, "classify", { run, bucket: "jev" })) {
    if (mode === "all" && p.facts.classification.jev) continue;
    const x = await itemOf(db, p.facts.repo, p.facts.number);
    due.push(x);
    hashes.set(refOf(x), (await hash.get(x.repo, x.number) as { h: string }).h);
  }
  return { open, due, hashes };
}

async function pass(ctx: StepContext, run: string, mode: "new" | "all"): Promise<{ areas: AssignResult; jev: number; due: number; haiku: number; haikuDue: number; haikuAlone: number; aloneDue: number; left: number }> {
  const limit = Number(ctx.params.limit);
  ctx.usageRun(run);
  await ctx.progress("Finding items to classify");
  const { open, due, hashes } = await jevItems(ctx.db, run, mode);
  const todo = (await takersFirst(ctx.db, due, (x) => [x.repo], (x) => [x])).slice(0, limit);
  ctx.log(`run ${run}: ${open} open items, ${due.length} due for Jev, taking ${todo.length}`);
  const sent = sentCounter(ctx);
  const jevDone = await jevPass(ctx, run, todo, hashes, sent);
  // Items Jev did not answer because it is unavailable go to Haiku, which settles them.
  const alone = await ctx.cancelled() || await jevAvailable(ctx.db) ? [] : todo.filter((x) => !jevDone.has(refOf(x)));
  const haikuAlone = alone.length ? await haikuOnlyPass(ctx, run, alone, hashes, sent) : 0;
  if (alone.length) ctx.log(`Jev unavailable: Haiku classified ${haikuAlone} of ${alone.length} items`);
  const aloneRefs = new Set(alone.map(refOf));
  const unsure = await ctx.cancelled() ? [] : (await haikuItems(ctx.db, run, limit)).filter((x) => !aloneRefs.has(refOf(x)));
  ctx.log(`Haiku: ${unsure.length} items where Jev is unsure of the type (under ${SURE * 100} %) or of a flag`);
  const haiku = await haikuPass(ctx, run, unsure, sent);
  const jev = jevDone.size;
  // Items of repos with an area list that were not asked against its current version; Jev's answers share the job's limit with the type pass.
  const areas = await ctx.cancelled() ? { due: 0, jev: 0, haiku: 0, none: 0, left: 0 } : await assignAreas(ctx.db, { limit: Math.min(limit, AREAS_PER_CLASSIFY_JOB), usageRun: run, cancelled: ctx.cancelled, progress: ctx.progress, log: ctx.log });
  return { areas, jev, due: due.length, haiku, haikuDue: unsure.length, haikuAlone, aloneDue: alone.length, left: due.length - jev - haikuAlone };
}

const areaNote = (r: { areas: AssignResult }): string => (r.areas.due ? ` Areas: ${r.areas.jev} by Jev, ${r.areas.haiku} by Haiku of ${r.areas.due} items asked.` : "");

const aloneNote = (r: { haikuAlone: number; aloneDue: number }): string => (r.aloneDue ? `Jev unavailable: Haiku classified ${r.haikuAlone} items. ` : "");

export async function classifyNew(ctx: StepContext): Promise<string> {
  const run = await latestRun(ctx.db);
  if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
  const r = await pass(ctx, run, "new");
  if (!r.due && !r.haikuDue && !r.areas.due) return `Nothing to classify in run ${run}.`;
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} new or changed items${r.left ? ` (${r.left} left)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}`;
}

export async function classifyAll(ctx: StepContext): Promise<string> {
  const run = String(ctx.params.run);
  const r = await pass(ctx, run, "all");
  const complete = r.left === 0 && !await ctx.cancelled();
  if (complete) await ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(run);
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} items without a verdict${r.left ? ` (${r.left} left; start it again to continue)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}${complete ? " The run is now the current one." : ""}`;
}

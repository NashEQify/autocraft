// autocraft-server prioritize [--limit N]: priority level (P0-P4) of open items and their reach (src/priority/score.ts).
//
// Jev classifies the impact of each item whose text has no priority row at its
// current hash; Haiku decides where Jev is under 90 % sure, and for every item
// while Jev is unavailable (src/agents/jev.ts). The reach is
// recomputed from the mirror's reach signals on every pass, without a model.
import { takersFirst } from "../agents/call.ts";
import { runTiered } from "../agents/step.ts";
import { PRIORITY } from "../agents/steps.ts";
import { type Item, refOf } from "../classify/parse.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { reachOfOpenItems } from "./reach.ts";
import { reachScore, settleImpact, type Impact } from "./score.ts";
import { itemOf, plannedItems } from "../core/select-items.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { excluded } from "../db/kx.ts";

const JEV_CHUNK = 40;
const now = () => new Date().toISOString();

type Due = Item & { hash: string };

/** The items the Plans send to rating: no priority row, or one made at other text. */
async function dueItems(db: Db): Promise<Due[]> {
  return await mapSeq((await plannedItems(db, "prioritize")), async (p) => ({ ...await itemOf(db, p.facts.repo, p.facts.number), hash: p.facts.embedHash }));
}

type Verdict = { jev: { impact: Impact; p: number } | null; haiku: { impact: Impact; reason: string } | null };

async function save(db: Db, item: Due, v: Verdict): Promise<boolean> {
  const s = settleImpact(v.jev, v.haiku?.impact ?? null);
  if (!s) return false;
  const reason = s.model === "haiku" ? v.haiku!.reason : v.jev ? `${v.jev.impact} ${v.jev.p.toFixed(2)}` : "";
  await db.run(db.k.insertInto("item_priority")
    .values({ repo: item.repo, number: item.number, text_hash: item.hash, impact: s.impact, jev_impact: v.jev?.impact ?? null, jev_p: v.jev?.p ?? null,
      haiku_impact: v.haiku?.impact ?? null, score: 0, model: s.model, reason, at: now() })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["text_hash", "impact", "jev_impact", "jev_p", "haiku_impact", "model", "reason", "at"]))));
  return true;
}

/**
 * Recomputes the reach of every open item with a priority row from the current reach signals.
 * Returns the number of rows whose reach changed.
 */
export async function rescore(db: Db, nowMs: number = Date.now()): Promise<number> {
  const reach = await reachOfOpenItems(db, nowMs);
  const rows = await db.all(db.k.selectFrom("item_priority as p")
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.score"]).where("i.state", "=", "OPEN"));
  let changed = 0;
  await db.write(async () => {
    for (const r of rows) {
      const rc = reach.get(`${r.repo}#${r.number}`);
      if (!rc) continue;
      const score = reachScore(rc);
      if (score !== r.score) { await db.run(db.k.updateTable("item_priority").set({ score }).where("repo", "=", r.repo).where("number", "=", r.number)); changed++; }
    }
  });
  return changed;
}

export type PrioritizeOptions = { limit: number; onSent?: (n: number) => void; cancelled?: () => Promise<boolean>; log?: (line: string) => void };
export type PrioritizeResult = { due: number; sent: number; jev: number; haiku: number; saved: number; rescored: number; haikuAlone: number };

export async function runPrioritize(db: Db, opts: PrioritizeOptions): Promise<PrioritizeResult> {
  const log = opts.log ?? (() => {});
  await fillEmbedHashes(db);
  const all = await dueItems(db);
  const due = all.length;
  const todo = (await takersFirst(db, all, (x) => [x.repo], (x) => [x], "priority.haiku")).slice(0, opts.limit);
  log(`prioritize: ${due} items due, taking ${todo.length}`);
  const res: PrioritizeResult = { due, sent: 0, jev: 0, haiku: 0, saved: 0, rescored: 0, haikuAlone: 0 };
  for (let i = 0; i < todo.length && !await opts.cancelled?.(); i += JEV_CHUNK) {
    const all = todo.slice(i, i + JEV_CHUNK);
    const t = await runTiered(db, PRIORITY, all);
    // An item whose Haiku batch no Task Runner could take is left for a later pass, unsaved.
    const chunk = all.filter((x) => !t.skipped.has(refOf(x)));
    res.sent += chunk.length;
    opts.onSent?.(res.sent);
    const verdicts = new Map<string, Verdict>();
    for (const item of chunk) {
      const ref = refOf(item), v = t.jev.get(ref) ?? null;
      verdicts.set(ref, { jev: v, haiku: t.haiku.get(ref) ?? null });
      if (v) res.jev++;
      if (t.haiku.has(ref)) res.haiku++;
    }
    res.haikuAlone += t.alone.size;
    for (const item of chunk) if (await save(db, item, verdicts.get(refOf(item))!)) res.saved++;
    else log(`prioritize: no valid answer for ${refOf(item)}`);
  }
  res.rescored = await rescore(db);
  if (res.haikuAlone) log(`Jev unavailable: Haiku rated ${res.haikuAlone} items`);
  return res;
}

export const commands = {
  prioritize: {
    summary: "prioritize [--limit N]: Jev (Haiku where unsure) rates the level (P0-P4) of open items without a priority, then recomputes all reach",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--limit");
      const limit = i >= 0 ? Number(args[i + 1]) : 500;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit is a whole number of at least 1");
      const r = await runPrioritize(await openDb(), { limit, log: console.log });
      console.log(`${r.saved} of ${r.sent} rated (${r.jev} by Jev, ${r.haiku} by Haiku); ${r.rescored} reach values changed${r.haikuAlone ? `; Jev unavailable: Haiku rated ${r.haikuAlone} items` : ""}`);
    },
  },
};

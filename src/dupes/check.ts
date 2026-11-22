// The pair check: Jev for every pair, accepted at 0.9 either way; Haiku for the
// pairs Jev is not sure about, and for every pair while Jev is unavailable.
import { jevParallel } from "../agents/accounts.ts";
import { poolRoom, repoBatches } from "../agents/call.ts";
import { jevAvailable } from "../agents/jev.ts";
import { askClaude, pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { DUPES_HAIKU, DUPES_JEV } from "../agents/steps.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { pickCanonical } from "./canonical.ts";
import { pairRef, settlePair, type DupePair, type PairVerdict } from "./pair.ts";
import { pilotExprFor } from "../pilot.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

/** The two items of a pair, as its call names them. */
const pairRefs = (p: DupePair): { repo: string; number: number }[] => [{ repo: p.repo, number: p.a.number }, { repo: p.repo, number: p.b.number }];

const HAIKU = CLAUDE_PROMPTS["dupes.haiku"];

export type PairKey = { repo: string; a: number; b: number; a_hash: string; b_hash: string; similarity: number };

// Unchecked pairs whose items still have the hashed text and of which at least one is open.
const unchecked = (db: Db) => db.k.selectFrom("duplicate_pairs as p")
  .innerJoin("items as ia", (j) => j.onRef("ia.repo", "=", "p.repo").onRef("ia.number", "=", "p.a").onRef("ia.embed_hash", "=", "p.a_hash"))
  .innerJoin("items as ib", (j) => j.onRef("ib.repo", "=", "p.repo").onRef("ib.number", "=", "p.b").onRef("ib.embed_hash", "=", "p.b_hash"))
  .select(["p.repo", "p.a", "p.b", "p.a_hash", "p.b_hash", "p.similarity"])
  .where("p.verdict", "is", null)
  .where((eb) => eb.or([eb("ia.state", "=", "OPEN"), eb("ib.state", "=", "OPEN")]))
  .where("p.repo", "in", (eb) => eb.selectFrom("tracked_repos").select("name"))
  .where((eb) => eb.or([pilotExprFor(db, eb, "p.repo", "p.a"), pilotExprFor(db, eb, "p.repo", "p.b")]));

/** Unchecked pairs whose items still have the hashed text and of which at least one is open, most similar first. A negative limit means all. */
export async function uncheckedPairs(db: Db, limit: number): Promise<PairKey[]> {
  return await db.all(unchecked(db).orderBy("p.similarity", "desc").orderBy("p.repo").orderBy("p.a").orderBy("p.b").$if(limit >= 0, (q) => q.limit(limit)));
}

/** The number of unchecked pairs (uncheckedPairs) each item is in, keyed by `repo#number`. */
export async function uncheckedPairCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.all(db.k.with("u", () => unchecked(db))
    .selectFrom((eb) => eb.selectFrom("u").select(["repo", "a as number"]).unionAll(eb.selectFrom("u").select(["repo", "b as number"])).as("m"))
    .select((eb) => ["m.repo", "m.number", eb.fn.countAll<number>().as("n")]).groupBy(["m.repo", "m.number"]));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r.n]));
}

export async function pairInput(db: Db, k: PairKey): Promise<DupePair> {
  const item = async (n: number) => {
    const r = (await db.get(db.k.selectFrom("items").select(["number", "kind", "state", "title", "body"]).where("repo", "=", k.repo).where("number", "=", n)
      .$narrowType<{ kind: "pr" | "issue" }>()))!;
    return { number: r.number, kind: r.kind, state: r.state, title: r.title ?? "", body: r.body ?? "" };
  };
  return { ref: pairRef(k.repo, k.a, k.b), repo: k.repo, a: await item(k.a), b: await item(k.b) };
}

export type CheckDeps = {
  /** Jev's yes-probability that the pair is one bug or request; null when it gave no valid answer. */
  jev(pair: DupePair): Promise<number | null>;
  /** Haiku's reply text for a batch of pairs; null when there was none. */
  haiku(pairs: DupePair[]): Promise<string | null>;
  /** False while Jev is unavailable: Haiku then decides the pairs alone. Absent means available. */
  jevUsable?(): Promise<boolean>;
  now(): Date;
};

export function defaultCheckDeps(db: Db): CheckDeps {
  return {
    async jev(pair) {
      const r = await runModelStep(db, DUPES_JEV, pair);
      return r.ok ? r.value : null;
    },
    async haiku(pairs) {
      return (await askClaude("dupes.haiku", HAIKU.models[0]!, pairs, db))?.text ?? null;
    },
    jevUsable: async () => await jevAvailable(db),
    now: () => new Date(),
  };
}

export type CheckCounts = { checked: number; jev: number; haiku: number; haikuAlone: number; verdicts: Record<string, number>; unanswered: number };

async function store(db: Db, k: PairKey, jev: number | null, haiku: PairVerdict | null, verdict: PairVerdict, at: string): Promise<void> {
  const canonical = verdict === "duplicate" ? (await pickCanonical(db, k.repo, [k.a, k.b])).number : null;
  await db.run(db.k.updateTable("duplicate_pairs").set({ jev_p: jev, haiku, verdict, canonical, checked_at: at })
    .where("repo", "=", k.repo).where("a", "=", k.a).where("b", "=", k.b).where("a_hash", "=", k.a_hash).where("b_hash", "=", k.b_hash));
}

/**
 * Checks the pairs and stores each answered one. `onHandled` gets the running count of pairs sent to a model; pairs of a Haiku
 * batch the pool skipped (no Task Runner took it) are taken off again, so a job whose only work was skipped counts as idle.
 */
export async function checkPairs(db: Db, keys: PairKey[], deps: CheckDeps, onHandled?: (n: number) => void): Promise<CheckCounts> {
  const c: CheckCounts = { checked: 0, jev: 0, haiku: 0, haikuAlone: 0, verdicts: {}, unanswered: 0 };
  const jevP = new Map<string, number | null>();
  /** Pairs Jev could not be asked because it is unavailable. */
  const alone = new Set<string>();
  const pairs = new Map(await mapSeq(keys, async (k) => [pairRef(k.repo, k.a, k.b), { k, pair: await pairInput(db, k) }]));
  let handled = 0, skipped = 0;
  await pool([...pairs.entries()].map(([ref, e]) => async () => {
    const usable = await deps.jevUsable?.() ?? true;
    const p = usable ? await deps.jev(e.pair) : null;
    jevP.set(ref, p);
    if (p === null && !(await deps.jevUsable?.() ?? true)) alone.add(ref);
    else c.jev++;
    onHandled?.(++handled);
  }), await jevParallel(db));
  const at = deps.now().toISOString();
  const done = async (ref: string, haiku: PairVerdict | null, verdict: PairVerdict) => {
    await store(db, pairs.get(ref)!.k, jevP.get(ref) ?? null, haiku, verdict, at);
    c.checked++;
    c.verdicts[verdict] = (c.verdicts[verdict] ?? 0) + 1;
  };
  const second: string[] = [];
  for (const ref of pairs.keys()) {
    const v = alone.has(ref) ? null : settlePair(jevP.get(ref) ?? null, null);
    if (v) await done(ref, null, v);
    else second.push(ref);
  }
  const batches = await repoBatches(db, second, HAIKU.limits.perCall, (r) => pairs.get(r)!.pair.repo, (r) => pairRefs(pairs.get(r)!.pair));
  await pool(batches.map((batch) => async () => {
    // One entry per batch pair; a pair without a valid answer stays in `rest` and is asked again.
    const input = batch.map((r) => pairs.get(r)!.pair);
    const r = await runModelStep(db, DUPES_HAIKU, input, { ask: async (ps) => {
      const text = await deps.haiku(ps);
      return text === null ? null : { text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
    } });
    if (r.ok) for (const answers of r.values) {
      c.haiku += answers.length;
      for (const a of answers) {
        if (alone.has(a.ref)) c.haikuAlone++;
        await done(a.ref, a.verdict, settlePair(jevP.get(a.ref) ?? null, a.verdict, alone.has(a.ref)) ?? "unsure");
      }
    }
    const todo = r.ok ? (r.rest ?? []) : input;
    c.unanswered += todo.length;
  }), poolRoom(db, (i) => [...new Set(batches[i]!.map((r) => pairs.get(r)!.pair.repo))], (i) => batches[i]!.flatMap((r) => pairRefs(pairs.get(r)!.pair)), { promptId: HAIKU.id }), { first: true, skipped: (i) => {
    c.unanswered += batches[i]!.length;
    skipped += batches[i]!.length;
  } });
  if (skipped) onHandled?.(handled - skipped);
  return c;
}

// The pair check: Jev for every pair, accepted at 0.9 either way; Haiku for the
// pairs Jev is not sure about, and for every pair while Jev is unavailable.
import { loadLiveConfig } from "../data/control/index.ts";
import { poolRoom, repoBatches } from "../agents/call.ts";
import { jevAvailable } from "../agents/jev.ts";
import { askClaude, pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { DUPES_HAIKU, DUPES_JEV } from "../agents/steps.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { canonInfoAll, compareCanonical } from "./canonical.ts";
import { pairRef, settlePair, type DupePair, type PairVerdict } from "./pair.ts";
import { loadItems } from "../data/mirror/index.ts";
import { savePairVerdicts, type PairKey, type PairVerdictPut } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";

/** The two items of a pair, as its call names them. */
const pairRefs = (p: DupePair): { repo: string; number: number }[] => [{ repo: p.repo, number: p.a.number }, { repo: p.repo, number: p.b.number }];

const HAIKU = CLAUDE_PROMPTS["dupes.haiku"];

export type { PairKey };

/** The model inputs of the pairs, in the order given: the items of all pairs are read in one load. */
export async function pairInputs(db: Db, keys: readonly PairKey[]): Promise<DupePair[]> {
  const items = await loadItems(db, keys.flatMap((k) => [{ repo: k.repo, number: k.a }, { repo: k.repo, number: k.b }]), "text");
  const item = (repo: string, n: number) => {
    const r = items.get(`${repo}#${n}`);
    if (!r) throw new Error(`${repo}#${n} is not in the database`);
    return { number: r.number, kind: r.kind as "pr" | "issue", state: r.state, title: r.title ?? "", body: r.body ?? "" };
  };
  return keys.map((k) => ({ ref: pairRef(k.repo, k.a, k.b), repo: k.repo, a: item(k.repo, k.a), b: item(k.repo, k.b) }));
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

type Verdicted = { key: PairKey; jev: number | null; haiku: PairVerdict | null; verdict: PairVerdict };

/** Stores the verdicts in one write; the canonical item of each duplicate comes from one load of its items. */
async function store(db: Db, rows: Verdicted[], at: string): Promise<void> {
  if (!rows.length) return;
  const dups = rows.filter((r) => r.verdict === "duplicate");
  const info = dups.length ? await canonInfoAll(db, dups.flatMap((r) => [{ repo: r.key.repo, number: r.key.a }, { repo: r.key.repo, number: r.key.b }])) : new Map();
  const canonical = (r: Verdicted): number => {
    const both = [r.key.a, r.key.b].map((n) => {
      const i = info.get(`${r.key.repo}#${n}`);
      if (!i) throw new Error(`${r.key.repo}#${n} is not in the database`);
      return i;
    }).sort(compareCanonical);
    return both[0]!.number;
  };
  await savePairVerdicts(db, rows.map((r): PairVerdictPut => ({
    repo: r.key.repo, a: r.key.a, b: r.key.b, a_hash: r.key.a_hash, b_hash: r.key.b_hash, jev_p: r.jev, haiku: r.haiku, verdict: r.verdict,
    canonical: r.verdict === "duplicate" ? canonical(r) : null, checked_at: at,
  })));
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
  const inputs = await pairInputs(db, keys);
  const pairs = new Map(keys.map((k, i) => [pairRef(k.repo, k.a, k.b), { k, pair: inputs[i]! }]));
  let handled = 0, skipped = 0;
  await pool([...pairs.entries()].map(([ref, e]) => async () => {
    const usable = await deps.jevUsable?.() ?? true;
    const p = usable ? await deps.jev(e.pair) : null;
    jevP.set(ref, p);
    if (p === null && !(await deps.jevUsable?.() ?? true)) alone.add(ref);
    else c.jev++;
    onHandled?.(++handled);
  }), (await loadLiveConfig(db)).jevParallel);
  const at = deps.now().toISOString();
  const done = (out: Verdicted[], ref: string, haiku: PairVerdict | null, verdict: PairVerdict) => {
    out.push({ key: pairs.get(ref)!.k, jev: jevP.get(ref) ?? null, haiku, verdict });
    c.checked++;
    c.verdicts[verdict] = (c.verdicts[verdict] ?? 0) + 1;
  };
  const second: string[] = [];
  const first: Verdicted[] = [];
  for (const ref of pairs.keys()) {
    const v = alone.has(ref) ? null : settlePair(jevP.get(ref) ?? null, null);
    if (v) done(first, ref, null, v);
    else second.push(ref);
  }
  await store(db, first, at);
  const batches = await repoBatches(db, second, HAIKU.limits.perCall, (r) => pairs.get(r)!.pair.repo, (r) => pairRefs(pairs.get(r)!.pair));
  await pool(batches.map((batch) => async () => {
    // One entry per batch pair; a pair without a valid answer stays in `rest` and is asked again.
    const input = batch.map((r) => pairs.get(r)!.pair);
    const r = await runModelStep(db, DUPES_HAIKU, input, { ask: async (ps) => {
      const text = await deps.haiku(ps);
      return text === null ? null : { text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
    } });
    const out: Verdicted[] = [];
    if (r.ok) for (const answers of r.values) {
      c.haiku += answers.length;
      for (const a of answers) {
        if (alone.has(a.ref)) c.haikuAlone++;
        done(out, a.ref, a.verdict, settlePair(jevP.get(a.ref) ?? null, a.verdict, alone.has(a.ref)) ?? "unsure");
      }
    }
    await store(db, out, at);
    const todo = r.ok ? (r.rest ?? []) : input;
    c.unanswered += todo.length;
  }), poolRoom(db, (i) => [...new Set(batches[i]!.map((r) => pairs.get(r)!.pair.repo))], (i) => batches[i]!.flatMap((r) => pairRefs(pairs.get(r)!.pair)), { promptId: HAIKU.id }), { first: true, skipped: (i) => {
    c.unanswered += batches[i]!.length;
    skipped += batches[i]!.length;
  } });
  if (skipped) onHandled?.(handled - skipped);
  return c;
}

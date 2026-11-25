// The pair check: Jev for every pair, accepted at 0.9 either way; Haiku for the
// pairs Jev is not sure about, and for every pair while Jev is unavailable.
import { loadLiveConfig } from "../data/control/index.ts";
import { poolRoom, repoBatches } from "../agents/call.ts";
import { jevAvailable } from "../agents/jev.ts";
import { askClaude, pool } from "../classify/run.ts";
import { jevRequestHash, runModelStep } from "../agents/step.ts";
import { DUPES_HAIKU, DUPES_JEV } from "../agents/steps.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { canonInfoAll, compareCanonical } from "./canonical.ts";
import { pairRef, settlePair, type DupePair, type PairVerdict } from "./pair.ts";
import { loadUnsure, saveUnsure } from "../data/inference/index.ts";
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
  /** Jev's yes-probability that the pair is one bug or request; null when it gave no valid answer. `stop`: no further attempt starts once it is true. */
  jev(pair: DupePair, stop?: Stop): Promise<number | null>;
  /** Haiku's reply text for a batch of pairs; null when there was none. */
  haiku(pairs: DupePair[]): Promise<string | null>;
  /** False while Jev is unavailable: Haiku then decides the pairs alone. Absent means available. */
  jevUsable?(): Promise<boolean>;
  now(): Date;
};

type Stop = () => Promise<boolean>;

export function defaultCheckDeps(db: Db): CheckDeps {
  return {
    async jev(pair, stop) {
      const r = await runModelStep(db, DUPES_JEV, pair, { ...(stop && { cancelled: stop }) });
      return r.ok ? r.value : null;
    },
    async haiku(pairs) {
      return (await askClaude("dupes.haiku", HAIKU.models[0]!, pairs, db))?.text ?? null;
    },
    jevUsable: async () => await jevAvailable(db),
    now: () => new Date(),
  };
}

export type CheckOptions = {
  /**
   * The running count of pairs sent to a model. Pairs of a Haiku batch the pool skipped (no Task Runner took it) are taken off
   * again, so a job whose only work was skipped counts as idle.
   */
  onHandled?: (n: number) => void;
  /** Once true, no new call starts: pairs not asked keep no verdict, the answers that came are stored, and the unsure ones are kept. */
  stop?: Stop;
};
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

/** Jev's kept answers (jev_unsure) to the pairs' current requests, by ref, and the hash each pair's answer is valid for. */
async function keptAnswers(db: Db, pairs: readonly DupePair[]): Promise<{ answers: Map<string, number>; hashOf: (pair: DupePair) => string }> {
  const hashOf = (pair: DupePair) => jevRequestHash(DUPES_JEV, pair, undefined);
  const rows = await loadUnsure(db, DUPES_JEV.id, pairs.map((p) => p.ref));
  const answers = new Map<string, number>();
  for (const p of pairs) {
    const r = rows.get(p.ref);
    if (!r || r.hash !== hashOf(p)) continue;
    const v: unknown = JSON.parse(r.answer);
    if (typeof v === "number") answers.set(p.ref, v);
  }
  return { answers, hashOf };
}

/**
 * Checks the pairs and stores each answered one. Jev's unsure answers are kept (jev_unsure) until Haiku has settled their pair, so a
 * pair whose Haiku batch did not run or gave no answer goes straight to Haiku in a later job.
 */
export async function checkPairs(db: Db, keys: PairKey[], deps: CheckDeps, o: CheckOptions = {}): Promise<CheckCounts> {
  const c: CheckCounts = { checked: 0, jev: 0, haiku: 0, haikuAlone: 0, verdicts: {}, unanswered: 0 };
  const stop: Stop = o.stop ?? (async () => false);
  const inputs = await pairInputs(db, keys);
  const pairs = new Map(keys.map((k, i) => [pairRef(k.repo, k.a, k.b), { k, pair: inputs[i]! }]));
  const kept = await keptAnswers(db, inputs);
  const jevP = new Map<string, number | null>(kept.answers);
  /** Pairs Jev could not be asked because it is unavailable. */
  const alone = new Set<string>();
  const sent = new Set<string>();
  await pool([...pairs.entries()].filter(([ref]) => !kept.answers.has(ref)).map(([ref, e]) => async () => {
    if (await stop()) return;
    const usable = await deps.jevUsable?.() ?? true;
    const p = usable ? await deps.jev(e.pair, stop) : null;
    // A stopped pair without an answer is asked again by a later job, not handed to Haiku.
    if (p === null && await stop()) return;
    jevP.set(ref, p);
    if (p === null && !(await deps.jevUsable?.() ?? true)) alone.add(ref);
    else c.jev++;
    o.onHandled?.(sent.add(ref).size);
  }), (await loadLiveConfig(db)).jevParallel);
  const at = deps.now().toISOString();
  const keep = new Set(kept.answers.keys());
  const save = async (rows: Verdicted[]): Promise<void> => {
    await store(db, rows, at);
    for (const r of rows) {
      c.checked++;
      c.verdicts[r.verdict] = (c.verdicts[r.verdict] ?? 0) + 1;
    }
    await saveUnsure(db, { promptId: DUPES_JEV.id, keep: [], drop: rows.map((r) => pairRef(r.key.repo, r.key.a, r.key.b)).filter((ref) => keep.delete(ref)) });
  };
  const row = (ref: string, haiku: PairVerdict | null, verdict: PairVerdict): Verdicted => ({ key: pairs.get(ref)!.k, jev: jevP.get(ref) ?? null, haiku, verdict });
  const second: string[] = [];
  const first: Verdicted[] = [];
  for (const ref of pairs.keys()) {
    if (!jevP.has(ref)) continue;
    const v = alone.has(ref) ? null : settlePair(jevP.get(ref) ?? null, null);
    if (v) first.push(row(ref, null, v));
    else second.push(ref);
  }
  await save(first);
  const fresh = second.filter((ref) => !keep.has(ref) && jevP.get(ref) !== null);
  await saveUnsure(db, { promptId: DUPES_JEV.id, drop: [], keep: fresh.map((ref) => ({ ref, hash: kept.hashOf(pairs.get(ref)!.pair), answer: JSON.stringify(jevP.get(ref)), at })) });
  for (const ref of fresh) keep.add(ref);
  const batches = await repoBatches(db, second, HAIKU.limits.perCall, (r) => pairs.get(r)!.pair.repo, (r) => pairRefs(pairs.get(r)!.pair));
  await pool(batches.map((batch) => async () => {
    // One entry per batch pair; a pair without a valid answer stays in `rest` and is asked again.
    const input = batch.map((r) => pairs.get(r)!.pair);
    if (await stop()) return void (c.unanswered += input.length);
    for (const ref of batch) sent.add(ref);
    o.onHandled?.(sent.size);
    const r = await runModelStep(db, DUPES_HAIKU, input, { cancelled: stop, ask: async (ps) => {
      const text = await deps.haiku(ps);
      return text === null ? null : { text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
    } });
    const out: Verdicted[] = [];
    if (r.ok) for (const answers of r.values) {
      c.haiku += answers.length;
      for (const a of answers) {
        if (alone.has(a.ref)) c.haikuAlone++;
        out.push(row(a.ref, a.verdict, settlePair(jevP.get(a.ref) ?? null, a.verdict, alone.has(a.ref)) ?? "unsure"));
      }
    }
    await save(out);
    const todo = r.ok ? (r.rest ?? []) : input;
    c.unanswered += todo.length;
  }), poolRoom(db, (i) => [...new Set(batches[i]!.map((r) => pairs.get(r)!.pair.repo))], (i) => batches[i]!.flatMap((r) => pairRefs(pairs.get(r)!.pair)), { promptId: HAIKU.id }), { first: true, skipped: (i) => {
    c.unanswered += batches[i]!.length;
    for (const ref of batches[i]!) sent.delete(ref);
    o.onHandled?.(sent.size);
  } });
  return c;
}

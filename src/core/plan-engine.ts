// The incremental planner pass: facts kept between passes on one connection, reloaded only for the items the change log
// names (src/core/plan-changes.ts) and the items whose `refreshAt` has come, and decided again every pass with the pass time.
// A full load replaces them at start, on a full-pass mark, when an input outside the database changed, and every
// PLAN_FULL_EVERY_MS (src/runner/autopilot.ts).
//
// The shadow check (setting `plan_shadow` = "on") also runs a full load in the same read transaction every incremental
// pass and records each difference in `plan_shadow_diffs`; on a difference the pass plans from the full load and keeps its
// facts. AUTOCRAFT_PLAN_SHADOW (on, off, throw) overrides the setting; "throw" fails the pass on a difference (tests).
// Pass counts and durations per kind are in `plan_pass_stats`, written with the next difference, full load or minute.
import type { DatabaseSync } from "node:sqlite";
import { embedderId, modelName } from "../embed/model.ts";
import { appSlug } from "../github/identity.ts";
import { ownersStamp } from "../owners.ts";
import { setting } from "../settings-read.ts";
import { decideItem } from "./decide-item.ts";
import { decidePr } from "./decide.ts";
import { loadPass, loadPrFacts } from "./facts.ts";
import { loadItemFacts } from "./issue-facts.ts";
import { changeSeq, changesSince, pruneChanges } from "./plan-changes.ts";
import type { ItemFacts, PrFacts } from "./plan.ts";
import { loadPlanSet, type ItemPlanned, type PlanSet, type PrPlan } from "./plan-set.ts";

export type ShadowMode = "off" | "on" | "throw";
export type FullReason = "start" | "marker" | "cap" | "global" | "floor";

/** Newest rows kept in plan_shadow_diffs. */
export const SHADOW_ROWS = 2_000;

type State = {
  prs: Map<string, PrFacts>; items: Map<string, ItemFacts>;
  /** The change seq the facts cover. */
  seq: number;
  /** Pass time of the last full load. */
  fullAt: number;
  /** The inputs outside the database at the last pass (fingerprint()). */
  fingerprint: string;
};

const states = new WeakMap<DatabaseSync, State>();

/** Pass counts not yet written to plan_pass_stats, per connection. */
const records = new WeakMap<DatabaseSync, { flushedAt: number; counts: Map<string, { passes: number; refs: number; at: string; ms: number; maxMs: number }> }>();
/** Quiet passes write their counts and prune the change log at most this often. */
const RECORD_EVERY_MS = 60_000;

type Diff = { ref: string; side: "pr" | "item"; fields: string[]; detail: string };

export type PlanPass = {
  plans: PlanSet;
  /** "full:<reason>" or "incremental". */
  kind: string;
  /** Items loaded: every one on a full load, else the logged and refreshed ones. */
  refs: number;
  /** Differences the shadow check found (empty when it did not run). */
  diffs: Diff[];
  /** Records the pass with its duration (ms) and prunes the change log it consumed (a quiet pass: at most once a minute); call after the pass's writes succeeded. */
  finish: (passMs?: number) => void;
};

/** The shadow mode: the environment's (tests, harnesses), else the setting. */
export function shadowMode(db: DatabaseSync): ShadowMode {
  const env = process.env.AUTOCRAFT_PLAN_SHADOW;
  if (env === "on" || env === "off" || env === "throw") return env;
  return setting(db, "plan_shadow") === "on" ? "on" : "off";
}

/** The fact inputs that are not database rows: the owners cache, the GitHub App's slug, the classification run and the embedding model. */
const fingerprint = (run: string | null, model: string): string => JSON.stringify([ownersStamp(), appSlug(), run, model]);

const refOf = (f: { repo: string; number: number }): string => `${f.repo}#${f.number}`;
/** The order of a full load: repo, then number (the loaders' ORDER BY i.repo, i.number on ASCII names). */
const byRef = (a: { repo: string; number: number }, b: { repo: string; number: number }): number => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number);

/** Runs `fn` in one read transaction on `db` (inside the caller's when one is open). */
export function inReadSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/** Forgets the kept facts of `db`: its next pass loads everything. */
export function dropPlanState(db: DatabaseSync): void {
  states.delete(db);
}

const short = (v: unknown): string => {
  const s = v === undefined ? "undefined" : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

/** Keys whose values differ (as JSON), with a short summary of each. */
function compare(a: Record<string, unknown>, b: Record<string, unknown>, prefix: string, skip: string[] = []): { fields: string[]; detail: string[] } {
  const fields: string[] = [], detail: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.includes(k)) continue;
    const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
    if (x === y) continue;
    fields.push(`${prefix}${k}`);
    detail.push(`${prefix}${k}: ${short(a[k])} | full ${short(b[k])}`);
  }
  return { fields, detail };
}

/** Differences between the incremental and the full PlanSet: per ref facts (but `now`) and plans, refs in one only, and order. */
function shadowDiffs(inc: PlanSet, full: PlanSet): Diff[] {
  const out: Diff[] = [];
  const side = <F extends { repo: string; number: number }, P>(name: "pr" | "item", a: { facts: F; plan: P }[], b: { facts: F; plan: P }[]): void => {
    const fullBy = new Map(b.map((e) => [refOf(e.facts), e]));
    const incBy = new Map(a.map((e) => [refOf(e.facts), e]));
    for (const [ref, e] of incBy) {
      const f = fullBy.get(ref);
      if (!f) { out.push({ ref, side: name, fields: ["extra"], detail: "in the incremental set only" }); continue; }
      const facts = compare(e.facts as Record<string, unknown>, f.facts as Record<string, unknown>, "facts.", ["now"]);
      const plan = compare(e.plan as Record<string, unknown>, f.plan as Record<string, unknown>, "plan.");
      if (facts.fields.length || plan.fields.length) out.push({ ref, side: name, fields: [...facts.fields, ...plan.fields], detail: [...facts.detail, ...plan.detail].join("; ") });
    }
    for (const ref of fullBy.keys()) if (!incBy.has(ref)) out.push({ ref, side: name, fields: ["missing"], detail: "in the full set only" });
    if (!out.some((d) => d.side === name)) {
      const i = a.findIndex((e, n) => refOf(e.facts) !== refOf(b[n]!.facts));
      if (i >= 0) out.push({ ref: refOf(a[i]!.facts), side: name, fields: ["order"], detail: `position ${i}: full has ${refOf(b[i]!.facts)}` });
    }
  };
  side("pr", inc.prs, full.prs);
  side("item", inc.items, full.items);
  return out;
}

/** Facts equal but for `now` and `refreshAt`. */
const sameFacts = (a: object, b: object): boolean => compare(a as Record<string, unknown>, b as Record<string, unknown>, "", ["now", "refreshAt"]).fields.length === 0;

export type PlanPassOptions = {
  now: number; run: string | null; model?: string;
  /** The floor full load: a pass at least this long after the last full load loads everything. */
  fullEveryMs: number;
};

/**
 * One planner pass's PlanSet from the facts kept for `db`. Reads only; run it inside inReadSnapshot so the change log, the
 * loads and the shadow's full load see one state of the database.
 */
export function planPass(db: DatabaseSync, o: PlanPassOptions): PlanPass {
  const { now, run } = o;
  const model = o.model ?? embedderId(modelName());
  const shadow = shadowMode(db);
  const print = fingerprint(run, model);
  let state = states.get(db);
  const changes = state ? changesSince(db, state.seq) : null;
  const reason: FullReason | null = !state || !changes ? "start" : changes.full ? (changes.cause ?? "marker") : state.fingerprint !== print ? "global" : now - state.fullAt >= o.fullEveryMs ? "floor" : null;
  const load = { now, run };
  let refs: number;
  let refreshUnchanged = 0;
  if (reason) {
    // The seq first: the transaction holds the rows the loads below read at that seq.
    const seq = changeSeq(db);
    const prs = loadPrFacts(db, load), items = loadItemFacts(db, { ...load, model });
    state = { prs: new Map(prs.map((f) => [refOf(f), f])), items: new Map(items.map((f) => [refOf(f), f])), seq, fullAt: now, fingerprint: print };
    states.set(db, state);
    refs = new Set([...state.prs.keys(), ...state.items.keys()]).size;
  } else {
    const s = state!;
    const logged = new Set(changes!.refs);
    const due = new Map<string, { pr?: PrFacts; item?: ItemFacts }>();
    for (const [ref, f] of s.prs) if (f.refreshAt !== undefined && f.refreshAt <= now && !logged.has(ref)) due.set(ref, { pr: f });
    for (const [ref, f] of s.items) if (f.refreshAt !== undefined && f.refreshAt <= now && !logged.has(ref)) due.set(ref, { ...due.get(ref), item: f });
    const reload = [...logged, ...due.keys()];
    if (reload.length) {
      const prs = loadPrFacts(db, { ...load, refs: reload }), items = loadItemFacts(db, { ...load, model, refs: reload });
      for (const ref of reload) { s.prs.delete(ref); s.items.delete(ref); }
      for (const f of prs) s.prs.set(refOf(f), f);
      for (const f of items) s.items.set(refOf(f), f);
      // A reload at refreshAt that finds the same facts: a time registered for a change the facts do not show (a wasted
      // reload), or a change still ahead that no kept time covers (the shadow check then finds it). Counted, not recorded.
      for (const [ref, old] of due) {
        if (old.pr && sameFacts(old.pr, s.prs.get(ref) ?? {})) refreshUnchanged++;
        if (old.item && sameFacts(old.item, s.items.get(ref) ?? {})) refreshUnchanged++;
      }
    }
    s.seq = changes!.seq;
    s.fingerprint = print;
    refs = reload.length;
  }
  const kept = states.get(db)!;
  const pass = loadPass(now);
  const prs = [...kept.prs.values()].sort(byRef).map((facts): PrPlan => { facts.now = now; return { facts, plan: decidePr(facts, pass) }; });
  const items = [...kept.items.values()].sort(byRef).map((facts): ItemPlanned => { facts.now = now; return { facts, plan: decideItem(facts) }; });
  let plans: PlanSet = { run, now, pass, prs, items };
  const kind = reason ? `full:${reason}` : "incremental";
  const shadowRan = !reason && shadow !== "off";
  const diffs: Diff[] = [];
  if (shadowRan) {
    const full = loadPlanSet(db, { now, run, model });
    diffs.push(...shadowDiffs(plans, full));
    if (diffs.length && shadow === "throw") {
      states.delete(db);
      throw new Error(`plan shadow: ${diffs.length} difference(s): ${diffs.slice(0, 5).map((d) => `${d.ref} ${d.side} [${d.fields.join(", ")}] ${d.detail}`).join(" || ")}`);
    }
    if (diffs.length) {
      // The full load is right by definition: the pass plans from it, and the kept facts start again from it.
      plans = full;
      kept.prs = new Map(full.prs.map((e) => [refOf(e.facts), e.facts]));
      kept.items = new Map(full.items.map((e) => [refOf(e.facts), e.facts]));
    }
  }
  const seq = kept.seq;
  return {
    plans, kind, refs, diffs,
    finish: (passMs = 0) => {
      const rec = records.get(db) ?? records.set(db, { flushedAt: 0, counts: new Map() }).get(db)!;
      const at = new Date(now).toISOString();
      const add = (k: string, n: number, ms = 0): void => {
        const c = rec.counts.get(k) ?? { passes: 0, refs: 0, at, ms: 0, maxMs: 0 };
        rec.counts.set(k, { passes: c.passes + 1, refs: c.refs + n, at, ms: c.ms + ms, maxMs: Math.max(c.maxMs, ms) });
      };
      add(kind, refs, Math.round(passMs));
      if (shadowRan) add(diffs.length ? "shadow:different" : "shadow:same", diffs.length);
      if (refreshUnchanged) add("refresh:unchanged", refreshUnchanged);
      // A quiet pass writes nothing: the counts and the log's pruning wait for a difference, a full load or the next minute.
      if (!diffs.length && !reason && Date.now() - rec.flushedAt < RECORD_EVERY_MS) return;
      pruneChanges(db, seq);
      const count = db.prepare(`INSERT INTO main.plan_pass_stats (kind, passes, refs, last_at, ms, max_ms) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind) DO UPDATE SET passes = passes + excluded.passes, refs = refs + excluded.refs, last_at = excluded.last_at,
          ms = ms + excluded.ms, max_ms = max(max_ms, excluded.max_ms)`);
      for (const [k, c] of rec.counts) count.run(k, c.passes, c.refs, c.at, c.ms, c.maxMs);
      rec.counts.clear();
      rec.flushedAt = Date.now();
      if (diffs.length) {
        const put = db.prepare("INSERT INTO main.plan_shadow_diffs (at, ref, side, fields, detail) VALUES (?, ?, ?, ?, ?)");
        for (const d of diffs) put.run(at, d.ref, d.side, d.fields.join(","), d.detail.slice(0, 2000));
        db.prepare("DELETE FROM main.plan_shadow_diffs WHERE rowid <= (SELECT max(rowid) FROM main.plan_shadow_diffs) - ?").run(SHADOW_ROWS);
      }
    },
  };
}

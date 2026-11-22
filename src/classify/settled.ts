// The settled type label of an item for one classification run. Jev judges
// every item; Haiku gives a second opinion on the items Jev is unsure about.
//
// - Jev's top probability >= SURE: Jev's label is settled.
// - Otherwise, Haiku agrees with Jev: settled with that label.
// - Otherwise unsettled: "waiting" while Haiku hasn't answered, "disagree" when
//   it gave another label. A disagreement the Sonnet referee is sure about is
//   settled with its label (source "sonnet"); when it was unsure, the item stays
//   "disagree" with the referee's answer attached, for a person.
// - No Jev verdict in the run (Jev was unavailable): Haiku's label and flags
//   settle the item, source "haiku". Without either verdict: "unclassified".
//
// Each flag (security, needs decision) follows the same rule on its own: Jev
// sure yes sets it, Jev sure no clears it, and between the two bands Haiku's
// flag counts once Haiku has answered (not set before). The type's state does
// not matter for the flags.
//
// settle() is the rule; settledOf() applies it to one item and settledTable()
// to a whole run for queries.
import { audit } from "../dash/audit.ts";
import { REFEREE_MAX_FAILURES } from "../core/item-rules.ts";
import { flagBand, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "./parse.ts";
import type { Db } from "../db/index.ts";
import { quote } from "../db/portable.ts";
import * as kx from "../db/kx.ts";
import type { AliasableExpression, Insertable, SqlBool } from "kysely";
import type { DB } from "../db/types.ts";

export const SURE = 0.9;

/**
 * Rows that make an item or a run count as classified: Jev's, and Haiku's when it classified alone (Jev unavailable).
 * Only that path sets input_hash on a Haiku row; a second opinion or an evaluation row has none.
 */
export const VERDICT_SQL = "(classifier = 'jev' OR (classifier = 'haiku' AND input_hash IS NOT NULL))";

/** `VERDICT_SQL` as an expression; `a` names the classifications table when the caller's query aliases it. */
export function verdictExpr(eb: kx.AnyEb, a?: string): AliasableExpression<SqlBool> {
  const c = (col: string) => eb.ref(a ? `${a}.${col}` : col);
  return eb.or([eb(c("classifier"), "=", "jev"), eb.and([eb(c("classifier"), "=", "haiku"), eb(c("input_hash"), "is not", null)])]);
}

export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export type Verdict = { label: string; flags: string[] };

/** The referee's answer to the item's current disagreement. */
export type Referee = {
  label: string; sure: boolean; reason: string;
  /** The answer of the last referee (Opus, after Sonnet was unsure). An unsure final answer still settles the label, with a scope decision for the maintainer. */
  final?: boolean;
  /** Opus calls that gave no answer for the item, and when the last one failed. */
  failures?: number;
  failedAt?: string;
};

/** The referee has had its last word: Opus answered, or failed too often. An unsure last word still settles the label. */
export const refereeClosed = (r: Referee | null | undefined): boolean => !!r && (!!r.final || (r.failures ?? 0) >= REFEREE_MAX_FAILURES);

export type Settled = {
  status: SettledStatus;
  label: string | null;          // set only when status is "settled"
  source: "jev" | "haiku" | "sonnet" | null;
  confidence: number | null;     // Jev's top probability
  jevLabel: string | null;
  haikuLabel: string | null;
  // Flags that are set: see the rule above.
  flags: string[];
  // The referee's answer when one exists for the current verdicts, else null.
  referee: Referee | null;
};

/** Jev's needs_decision probability a settled bugfix needs before its "needs decision" flag counts. */
export const BUGFIX_NEEDS_DECISION = 0.7;

/** Jev raises needs_decision too freely on plain bugs: on a settled bugfix the flag counts only when Jev is firm. */
function firmFlags(s: Settled, nd: number | null | undefined): Settled {
  if (s.label !== "bugfix" || !s.flags.includes("needs decision") || (nd ?? 0) >= BUGFIX_NEEDS_DECISION) return s;
  return { ...s, flags: s.flags.filter((f) => f !== "needs decision") };
}

type JevVerdict = Verdict & { top: number | null; nd?: number | null; sec?: number | null };

/** One flag: Jev's band decides; unsure takes Haiku's answer, if any. A missing probability falls back to Jev's stored flag. */
function flagSet(name: string, p: number | null | undefined, yesMin: number, jev: JevVerdict, haiku: Verdict | null): boolean {
  if (typeof p !== "number") return jev.flags.includes(name);
  const band = flagBand(p, yesMin);
  return band === "unsure" ? !!haiku?.flags.includes(name) : band === "yes";
}

/** `jev.nd` and `jev.sec` are Jev's needs_decision and security probabilities (needsDecisionOf, securityOf). */
export function settle(jev: JevVerdict | null, haiku: Verdict | null, referee: Referee | null = null): Settled {
  const s = settleLabel(jev, haiku, referee);
  if (!jev) return s;
  const flags = [
    ...(flagSet("security", jev.sec, JEV_SECURITY_YES, jev, haiku) ? ["security"] : []),
    ...(flagSet("needs decision", jev.nd, JEV_NEEDS_DECISION_YES, jev, haiku) ? ["needs decision"] : []),
  ];
  const firm = firmFlags({ ...s, flags }, jev.nd);
  // The last referee was unsure whether we have the feature or want the difference: the label stands and a maintainer makes the call.
  return refereeClosed(referee) && !referee!.sure && !firm.flags.includes("needs decision") ? { ...firm, flags: [...firm.flags, "needs decision"] } : firm;
}

function settleLabel(jev: (Verdict & { top: number | null }) | null, haiku: Verdict | null, referee: Referee | null): Settled {
  if (!jev && haiku) return { status: "settled", label: haiku.label, source: "haiku", confidence: null, jevLabel: null, haikuLabel: haiku.label, flags: haiku.flags, referee: null };
  if (!jev) return { status: "unclassified", label: null, source: null, confidence: null, jevLabel: null, haikuLabel: null, flags: [], referee: null };
  const base = { confidence: jev.top, jevLabel: jev.label, haikuLabel: haiku?.label ?? null, referee: null };
  const flags: string[] = [];
  if ((jev.top ?? 0) >= SURE) return { ...base, status: "settled", label: jev.label, source: "jev", flags };
  if (!haiku) return { ...base, status: "waiting", label: null, source: null, flags };
  if (haiku.label === jev.label) return { ...base, status: "settled", label: jev.label, source: "haiku", flags };
  if (referee?.sure || refereeClosed(referee)) return { ...base, referee, status: "settled", label: referee!.label, source: "sonnet", flags };
  return { ...base, referee, status: "disagree", label: null, source: null, flags };
}

/** The run of the newest Jev or Haiku-alone verdict: two indexed lookups, the newer wins. */
export async function newestVerdictRun(db: Db): Promise<string | null> {
  const jev = await db.get(db.k.selectFrom("classifications").select(["run_id", "at"]).where("classifier", "=", "jev").orderBy("at", "desc").limit(1));
  const alone = await db.get(db.k.selectFrom("main.classifications").select(["run_id", "at"]).where("classifier", "=", "haiku").where("input_hash", "is not", null).orderBy("at", "desc").limit(1));
  return (alone && (!jev || alone.at > jev.at) ? alone : jev)?.run_id ?? null;
}

// The run the dashboard shows: the current classification run (settings.classify_run), else the one with the newest Jev verdict.
export async function latestRun(db: Db): Promise<string | null> {
  const set = await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "classify_run"));
  if (set?.value) return set.value;
  return await newestVerdictRun(db);
}

/** True when `run` has at least one Jev or Haiku verdict. */
export const runExists = async (db: Db, run: string): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("classifications").select((eb) => eb.lit(1).as("one")).where("run_id", "=", run).where((eb) => verdictExpr(eb)).limit(1));

/** Makes `run` the current classification run (settings.classify_run), audited. */
export async function setCurrentRun(db: Db, run: string, by: string): Promise<void> {
  const prev = (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "classify_run")))?.value ?? null;
  await db.run(db.k.insertInto("settings").values({ key: "classify_run", value: run }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  await audit(db, by, "classify-run", `run:${run}`, { previous: prev });
}

const parseFlags = (s: string | null): string[] => {
  try {
    const f = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

type ClsRow = { type_label: string | null; flags: string | null; probs: string | null; reason: string | null; at: string; input_hash: string | null };

/** The settled label from an item's Jev and Haiku rows of the run; `referee` reads its Sonnet row, only when both count. */
async function settledFrom(j: ClsRow | undefined, h0: ClsRow | undefined, referee: () => Promise<ClsRow | undefined>): Promise<Settled> {
  // A Haiku row without a Jev row counts only when Haiku classified alone.
  const h = h0 && (j || h0.input_hash !== null) ? h0 : undefined;
  const r = j && h ? await referee() : undefined;
  return settle(
    j && j.type_label !== null ? { label: j.type_label, flags: parseFlags(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
    h && h.type_label !== null ? { label: h.type_label, flags: parseFlags(h.flags) } : null,
    r && r.type_label !== null && j && h && r.at >= j.at && r.at >= h.at ? refereeOf(r.type_label, r.probs, r.reason) : null,
  );
}

/** settledOf() for one run: for loops over many items. */
export function settledLookup(db: Db, run: string | null): (repo: string, number: number) => Promise<Settled> {
  if (!run) return async () => settle(null, null);
  const q = (repo: string, number: number, classifier: string) => db.get(db.k.selectFrom("classifications")
    .select(["type_label", "flags", "probs", "reason", "at", "input_hash"])
    .where("repo", "=", repo).where("number", "=", number).where("classifier", "=", classifier).where("run_id", "=", run));
  return async (repo, number) => await settledFrom(await q(repo, number, "jev"), await q(repo, number, "haiku"),
    async () => await q(repo, number, "sonnet"));
}

/**
 * settledLookup() with the run's rows read in one query: every item of the run, or only `refs` ("repo#number"). An item
 * outside `refs` reads as unclassified.
 */
export async function settledSet(db: Db, run: string | null, refs?: Iterable<string>): Promise<(repo: string, number: number) => Promise<Settled>> {
  if (!run) return async () => settle(null, null);
  // Only what settledFrom() reads: the referee's reason, and Jev's probabilities without the per-type ones.
  const rows = await db.all(db.k.selectFrom("classifications")
    .select(["repo", "number", "classifier", "type_label", "flags", "at", "input_hash"])
    .select((eb) => [
      eb.case().when(eb.and([eb("classifier", "=", "jev"), kx.jsonValid(db, "probs")])).then(kx.jsonRemoveKey(db, "probs", "type")).else(eb.ref("probs")).end().as("probs"),
      eb.case().when("classifier", "=", "sonnet").then(eb.ref("reason")).end().as("reason"),
    ])
    .where("run_id", "=", run).where("classifier", "in", ["jev", "haiku", "sonnet"])
    .$if(!!refs, (q) => q.where(kx.refIn(db, "classifications", refs!))));
  const byItem = new Map<string, Partial<Record<string, ClsRow>>>();
  for (const r of rows) { const k = `${r.repo}#${r.number}`; (byItem.get(k) ?? byItem.set(k, {}).get(k)!)[r.classifier] = r; }
  return async (repo, number) => { const c = byItem.get(`${repo}#${number}`) ?? {}; return await settledFrom(c.jev, c.haiku, async () => c.sonnet); };
}

/** Loops resolve `run` once (latestRun) and pass it, or use settledLookup(). */
export async function settledOf(db: Db, repo: string, number: number, run?: string | null): Promise<Settled> {
  if (run === undefined) run = await latestRun(db);
  return await settledLookup(db, run)(repo, number);
}

/** A pipeline referee row: evaluation rows have no `sure` in probs and give null. */
function refereeOf(label: string, probs: string | null, reason: string | null): Referee | null {
  try {
    const p = JSON.parse(probs ?? "null") as { sure?: unknown; final?: unknown; opusFailures?: unknown; opusFailedAt?: unknown } | null;
    return typeof p?.sure === "boolean" ? { label, sure: p.sure, reason: reason ?? "", ...(p.final === true && { final: true }), ...(typeof p.opusFailures === "number" && { failures: p.opusFailures }), ...(typeof p.opusFailedAt === "string" && { failedAt: p.opusFailedAt }) } : null;
  } catch { return null; }
}

export function needsDecisionOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { needs_decision?: unknown } | null)?.needs_decision;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

export function securityOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { security?: unknown } | null)?.security;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

export function topOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

// Settled verdicts of a run as rows of item_settled (src/schema.sql), for queries that count or filter many items:
//   item_settled(run, repo, number, status, label, source, top, jev_label, haiku_label, flags JSON, security, needs_decision, referee_*)
// Items without a Jev or Haiku verdict have no row ("unclassified"). A run is built in full on first use; after that the
// triggers on classifications mark changed items in item_settled_dirty and a refresh works out only those again.

type VerdictRow = { repo: string; number: number; jl: string | null; jf: string | null; probs: string | null; hl: string | null; hf: string | null; sl: string | null; ss: number | null; sr: string | null; sf: number | null; sx: number | null };

/** Items with a Jev or a Haiku verdict in `run` (Haiku alone settles an item when Jev was unavailable), narrowed to `keys` when given. */
function verdictRows(db: Db, run: string, keys?: readonly (readonly [string, number])[]): Promise<VerdictRow[]> {
  // The Sonnet row's probs when they are valid JSON.
  const sp = (eb: kx.AnyEb) => eb.case().when(kx.jsonValid(db, "s.probs")).then(eb.ref("s.probs")).end();
  return db.all(db.k
    .selectFrom((eb) => eb.selectFrom("main.classifications").select(["repo", "number"]).where("run_id", "=", run).where("classifier", "=", "jev")
      .union(eb.selectFrom("main.classifications").select(["repo", "number"]).where("run_id", "=", run).where("classifier", "=", "haiku").where("input_hash", "is not", null))
      .as("k"))
    .leftJoin("main.classifications as j", (j) => j.onRef("j.repo", "=", "k.repo").onRef("j.number", "=", "k.number").on("j.classifier", "=", "jev").on("j.run_id", "=", run))
    .leftJoin("main.classifications as h", (j) => j.onRef("h.repo", "=", "k.repo").onRef("h.number", "=", "k.number").on("h.classifier", "=", "haiku").on("h.run_id", "=", run))
    .leftJoin("main.classifications as s", (j) => j.onRef("s.repo", "=", "k.repo").onRef("s.number", "=", "k.number").on("s.classifier", "=", "sonnet").on("s.run_id", "=", run)
      .onRef("s.at", ">=", "j.at").onRef("s.at", ">=", "h.at").on((eb) => eb(kx.jsonBool(db, sp(eb), "$.sure"), "is not", null)))
    .select(["k.repo", "k.number", "j.type_label as jl", "j.flags as jf", "j.probs", "h.type_label as hl", "h.flags as hf", "s.type_label as sl", "s.reason as sr"])
    .select((eb) => [kx.jsonBool(db, sp(eb), "$.sure").as("ss"), kx.jsonBool(db, sp(eb), "$.final").as("sf"), kx.jsonNum(db, sp(eb), "$.opusFailures").as("sx")])
    .$if(!!keys, (q) => q.where(kx.refIn(db, "k", keys!))));
}

/**
 * Brings item_settled up to date for `run`: a read when it is current, otherwise one write (db.write) that builds or
 * refreshes it. Call it before the db.read whose queries join the table, never inside one: inside a read snapshot it
 * changes nothing, so the snapshot sees the table as the last refresh left it. Join with `settledOn`.
 */
export async function settledTable(db: Db, run: string | null): Promise<void> {
  if (run === null || db.inTransaction("read")) return;
  const r = (await db.get(db.k.selectNoFrom((eb) => [
    eb.exists(eb.selectFrom("main.item_settled_runs").select(eb.lit(1).as("one")).where("run", "=", run)).as("built"),
    eb.exists(eb.selectFrom("main.item_settled_dirty").select(eb.lit(1).as("one")).where("run_id", "=", run)).as("dirty"),
  ])))!;
  if (r.built && !r.dirty) return;
  await db.write(() => refreshSettled(db, run));
}

/** The join condition of an item_settled row `alias` with the item `item` in `run` (null: no rows). */
export function settledOn(run: string | null, alias: string, item = "i"): string {
  return `${alias}.run = ${quote(run ?? "")} AND ${alias}.repo = ${item}.repo AND ${alias}.number = ${item}.number`;
}

/** `settledOn` as an expression, for a join condition: `.innerJoin("item_settled as s", (j) => j.on((eb) => settledOnExpr(eb, run, "s")))`. */
export function settledOnExpr(eb: kx.AnyEb, run: string | null, alias: string, item = "i"): AliasableExpression<SqlBool> {
  return eb.and([eb(eb.ref(`${alias}.run`), "=", run ?? ""), eb(eb.ref(`${alias}.repo`), "=", eb.ref(`${item}.repo`)), eb(eb.ref(`${alias}.number`), "=", eb.ref(`${item}.number`))]);
}

async function refreshSettled(db: Db, run: string): Promise<void> {
  const built = !!await db.get(db.k.selectFrom("main.item_settled_runs").select((eb) => eb.lit(1).as("one")).where("run", "=", run));
  const rows: Insertable<DB["main.item_settled"]>[] = [];
  const put = (r: VerdictRow) => {
    const ref = r.sl !== null && r.ss !== null ? { label: r.sl, sure: !!r.ss, reason: r.sr ?? "", ...(r.sf ? { final: true } : {}), ...(r.sx ? { failures: r.sx } : {}) } : null;
    const s = settle(r.jl === null ? null : { label: r.jl, flags: parseFlags(r.jf), top: topOf(r.probs), nd: needsDecisionOf(r.probs), sec: securityOf(r.probs) }, r.hl === null ? null : { label: r.hl, flags: parseFlags(r.hf) }, ref);
    rows.push({
      run, repo: r.repo, number: r.number, status: s.status, label: s.label, source: s.source, top: s.confidence, jev_label: s.jevLabel, haiku_label: s.haikuLabel,
      flags: JSON.stringify(s.flags), security: s.flags.includes("security") ? 1 : 0, needs_decision: s.flags.includes("needs decision") ? 1 : 0,
      referee_label: s.referee?.label ?? null, referee_sure: s.referee ? Number(s.referee.sure) : null, referee_reason: s.referee?.reason ?? null, referee_final: refereeClosed(s.referee) ? 1 : 0,
    });
  };
  if (!built) {
    // Marks made before this read are covered by it; marks committed after it stay for the next refresh.
    await db.run(db.k.deleteFrom("main.item_settled_dirty").where("run_id", "=", run));
    await db.run(db.k.deleteFrom("main.item_settled").where("run", "=", run));
    for (const r of await verdictRows(db, run)) put(r);
    // Built runs whose classifications are all gone.
    const gone = (eb: kx.AnyEb) => eb.selectFrom("main.item_settled_runs as r").select("r.run").where("r.run", "<>", run)
      .where((e) => e.not(e.exists(e.selectFrom("main.classifications as c").select(e.lit(1).as("one")).whereRef("c.run_id", "=", "r.run"))));
    await db.run(db.k.deleteFrom("main.item_settled").where("run", "in", gone));
    await db.run(db.k.deleteFrom("main.item_settled_runs").where("run", "in", gone));
  } else {
    const dirty = await db.all(db.k.selectFrom("main.item_settled_dirty").select(["repo", "number", "n"]).where("run_id", "=", run));
    if (!dirty.length) return;
    const keys = dirty.map((k) => [k.repo, k.number] as const);
    await db.run(db.k.deleteFrom("main.item_settled").where("run", "=", run).where(kx.refIn(db, "item_settled", keys)));
    for (const r of await verdictRows(db, run, keys)) put(r);
    // Only the marks read above: an item marked again since then (n moved) stays marked.
    await db.run(db.k.deleteFrom("main.item_settled_dirty").where("run_id", "=", run)
      .where(kx.tupleIn(db, ["repo", "number", "n"], dirty.map((k) => [k.repo, k.number, k.n]), ["text", "bigint", "bigint"])));
  }
  // Marks of runs that are not built: a run is built in full on first use. This run's are kept, built or not: a mark
  // committed during a first build covers a change that build may not have read.
  await db.run(db.k.deleteFrom("main.item_settled_dirty").where("run_id", "<>", run)
    .where("run_id", "not in", (eb) => eb.selectFrom("main.item_settled_runs").select("run")));
  if (rows.length) {
    await db.run(db.k.insertInto("main.item_settled")
      .columns(["run", "repo", "number", "status", "label", "source", "top", "jev_label", "haiku_label", "flags", "security", "needs_decision", "referee_label", "referee_sure", "referee_reason", "referee_final"])
      .expression((eb) => eb.selectFrom(kx.jsonEach(db, kx.json(rows), "v")).select(() => {
        const text = (c: string) => kx.jsonText(db, "v.value", `$.${c}`).as(c);
        const num = (c: string) => kx.jsonNum(db, "v.value", `$.${c}`).as(c);
        return [text("run"), text("repo"), num("number"), text("status"), text("label"), text("source"), num("top"), text("jev_label"), text("haiku_label"), text("flags"),
          num("security"), num("needs_decision"), text("referee_label"), num("referee_sure"), text("referee_reason"), num("referee_final")];
      })));
  }
  await db.run(db.k.insertInto("main.item_settled_runs").values({ run, refreshed_at: new Date().toISOString() })
    .onConflict((oc) => oc.column("run").doUpdateSet(kx.excluded(["refreshed_at"]))));
}

export type SettledRow = {
  status: string | null; label: string | null; source: string | null;
  top: number | null; jev_label: string | null; haiku_label: string | null; flags: string | null;
  referee_label: string | null; referee_sure: number | null; referee_reason: string | null; referee_final?: number | null;
};

// An item_settled row (or none) as the wire shape.
export function fromRow(r: Partial<SettledRow> | undefined): Settled {
  if (!r?.status) return settle(null, null);
  return {
    status: r.status as SettledStatus, label: r.label ?? null, source: (r.source as Settled["source"]) ?? null,
    confidence: r.top ?? null, jevLabel: r.jev_label ?? null, haikuLabel: r.haiku_label ?? null, flags: parseFlags(r.flags ?? null),
    referee: r.referee_label != null && r.referee_sure != null ? { label: r.referee_label, sure: !!r.referee_sure, reason: r.referee_reason ?? "", ...(r.referee_final ? { final: true } : {}) } : null,
  };
}

/** The verdict of a quiet pull request without its `security` flag (for every role), and without the referee's reason for viewers. */
export const unflagged = (s: Settled, quiet: boolean, staff = true): Settled =>
  quiet ? { ...s, flags: s.flags.filter((f) => f !== "security"), referee: s.referee && !staff ? { ...s.referee, reason: "" } : s.referee } : s;

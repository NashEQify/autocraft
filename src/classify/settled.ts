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
import { refIn, refPairs } from "../core/ref-filter.ts";
import { audit } from "../dash/audit.ts";
import { REFEREE_MAX_FAILURES } from "../core/item-rules.ts";
import { flagBand, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "./parse.ts";
import type { Db, Dialect } from "../db/index.ts";
import { jsonBool, jsonNum, jsonValid, quote } from "../db/portable.ts";

export const SURE = 0.9;

/**
 * Rows that make an item or a run count as classified: Jev's, and Haiku's when it classified alone (Jev unavailable).
 * Only that path sets input_hash on a Haiku row; a second opinion or an evaluation row has none.
 */
export const VERDICT_SQL = "(classifier = 'jev' OR (classifier = 'haiku' AND input_hash IS NOT NULL))";

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
  const jev = await db.prepare("SELECT run_id, at FROM classifications WHERE classifier = 'jev' ORDER BY at DESC LIMIT 1").get() as { run_id: string; at: string } | undefined;
  // SQLite's planner needs the partial index named; Postgres picks it.
  const hint = db.dialect === "sqlite" ? " INDEXED BY classifications_alone" : "";
  const alone = await db.prepare(`SELECT run_id, at FROM main.classifications${hint} WHERE classifier = 'haiku' AND input_hash IS NOT NULL ORDER BY at DESC LIMIT 1`).get() as { run_id: string; at: string } | undefined;
  return (alone && (!jev || alone.at > jev.at) ? alone : jev)?.run_id ?? null;
}

// The run the dashboard shows: the current classification run (settings.classify_run), else the one with the newest Jev verdict.
export async function latestRun(db: Db): Promise<string | null> {
  const set = await db.prepare("SELECT value FROM settings WHERE key = 'classify_run'").get() as { value: string } | undefined;
  if (set?.value) return set.value;
  return await newestVerdictRun(db);
}

/** True when `run` has at least one Jev or Haiku verdict. */
export const runExists = async (db: Db, run: string): Promise<boolean> =>
  !!await db.prepare(`SELECT 1 FROM classifications WHERE run_id = ? AND ${VERDICT_SQL} LIMIT 1`).get(run);

/** Makes `run` the current classification run (settings.classify_run), audited. */
export async function setCurrentRun(db: Db, run: string, by: string): Promise<void> {
  const prev = (await db.prepare("SELECT value FROM settings WHERE key = 'classify_run'").get() as { value: string } | undefined)?.value ?? null;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(run);
  await audit(db, by, "classify-run", `run:${run}`, { previous: prev });
}

const parseFlags = (s: string | null): string[] => {
  try {
    const f = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

type ClsRow = { type_label: string; flags: string | null; probs: string | null; reason: string | null; at: string; input_hash: string | null };

/** The settled label from an item's Jev and Haiku rows of the run; `referee` reads its Sonnet row, only when both count. */
async function settledFrom(j: ClsRow | undefined, h0: ClsRow | undefined, referee: () => Promise<ClsRow | undefined>): Promise<Settled> {
  // A Haiku row without a Jev row counts only when Haiku classified alone.
  const h = h0 && (j || h0.input_hash !== null) ? h0 : undefined;
  const r = j && h ? await referee() : undefined;
  return settle(
    j ? { label: j.type_label, flags: parseFlags(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
    h ? { label: h.type_label, flags: parseFlags(h.flags) } : null,
    r && j && h && r.at >= j.at && r.at >= h.at ? refereeOf(r.type_label, r.probs, r.reason) : null,
  );
}

/** settledOf() for one run, with the statement prepared once: for loops over many items. */
export function settledLookup(db: Db, run: string | null): (repo: string, number: number) => Promise<Settled> {
  if (!run) return async () => settle(null, null);
  const q = db.prepare("SELECT type_label, flags, probs, reason, at, input_hash FROM classifications WHERE repo = ? AND number = ? AND classifier = ? AND run_id = ?");
  return async (repo, number) => await settledFrom(await q.get(repo, number, "jev", run) as ClsRow | undefined, await q.get(repo, number, "haiku", run) as ClsRow | undefined,
    async () => await q.get(repo, number, "sonnet", run) as ClsRow | undefined);
}

/**
 * settledLookup() with the run's rows read in one query: every item of the run, or only `refs` ("repo#number"). An item
 * outside `refs` reads as unclassified.
 */
export async function settledSet(db: Db, run: string | null, refs?: Iterable<string>): Promise<(repo: string, number: number) => Promise<Settled>> {
  if (!run) return async () => settle(null, null);
  const narrow = refs ? ` AND ${refIn("classifications", "?")}` : "";
  // Only what settledFrom() reads: the referee's reason, and Jev's probabilities without the per-type ones.
  const rows = await db.prepare(`SELECT repo, number, classifier, type_label, flags, CASE WHEN classifier = 'jev' AND json_valid(probs) THEN json_remove(probs, '$.type') ELSE probs END AS probs,
      CASE WHEN classifier = 'sonnet' THEN reason END AS reason, at, input_hash FROM classifications
    WHERE run_id = ? AND classifier IN ('jev', 'haiku', 'sonnet')${narrow}`).all(...(refs ? [run, refPairs(refs)] : [run])) as (ClsRow & { repo: string; number: number; classifier: string })[];
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

/** Items with a Jev or a Haiku verdict in run `:run` (Haiku alone settles an item when Jev was unavailable). */
function verdictsSql(d: Dialect): string {
  const sp = `CASE WHEN ${jsonValid(d, "s.probs")} THEN s.probs END`;
  return `SELECT k.repo, k.number, j.type_label AS jl, j.flags AS jf, j.probs, h.type_label AS hl, h.flags AS hf,
    s.type_label AS sl, ${jsonBool(d, sp, "$.sure")} AS ss, s.reason AS sr, ${jsonBool(d, sp, "$.final")} AS sf, ${jsonNum(d, sp, "$.opusFailures")} AS sx
  FROM (SELECT repo, number FROM main.classifications WHERE run_id = :run AND classifier = 'jev' UNION SELECT repo, number FROM main.classifications WHERE run_id = :run AND classifier = 'haiku' AND input_hash IS NOT NULL) k
  LEFT JOIN main.classifications j ON j.repo = k.repo AND j.number = k.number AND j.classifier = 'jev' AND j.run_id = :run
  LEFT JOIN main.classifications h ON h.repo = k.repo AND h.number = k.number AND h.classifier = 'haiku' AND h.run_id = :run
  LEFT JOIN main.classifications s ON s.repo = k.repo AND s.number = k.number AND s.classifier = 'sonnet' AND s.run_id = :run
    AND s.at >= j.at AND s.at >= h.at AND ${jsonBool(d, sp, "$.sure")} IS NOT NULL
  WHERE 1 = 1`;
}

/** `(repo, number)` pairs from a JSON array of `[repo, number]` bound to `param`, as a subquery body. */
const pairsFrom = (d: Dialect, param: string, extra = ""): string => d === "postgres"
  ? `SELECT value ->> 0, (value ->> 1)::bigint${extra ? `, (value ->> 2)::bigint` : ""} FROM json_array_elements((${param})::json) AS value`
  : `SELECT value ->> 0, value ->> 1${extra ? ", value ->> 2" : ""} FROM json_each(${param})`;

const SETTLED_COLS = ["run", "repo", "number", "status", "label", "source", "top", "jev_label", "haiku_label", "flags", "security", "needs_decision", "referee_label", "referee_sure", "referee_reason", "referee_final"];
const PG_TYPES: Record<string, string> = { number: "bigint", top: "double precision", security: "bigint", needs_decision: "bigint", referee_sure: "bigint", referee_final: "bigint" };

/**
 * Brings item_settled up to date for `run`: a read when it is current, otherwise one write (db.write) that builds or
 * refreshes it. Call it before the db.read whose queries join the table, never inside one: inside a read snapshot it
 * changes nothing, so the snapshot sees the table as the last refresh left it. Join with `settledOn`.
 */
export async function settledTable(db: Db, run: string | null): Promise<void> {
  if (run === null || db.inTransaction("read")) return;
  const r = await db.prepare(`SELECT EXISTS (SELECT 1 FROM main.item_settled_runs WHERE run = ?) AS built,
    EXISTS (SELECT 1 FROM main.item_settled_dirty WHERE run_id = ?) AS dirty`).get(run, run) as { built: number; dirty: number };
  if (r.built && !r.dirty) return;
  await db.write(() => refreshSettled(db, run));
}

/** The join condition of an item_settled row `alias` with the item `item` in `run` (null: no rows). */
export function settledOn(run: string | null, alias: string, item = "i"): string {
  return `${alias}.run = ${quote(run ?? "")} AND ${alias}.repo = ${item}.repo AND ${alias}.number = ${item}.number`;
}

async function refreshSettled(db: Db, run: string): Promise<void> {
  const d = db.dialect;
  const built = !!await db.prepare("SELECT 1 FROM main.item_settled_runs WHERE run = ?").get(run);
  const rows: unknown[][] = [];
  const put = (r: VerdictRow) => {
    const ref = r.sl !== null && r.ss !== null ? { label: r.sl, sure: !!r.ss, reason: r.sr ?? "", ...(r.sf ? { final: true } : {}), ...(r.sx ? { failures: r.sx } : {}) } : null;
    const s = settle(r.jl === null ? null : { label: r.jl, flags: parseFlags(r.jf), top: topOf(r.probs), nd: needsDecisionOf(r.probs), sec: securityOf(r.probs) }, r.hl === null ? null : { label: r.hl, flags: parseFlags(r.hf) }, ref);
    rows.push([run, r.repo, r.number, s.status, s.label, s.source, s.confidence, s.jevLabel, s.haikuLabel, JSON.stringify(s.flags),
      s.flags.includes("security") ? 1 : 0, s.flags.includes("needs decision") ? 1 : 0, s.referee?.label ?? null, s.referee ? Number(s.referee.sure) : null, s.referee?.reason ?? null, refereeClosed(s.referee) ? 1 : 0]);
  };
  if (!built) {
    // Marks made before this read are covered by it; marks committed after it stay for the next refresh.
    await db.prepare("DELETE FROM main.item_settled_dirty WHERE run_id = ?").run(run);
    await db.prepare("DELETE FROM main.item_settled WHERE run = ?").run(run);
    for (const r of await db.prepare(verdictsSql(d)).all({ run }) as VerdictRow[]) put(r);
    // Built runs whose classifications are all gone.
    const gone = `SELECT r.run FROM main.item_settled_runs r WHERE r.run <> ? AND NOT EXISTS (SELECT 1 FROM main.classifications c WHERE c.run_id = r.run)`;
    await db.prepare(`DELETE FROM main.item_settled WHERE run IN (${gone})`).run(run);
    await db.prepare(`DELETE FROM main.item_settled_runs WHERE run IN (${gone})`).run(run);
  } else {
    const dirty = await db.prepare("SELECT repo, number, n FROM main.item_settled_dirty WHERE run_id = ?").all(run) as { repo: string; number: number; n: number }[];
    if (!dirty.length) return;
    const keys = JSON.stringify(dirty.map((k) => [k.repo, k.number]));
    await db.prepare(`DELETE FROM main.item_settled WHERE run = ? AND (repo, number) IN (${pairsFrom(d, "?")})`).run(run, keys);
    for (const r of await db.prepare(`${verdictsSql(d)} AND (k.repo, k.number) IN (${pairsFrom(d, ":keys")})`).all({ run, keys }) as VerdictRow[]) put(r);
    // Only the marks read above: an item marked again since then (n moved) stays marked.
    await db.prepare(`DELETE FROM main.item_settled_dirty WHERE run_id = ? AND (repo, number, n) IN (${pairsFrom(d, "?", "n")})`)
      .run(run, JSON.stringify(dirty.map((k) => [k.repo, k.number, k.n])));
  }
  // Marks of runs that are not built: a run is built in full on first use. This run's are kept, built or not: a mark
  // committed during a first build covers a change that build may not have read.
  await db.prepare("DELETE FROM main.item_settled_dirty WHERE run_id <> ? AND run_id NOT IN (SELECT run FROM main.item_settled_runs)").run(run);
  if (rows.length) {
    const cols = SETTLED_COLS.map((c, i) => (d === "postgres" ? `(value ->> ${i})${PG_TYPES[c] ? `::${PG_TYPES[c]}` : ""}` : `value ->> ${i}`)).join(", ");
    const from = d === "postgres" ? "json_array_elements((?)::json) AS value" : "json_each(?)";
    await db.prepare(`INSERT INTO main.item_settled (${SETTLED_COLS.join(", ")}) SELECT ${cols} FROM ${from}`).run(JSON.stringify(rows));
  }
  await db.prepare("INSERT INTO main.item_settled_runs (run, refreshed_at) VALUES (?, ?) ON CONFLICT (run) DO UPDATE SET refreshed_at = excluded.refreshed_at")
    .run(run, new Date().toISOString());
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

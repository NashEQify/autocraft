// The per-repo flowchart summary (table flow_summary): refreshed by the runner
// for repos whose data changed, read and added up by GET /api/flow.
import { latestRun, newestVerdictRun } from "../classify/settled.ts";
import { trackedNames } from "../repos.ts";
import { countAll, type Counts } from "./count.ts";
import type { Db } from "../db/index.ts";
import { groupConcat, indexedBy, inList } from "../db/portable.ts";
import { pgJsonArray } from "../core/pg-expr.ts";

/** A row older than this is counted again even when nothing changed: the 24-hour windows move. */
export const MAX_AGE_MS = 10 * 60_000;
const MARKS_KEY = "flow_summary_marks";

type Marks = { items: string; cls: number; stages: number; opus: number; merges: number; checks: string; plans?: string; global: string; vers?: Record<string, string> };

const getMarks = async (db: Db): Promise<Marks | null> => {
  const v = (await db.prepare("SELECT value FROM main.settings WHERE key = ?").get(MARKS_KEY) as { value: string } | undefined)?.value;
  try { return v ? (JSON.parse(v) as Marks) : null; } catch { return null; }
};

/** Per repo, a signature of its decisions; a batch (repo NULL) counts for each repo it names. */
async function decisionSigs(db: Db): Promise<Map<string, string>> {
  const pg = db.dialect === "postgres";
  const rows = await db.prepare(`SELECT COALESCE(d.repo, ${pg ? "j.value ->> 'repo'" : "json_extract(j.value, '$.repo')"}) AS repo,
      COUNT(*) || ':' || COUNT(d.answer) || ':' || COALESCE(MAX(d.answered_at), '') || ':' || COALESCE(MAX(d.asked_at), '') || ':' || COALESCE(SUM(length(d.answer)), 0) AS sig
    FROM main.decisions d ${pg
      ? `LEFT JOIN LATERAL json_array_elements(CASE WHEN d.repo IS NULL THEN ${pgJsonArray("d.items")} ELSE '[]'::json END) AS j(value) ON true`
      : "LEFT JOIN json_each(CASE WHEN d.repo IS NULL AND json_valid(d.items) THEN d.items ELSE '[]' END) j"}
    GROUP BY 1`).all() as { repo: string | null; sig: string }[];
  return new Map(rows.filter((r) => r.repo).map((r) => [r.repo!, r.sig]));
}

/** Per repo, a signature of its verifications (rows change state in place, so no row id marks a change). */
async function verificationSigs(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await db.prepare(`SELECT repo, state, COUNT(*) AS n, MAX(created_at) AS c, COALESCE(MAX(finished_at), '') AS f FROM main.verifications GROUP BY repo, state`).all() as
    { repo: string; state: string; n: number; c: string; f: string }[]) out[r.repo] = `${out[r.repo] ?? ""}${r.state}:${r.n}:${r.c}:${r.f};`;
  return out;
}

/** Settings that change every repo's counts: the classification run, label approvals and the tracked set. */
const globalSig = async (db: Db, kv = groupConcat(db, "key || '=' || value", ",", "key")): Promise<string> => JSON.stringify([await db.prepare(`SELECT
    (SELECT value FROM main.settings WHERE key = 'classify_run') AS run,
    (SELECT ${kv} FROM main.settings WHERE key LIKE 'labels_approved:%') AS approvals,
    (SELECT ${kv} FROM main.settings WHERE key LIKE 'merge_approved:%') AS mergeApprovals,
    (SELECT ${kv} FROM main.settings WHERE key LIKE 'fixissue_approved:%' OR key LIKE 'push_approved:%' OR key LIKE 'comment_approved:%' OR key LIKE 'mainfix_approved:%') AS writeApprovals,
    (SELECT ${groupConcat(db, "name", ",", "name")} FROM main.tracked_repos) AS tracked,
    NULL AS jev`).get(), await newestVerdictRun(db)]);

/** Marks the repos whose data changed since the last call as stale, and moves the marks. */
export async function markChanged(db: Db): Promise<number> {
  const prev = await getMarks(db);
  const cur: Marks = await db.prepare(`SELECT
      COALESCE((SELECT MAX(updated_at) FROM main.items), '') AS items,
      COALESCE((SELECT MAX(rowid) FROM main.classifications), 0) AS cls,
      COALESCE((SELECT MAX(rowid) FROM main.stages), 0) AS stages,
      COALESCE((SELECT MAX(rowid) FROM main.opus_reviews), 0) AS opus,
      COALESCE((SELECT MAX(rowid) FROM main.merges), 0) AS merges,
      COALESCE((SELECT MAX(fetched_at) FROM main.pr_checks), '') AS checks,
      COALESCE((SELECT MAX(planned_at) FROM main.item_plans), '') AS plans`).get() as unknown as Marks;
  cur.global = await globalSig(db);
  cur.vers = await verificationSigs(db);
  const dirty = new Set<string>();
  let all = !prev || prev.global !== cur.global;
  if (!all && prev) {
    const add = async (sql: string, ...p: (string | number)[]) => {
      for (const r of await db.prepare(sql).all(...p) as { repo: string }[]) dirty.add(r.repo);
    };
    await add(`SELECT DISTINCT repo FROM main.items${indexedBy(db, "items_updated")} WHERE updated_at > ?`, prev.items);
    await add("SELECT DISTINCT repo FROM main.classifications WHERE rowid > ?", prev.cls);
    await add("SELECT DISTINCT repo FROM main.stages WHERE rowid > ?", prev.stages);
    await add("SELECT DISTINCT repo FROM main.opus_reviews WHERE rowid > ?", prev.opus ?? 0);
    await add("SELECT DISTINCT repo FROM main.merges WHERE rowid > ?", prev.merges);
    await add("SELECT DISTINCT repo FROM main.pr_checks WHERE fetched_at > ?", prev.checks);
    // Counts of what is due or queued read the Plan cache; a row leaving it moves items.updated_at or a table above.
    await add("SELECT DISTINCT repo FROM main.item_plans WHERE planned_at > ?", prev.plans ?? "");
    for (const r of new Set([...Object.keys(cur.vers), ...Object.keys(prev.vers ?? {})])) if (!prev.vers || prev.vers[r] !== cur.vers[r]) dirty.add(r);
    const sigs = await decisionSigs(db);
    for (const r of await db.prepare("SELECT repo, decisions_sig FROM main.flow_summary").all() as { repo: string; decisions_sig: string | null }[]) {
      if ((sigs.get(r.repo) ?? null) !== r.decisions_sig) dirty.add(r.repo);
    }
  }
  if (all) await db.script("UPDATE main.flow_summary SET stale = 1");
  else if (dirty.size) await db.prepare(`UPDATE main.flow_summary SET stale = 1 WHERE ${inList(db, "repo")}`).run(JSON.stringify([...dirty]));
  await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MARKS_KEY, JSON.stringify(cur));
  return all ? -1 : dirty.size;
}

/** Counts one repo and stores its row. */
export async function countRepo(db: Db, repo: string, now = Date.now(), run?: string | null): Promise<Counts> {
  if (run === undefined) run = await latestRun(db);
  const counts = (await countAll(db, repo, now, run)).counts;
  await db.prepare(`INSERT INTO main.flow_summary (repo, counts, counted_at, stale, decisions_sig) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (repo) DO UPDATE SET counts = excluded.counts, counted_at = excluded.counted_at, stale = 0, decisions_sig = excluded.decisions_sig`)
    .run(repo, JSON.stringify(counts), new Date(now).toISOString(), (await decisionSigs(db)).get(repo) ?? null);
  return counts;
}

/**
 * One refresh pass for the runner: marks changed repos, then counts the
 * missing, stale and oldest rows (beyond MAX_AGE_MS) until `budgetMs` is used.
 * Returns the repos counted.
 */
export async function refreshSummary(db: Db, budgetMs = 1500): Promise<string[]> {
  const start = Date.now();
  await markChanged(db);
  await db.script("DELETE FROM main.flow_summary WHERE repo NOT IN (SELECT name FROM main.tracked_repos)");
  const have = new Map((await db.prepare("SELECT repo, counted_at, stale FROM main.flow_summary").all() as { repo: string; counted_at: string; stale: number }[]).map((r) => [r.repo, r]));
  const old = new Date(start - MAX_AGE_MS).toISOString();
  const due = (await trackedNames(db))
    .map((repo) => ({ repo, row: have.get(repo) }))
    .filter((x) => !x.row || x.row.stale || x.row.counted_at < old)
    .sort((a, b) => (a.row ? (a.row.stale ? 1 : 2) : 0) - (b.row ? (b.row.stale ? 1 : 2) : 0) || (a.row?.counted_at ?? "").localeCompare(b.row?.counted_at ?? ""));
  const done: string[] = [];
  const run = await latestRun(db);
  for (const { repo } of due) {
    if (done.length && Date.now() - start > budgetMs) break;
    await countRepo(db, repo, Date.now(), run);
    done.push(repo);
  }
  return done;
}

/**
 * The summed counts of every tracked repo (or of `only`), or of one. A repo without a row yet
 * is counted here while `budgetMs` lasts; the rest are left to the runner and
 * listed in `uncounted`.
 */
export async function readSummary(db: Db, repo: string | null, budgetMs = 150, only?: string[]): Promise<{ counts: Counts; countedAt: string | null; uncounted: string[] }> {
  const start = Date.now();
  const want = repo ? [repo] : (only ?? await trackedNames(db));
  const rows = new Map((await db.prepare("SELECT repo, counts, counted_at FROM main.flow_summary").all() as { repo: string; counts: string; counted_at: string }[]).map((r) => [r.repo, r]));
  const sum: Counts = {};
  const uncounted: string[] = [];
  let oldest: string | null = null;
  for (const r of want) {
    const row = rows.get(r);
    if (!row && Date.now() - start > budgetMs) {
      uncounted.push(r);
      continue;
    }
    const counts = row ? (JSON.parse(row.counts) as Counts) : await countRepo(db, r);
    const at = row?.counted_at ?? new Date().toISOString();
    if (!oldest || at < oldest) oldest = at;
    for (const [k, v] of Object.entries(counts)) sum[k] = k.startsWith("max.") ? Math.max(sum[k] ?? 0, v) : (sum[k] ?? 0) + v;
  }
  return { counts: sum, countedAt: oldest, uncounted };
}

// The per-repo flowchart summary (table flow_summary): refreshed by the runner
// for repos whose data changed, read and added up by GET /api/flow.
import { latestRun, newestVerdictRun } from "../classify/settled.ts";
import { trackedNames } from "../repos.ts";
import { countAll, type Counts } from "./count.ts";
import type { Db } from "../db/index.ts";
import type { SelectQueryBuilder } from "kysely";
import * as kx from "../db/kx.ts";

/** A row older than this is counted again even when nothing changed: the 24-hour windows move. */
export const MAX_AGE_MS = 10 * 60_000;
const MARKS_KEY = "flow_summary_marks";

type Marks = { items: string; cls: number; stages: number; opus: number; merges: number; checks: string; plans?: string; global: string; vers?: Record<string, string> };

const getMarks = async (db: Db): Promise<Marks | null> => {
  const v = (await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", MARKS_KEY)))?.value;
  try { return v ? (JSON.parse(v) as Marks) : null; } catch { return null; }
};

/** Per repo, a signature of its decisions; a batch (repo NULL) counts for each repo it names. */
async function decisionSigs(db: Db): Promise<Map<string, string>> {
  const repoOf = (eb: kx.Eb) => eb.fn.coalesce("d.repo", kx.jsonText(db, "j.value", "$.repo"));
  const rows = await db.all(db.k.selectFrom("main.decisions as d")
    .leftJoin((eb) => kx.jsonEach(db, eb.case()
      .when(eb.and([eb("d.repo", "is", null), kx.jsonValid(db, "d.items")]))
      .then(eb.case().when(kx.jsonType(db, "d.items"), "=", "array").then(eb.ref("d.items")).else(eb.val("[]")).end())
      .else(eb.val("[]")).end(), "j"), (j) => j.onTrue())
    .select((eb) => [
      repoOf(eb).as("repo"),
      eb.fn.countAll<number>().as("n"),
      eb.fn.count<number>("d.answer").as("answers"),
      eb.fn.max<string | null>("d.answered_at").as("answered"),
      eb.fn.max<string | null>("d.asked_at").as("asked"),
      eb.fn.sum<number | null>(eb.fn<number>("length", ["d.answer"])).as("size"),
    ])
    .groupBy((eb) => repoOf(eb)));
  return new Map(rows.filter((r) => r.repo).map((r) => [r.repo!, `${r.n}:${r.answers}:${r.answered ?? ""}:${r.asked ?? ""}:${r.size ?? 0}`]));
}

/** Per repo, a signature of its verifications (rows change state in place, so no row id marks a change). */
async function verificationSigs(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await db.all(db.k.selectFrom("main.verifications").select((eb) => [
    "repo", "state", eb.fn.countAll<number>().as("n"), eb.fn.max<string>("created_at").as("c"), eb.fn.coalesce(eb.fn.max<string | null>("finished_at"), eb.val("")).as("f"),
  ]).groupBy(["repo", "state"]).orderBy("repo").orderBy("state"))) out[r.repo] = `${out[r.repo] ?? ""}${r.state}:${r.n}:${r.c}:${r.f};`;
  return out;
}

/** Settings that change every repo's counts: the classification run, label approvals and the tracked set. */
const globalSig = async (db: Db): Promise<string> => JSON.stringify([await db.get(db.k.selectNoFrom((eb) => {
  const approvals = (...prefixes: string[]) => eb.selectFrom("main.settings")
    .select((e) => kx.groupConcat(db, e(e("key", "||", e.val("=")), "||", e.ref("value")), ",", "key").as("v"))
    .where((e) => e.or(prefixes.map((p) => kx.like(db, "key", e.val(`${p}:%`)))));
  return [
    eb.selectFrom("main.settings").select("value").where("key", "=", "classify_run").as("run"),
    approvals("labels_approved").as("approvals"),
    approvals("merge_approved").as("mergeApprovals"),
    approvals("fixissue_approved", "push_approved", "comment_approved", "mainfix_approved").as("writeApprovals"),
    eb.selectFrom("main.tracked_repos").select(kx.groupConcat(db, "name", ",", "name").as("v")).as("tracked"),
    eb.lit(null).as("jev"),
  ];
})), await newestVerdictRun(db)]);

/** Marks the repos whose data changed since the last call as stale, and moves the marks. */
export async function markChanged(db: Db): Promise<number> {
  const prev = await getMarks(db);
  const top = (eb: kx.Eb, table: "main.items" | "main.pr_checks" | "main.item_plans", col: "updated_at" | "fetched_at" | "planned_at") =>
    eb.fn.coalesce(eb.selectFrom(table).select(eb.fn.max<string | null>(col).as("m")), eb.val(""));
  const last = (eb: kx.Eb, table: "main.classifications" | "main.stages" | "main.opus_reviews" | "main.merges") =>
    eb.fn.coalesce(eb.selectFrom(table).select(eb.fn.max<number | null>(kx.rowid(table)).as("m")), eb.val(0));
  const cur: Marks = {
    ...(await db.get(db.k.selectNoFrom((eb) => [
      top(eb, "main.items", "updated_at").as("items"),
      last(eb, "main.classifications").as("cls"),
      last(eb, "main.stages").as("stages"),
      last(eb, "main.opus_reviews").as("opus"),
      last(eb, "main.merges").as("merges"),
      top(eb, "main.pr_checks", "fetched_at").as("checks"),
      top(eb, "main.item_plans", "planned_at").as("plans"),
    ])))!,
    global: await globalSig(db),
    vers: await verificationSigs(db),
  };
  const dirty = new Set<string>();
  let all = !prev || prev.global !== cur.global;
  if (!all && prev) {
    const add = async (q: SelectQueryBuilder<any, any, { repo: string }>) => {
      for (const r of await db.all(q)) dirty.add(r.repo);
    };
    await add(db.k.selectFrom("main.items").select("repo").distinct().where("updated_at", ">", prev.items));
    await add(db.k.selectFrom("main.classifications").select("repo").distinct().where(kx.rowid("main.classifications"), ">", prev.cls));
    await add(db.k.selectFrom("main.stages").select("repo").distinct().where(kx.rowid("main.stages"), ">", prev.stages));
    await add(db.k.selectFrom("main.opus_reviews").select("repo").distinct().where(kx.rowid("main.opus_reviews"), ">", prev.opus ?? 0));
    await add(db.k.selectFrom("main.merges").select("repo").distinct().where(kx.rowid("main.merges"), ">", prev.merges));
    await add(db.k.selectFrom("main.pr_checks").select("repo").distinct().where("fetched_at", ">", prev.checks));
    // Counts of what is due or queued read the Plan cache; a row leaving it moves items.updated_at or a table above.
    await add(db.k.selectFrom("main.item_plans").select("repo").distinct().where("planned_at", ">", prev.plans ?? ""));
    for (const r of new Set([...Object.keys(cur.vers!), ...Object.keys(prev.vers ?? {})])) if (!prev.vers || prev.vers[r] !== cur.vers![r]) dirty.add(r);
    const sigs = await decisionSigs(db);
    for (const r of await db.all(db.k.selectFrom("main.flow_summary").select(["repo", "decisions_sig"]))) {
      if ((sigs.get(r.repo) ?? null) !== r.decisions_sig) dirty.add(r.repo);
    }
  }
  if (all) await db.run(db.k.updateTable("main.flow_summary").set({ stale: 1 }));
  else if (dirty.size) await db.run(db.k.updateTable("main.flow_summary").set({ stale: 1 }).where(kx.inList(db, "repo", [...dirty])));
  await db.run(db.k.insertInto("main.settings").values({ key: MARKS_KEY, value: JSON.stringify(cur) })
    .onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  return all ? -1 : dirty.size;
}

/** Counts one repo and stores its row. */
export async function countRepo(db: Db, repo: string, now = Date.now(), run?: string | null): Promise<Counts> {
  if (run === undefined) run = await latestRun(db);
  const counts = (await countAll(db, repo, now, run)).counts;
  await db.run(db.k.insertInto("main.flow_summary")
    .values({ repo, counts: JSON.stringify(counts), counted_at: new Date(now).toISOString(), stale: 0, decisions_sig: (await decisionSigs(db)).get(repo) ?? null })
    .onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["counts", "counted_at", "stale", "decisions_sig"]))));
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
  await db.run(db.k.deleteFrom("main.flow_summary").where("repo", "not in", (eb) => eb.selectFrom("main.tracked_repos").select("name")));
  const have = new Map((await db.all(db.k.selectFrom("main.flow_summary").select(["repo", "counted_at", "stale"]))).map((r) => [r.repo, r]));
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
  const rows = new Map((await db.all(db.k.selectFrom("main.flow_summary").select(["repo", "counts", "counted_at"]))).map((r) => [r.repo, r]));
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

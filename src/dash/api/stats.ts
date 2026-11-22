// Shared queries for the Progress, Repo and Run and cost pages.
import { latestRun, settledOnExpr, settledTable } from "../../classify/settled.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { indexedBy, like, ref, type Eb, type Ex } from "../../db/kx.ts";

/**
 * Latest stage per item, from the item_stage table the stages trigger maintains, as a WITH clause to build the query on:
 * `latestCteExpr(db, repo).selectFrom("latest")...`.
 */
export const latestCteExpr = (db: Db, repo?: string) =>
  db.k.with("latest", (qc) => qc.selectFrom("main.item_stage").select(["repo", "number", "stage", "reviewed"]).$if(!!repo, (q) => q.where("repo", "=", repo!)));

// When tracking began: set by connect() (src/db.ts) on first use.
export async function trackingStart(db: Db): Promise<string> {
  const r = await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", "tracking_started_at"));
  return r?.value ?? new Date().toISOString();
}

/** The repo in `col` is a tracked repo. */
export const trackedExpr = (db: Db, eb: Eb, col: Ex = "repo"): AliasableExpression<SqlBool> => eb(ref(col), "in", db.k.selectFrom("main.tracked_repos").select("name"));

export type FunnelRow = {
  repo: string; open: number; classified: number; second_opinion: number; disagreement: number; reviewed: number;
  take: number; hold: number; close: number; needs_decision: number; batched: number;
};

// "classified" counts settled type labels (src/classify/settled.ts) in the latest run.
export async function funnelByRepo(db: Db, repo?: string): Promise<FunnelRow[]> {
  const run = await latestRun(db);
  await settledTable(db, run);
  return db.all(latestCteExpr(db, repo).selectFrom("items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .leftJoin("item_settled as st", (j) => j.on((eb) => settledOnExpr(eb, run, "st")))
    .select((eb) => {
      const count = (cond: Expression<SqlBool>) => eb.fn.sum<number>(eb.case().when(cond).then(eb.lit(1)).else(eb.lit(0)).end());
      return [
        "i.repo", eb.fn.countAll<number>().as("open"),
        count(eb("st.status", "=", "settled")).as("classified"), count(eb("st.status", "=", "waiting")).as("second_opinion"), count(eb("st.status", "=", "disagree")).as("disagreement"),
        count(eb.or([
          eb(eb.fn.coalesce("l.reviewed", eb.lit(0)), "=", 1),
          eb.exists(eb.selectFrom("main.classifications as c").select(eb.lit(1).as("one")).whereRef("c.repo", "=", "i.repo").whereRef("c.number", "=", "i.number").where("c.classifier", "=", "sonnet")),
        ])).as("reviewed"),
        count(eb.or([eb("l.stage", "in", ["take", "verified"]), eb.and([like(db, "l.stage", eb.val("verify-%")), eb("l.stage", "<>", "verify-failed")])])).as("take"),
        count(eb("l.stage", "=", "hold")).as("hold"), count(eb("l.stage", "=", "close")).as("close"),
        count(eb("l.stage", "=", "needs-decision")).as("needs_decision"), count(eb("l.stage", "=", "batched")).as("batched"),
      ];
    })
    .where("i.state", "=", "OPEN").$if(!!repo, (q) => q.where("i.repo", "=", repo!))
    .groupBy("i.repo"));
}

export type DoneRow = { repo: string; merged_pipeline: number; closed_pipeline: number; closed_others: number; total: number };

// Done since tracking began. Merged PRs carry closed_at too, so one range covers both.
export async function doneByRepo(db: Db, start: string, repo?: string): Promise<DoneRow[]> {
  return (await db.all(latestCteExpr(db, repo)
    .with("d", (qb) => qb.selectFrom(indexedBy(db, "main.items", "items_closed", "i")).leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
      .select(["i.repo", "i.state", "l.stage"])
      .where("i.closed_at", ">=", start).where("i.state", "<>", "OPEN").where((eb) => trackedExpr(db, eb, "i.repo"))
      .$if(!!repo, (q) => q.where("i.repo", "=", repo!)))
    .selectFrom("d")
    .select((eb) => {
      const count = (cond: Expression<SqlBool>) => eb.fn.sum<number>(eb.case().when(cond).then(eb.lit(1)).else(eb.lit(0)).end());
      return [
        "repo",
        count(eb.and([eb("state", "=", "MERGED"), eb("stage", "=", "merged")])).as("merged_pipeline"),
        count(eb.and([eb("state", "=", "CLOSED"), eb("stage", "in", ["closed", "fixed-by-us"])])).as("closed_pipeline"),
        eb.fn.countAll<number>().as("total"),
      ];
    })
    .groupBy("repo"))).map((x) => ({ ...x, closed_others: x.total - x.merged_pipeline - x.closed_pipeline }));
}

// Open items per repo per day since tracking began, rebuilt backwards from the
// current open count and the created/closed dates.
export async function trend(db: Db, start: string, openNow: Map<string, number>, repo?: string): Promise<{ days: string[]; series: Map<string, number[]> }> {
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = [];
  for (let t = Date.parse(start.slice(0, 10)); ; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d);
    if (d >= today || days.length > 365) break;
  }
  const day = (eb: Eb, col: string) => eb.fn<string>("substr", [col, eb.lit(1), eb.lit(10)]);
  // Over every repo the date indexes read only the range; the planner would rather walk the repo index.
  const created = await db.all(db.k.selectFrom(indexedBy(db, "main.items", "items_created", "i"))
    .select((eb) => ["repo", day(eb, "created_at").as("d"), eb.fn.countAll<number>().as("n")])
    .where("created_at", ">=", start).where((eb) => trackedExpr(db, eb)).$if(!!repo, (q) => q.where("repo", "=", repo!))
    .groupBy((eb) => ["repo", day(eb, "created_at")]).orderBy("repo").orderBy("d"));
  const closed = await db.all(db.k.selectFrom(indexedBy(db, "main.items", "items_closed", "i"))
    .select((eb) => ["repo", day(eb, "closed_at").as("d"), eb.fn.countAll<number>().as("n")])
    .where("closed_at", ">=", start).where("state", "<>", "OPEN").where((eb) => trackedExpr(db, eb)).$if(!!repo, (q) => q.where("repo", "=", repo!))
    .groupBy((eb) => ["repo", day(eb, "closed_at")]).orderBy("repo").orderBy("d"));
  const delta = new Map<string, Map<string, number>>();
  const add = (repo: string, d: string, n: number) => {
    if (!delta.has(repo)) delta.set(repo, new Map());
    const m = delta.get(repo)!;
    m.set(d, (m.get(d) ?? 0) + n);
  };
  for (const x of created) add(x.repo, x.d, x.n);
  for (const x of closed) add(x.repo, x.d, -x.n);
  const series = new Map<string, number[]>();
  // every repo in openNow gets a series, a repo with nothing open one of zeros
  for (const name of new Set([...openNow.keys(), ...delta.keys()])) {
    const m = delta.get(name) ?? new Map<string, number>();
    // value at the end of each day; walk back from today's open count
    const out = new Array<number>(days.length);
    let v = openNow.get(name) ?? 0;
    for (let k = days.length - 1; k >= 0; k--) {
      out[k] = v;
      v -= m.get(days[k]) ?? 0;
    }
    series.set(name, out);
  }
  return { days, series };
}

// Read-only insight endpoints: classifier agreement per run, and token use and spend.
import type {
  Agreement, ClassifierReport, ClassifierRun, CostReport, Disagreement, DisagreementList, FlagAgreement, UsageTotals,
} from "../../../web/src/api/types.ts";
import { BANDS, bandIndex } from "../../classify/report.ts";
import { LABELS } from "../../classify/rules.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { excludeHiddenExpr, hiddenRepos } from "./visible.ts";
import type { Expression, NotNull, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

const FLAGS = ["security", "needs decision"];

// ---- classifiers -------------------------------------------------------------

async function runs(db: Db, hidden: string[]): Promise<ClassifierRun[]> {
  const hide = excludeHiddenExpr(db, "x.repo", hidden);
  const prob = new Map<string, boolean>();
  for (const r of await db.all(db.k.selectFrom("classifications").select(["run_id", "classifier", (eb) => eb.fn.count<number>("probs").as("p")]).groupBy(["run_id", "classifier"])))
    prob.set(`${r.run_id}\0${r.classifier}`, r.p > 0);
  const pairs = await db.all(db.k.selectFrom("classifications as x")
    .innerJoin("classifications as y", (j) => j.onRef("y.run_id", "=", "x.run_id").onRef("y.repo", "=", "x.repo").onRef("y.number", "=", "x.number").onRef("y.classifier", ">", "x.classifier"))
    .select(["x.run_id as run", "x.classifier as x", "y.classifier as y", (eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.max<string>("x.at").as("at")])
    .$if(!!hide, (q) => q.where(hide!))
    .groupBy(["x.run_id", "x.classifier", "y.classifier"]).orderBy("x.run_id").orderBy("x.classifier").orderBy("y.classifier"));
  const by = new Map<string, ClassifierRun>();
  for (const p of pairs) {
    let r = by.get(p.run);
    if (!r) by.set(p.run, (r = { id: p.run, at: p.at, pairs: [] }));
    if (p.at > r.at) r.at = p.at;
    // The classifier with probabilities goes first, so bands describe it.
    const swap = !prob.get(`${p.run}\0${p.x}`) && !!prob.get(`${p.run}\0${p.y}`);
    r.pairs.push(swap ? { a: p.y, b: p.x, items: p.n } : { a: p.x, b: p.y, items: p.n });
  }
  for (const r of by.values()) r.pairs.sort((u, v) => v.items - u.items || u.a.localeCompare(v.a));
  return [...by.values()].sort((u, v) => v.at.localeCompare(u.at));
}

const agr = (): Agreement => ({ n: 0, agree: 0 });
const tally = (g: Agreement, same: boolean) => { g.n++; if (same) g.agree++; };

function flagsOf(s: string | null): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export async function classifiersReport(db: Db, req: Req): Promise<ClassifierReport> {
  const hide = excludeHiddenExpr(db, "x.repo", await hiddenRepos(db, req));
  const all = await runs(db, await hiddenRepos(db, req));
  const run = all.find((r) => r.id === req.query.get("run")) ?? all[0];
  if (!run) return { runs: [], run: "", a: "", b: "", labels: [...LABELS], items: 0, overall: agr(), byKind: { pr: agr(), issue: agr() }, byLabel: [], byRepo: [], confusion: [], bands: [], flags: [] };
  const qa = req.query.get("a"), qb = req.query.get("b");
  const pair = run.pairs.find((p) => p.a === qa && p.b === qb) ?? run.pairs.find((p) => p.a === qb && p.b === qa) ?? run.pairs[0]!;
  const rows = await db.all(db.k.selectFrom("classifications as x")
    .innerJoin("classifications as y", (j) => j.onRef("y.run_id", "=", "x.run_id").onRef("y.repo", "=", "x.repo").onRef("y.number", "=", "x.number").on("y.classifier", "=", pair.b))
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "x.repo").onRef("i.number", "=", "x.number"))
    .select(["x.repo", "i.kind", "x.type_label as ta", "y.type_label as tb", kx.jsonNum(db, "x.probs", "$.top").as("pa"), "x.flags as fa", "y.flags as fb"])
    .where("x.run_id", "=", run.id).where("x.classifier", "=", pair.a).$if(!!hide, (q) => q.where(hide!)));

  const idx = new Map<string, number>(LABELS.map((l, i) => [l, i]));
  const overall = agr(), kind = { pr: agr(), issue: agr() };
  const byLabel = new Map<string, Agreement>(), byRepo = new Map<string, Agreement>();
  const confusion = LABELS.map(() => LABELS.map(() => 0));
  const bandN = BANDS.map(agr);
  const flags = FLAGS.map((flag): FlagAgreement => ({ flag, n: 0, agree: 0, both: 0, onlyA: 0, onlyB: 0 }));
  for (const r of rows) {
    const same = r.ta === r.tb;
    if (r.ta && r.tb) {
      tally(overall, same);
      if (r.kind === "pr" || r.kind === "issue") tally(kind[r.kind], same);
      tally(byLabel.get(r.ta) ?? byLabel.set(r.ta, agr()).get(r.ta)!, same);
      tally(byRepo.get(r.repo) ?? byRepo.set(r.repo, agr()).get(r.repo)!, same);
      const i = idx.get(r.ta), j = idx.get(r.tb);
      if (i !== undefined && j !== undefined) confusion[i]![j]!++;
      if (r.pa !== null) tally(bandN[bandIndex(r.pa)]!, same);
    }
    const fa = flagsOf(r.fa), fb = flagsOf(r.fb);
    flags.forEach((f) => {
      const x = fa.includes(f.flag), y = fb.includes(f.flag);
      f.n++;
      if (x === y) f.agree++;
      if (x && y) f.both++;
      else if (x) f.onlyA++;
      else if (y) f.onlyB++;
    });
  }
  let cumN = 0, cumAgree = 0;
  const bands = bandN.map((b, i) => {
    cumN += b.n;
    cumAgree += b.agree;
    return { band: BANDS[i]!.band, ...b, cumN, cumAgree };
  });
  const known = bandN.some((b) => b.n > 0);
  return {
    runs: all, run: run.id, a: pair.a, b: pair.b, labels: [...LABELS], items: rows.length, overall, byKind: kind,
    byLabel: LABELS.map((label) => ({ label, ...(byLabel.get(label) ?? agr()) })),
    byRepo: [...byRepo].map(([repo, v]) => ({ repo, ...v })).sort((u, v) => v.n - u.n),
    confusion, bands: known ? bands : [], flags,
  };
}

export async function disagreements(db: Db, req: Req): Promise<DisagreementList> {
  const run = req.query.get("run") ?? "", a = req.query.get("a") ?? "", b = req.query.get("b") ?? "";
  const hide = excludeHiddenExpr(db, "x.repo", await hiddenRepos(db, req));
  const label = req.query.get("label");
  const bandName = req.query.get("band");
  let lo = 0, hi = 0;
  if (bandName) {
    const bd = BANDS.find((x) => x.band === bandName);
    if (!bd) throw new HttpError(400, "unknown band");
    lo = Number.isFinite(bd.lo) ? bd.lo : -1;
    hi = Number.isFinite(bd.hi) ? bd.hi : 2;
  }
  const lim = Math.min(200, Math.max(1, Math.floor(Number(req.query.get("limit"))) || 50));
  const off = Math.min(1_000_000, Math.max(0, Math.floor(Number(req.query.get("offset"))) || 0));
  const from = () => db.k.selectFrom("classifications as x")
    .innerJoin("classifications as y", (j) => j.onRef("y.run_id", "=", "x.run_id").onRef("y.repo", "=", "x.repo").onRef("y.number", "=", "x.number").on("y.classifier", "=", b))
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "x.repo").onRef("i.number", "=", "x.number"))
    .where((eb) => {
      const where: Expression<SqlBool>[] = [eb("x.run_id", "=", run), eb("x.classifier", "=", a), eb("x.type_label", "is not", null), eb("y.type_label", "is not", null), eb("x.type_label", "<>", eb.ref("y.type_label"))];
      if (hide) where.push(hide);
      if (label) where.push(eb.or([eb("x.type_label", "=", label), eb("y.type_label", "=", label)]));
      if (bandName) where.push(eb.and([eb(kx.jsonNum(db, "x.probs", "$.top"), ">=", lo), eb(kx.jsonNum(db, "x.probs", "$.top"), "<", hi)]));
      return eb.and(where);
    });
  const total = (await db.get(from().select((eb) => eb.fn.countAll<number>().as("n"))))!.n;
  const rows = await db.all(from().select(["x.repo", "x.number", "i.kind", "i.state", "i.title", "x.type_label as la", "y.type_label as lb", kx.jsonNum(db, "x.probs", "$.top").as("pa"), kx.jsonNum(db, "y.probs", "$.top").as("pb")])
    .$narrowType<{ la: NotNull; lb: NotNull }>().orderBy("x.repo").orderBy("x.number").limit(lim).offset(off));
  return {
    total,
    rows: rows.map((r): Disagreement => ({
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: r.state ? itemState(r.state) : null, title: r.title ?? "",
      a: { label: r.la, prob: r.pa }, b: { label: r.lb, prob: r.pb },
    })),
  };
}

// ---- run and cost ------------------------------------------------------------

/** The totals columns of a usage report; `items` names the column that counts items. */
const totals = (eb: kx.Eb, items: "items" | "item_count") => [
  eb.fn.countAll<number>().as("calls"), eb.fn.coalesce(eb.fn.sum<number>(items), eb.lit(0)).as("items"),
  eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.lit(0)).as("input"), eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.lit(0)).as("output"),
  eb.fn.coalesce(eb.fn.sum<number>("cache_read_tokens"), eb.lit(0)).as("cacheRead"), eb.fn.coalesce(eb.fn.sum<number>("cache_write_tokens"), eb.lit(0)).as("cacheWrite"),
  eb.fn.sum<number | null>("cost_usd").as("usd"),
  eb.fn.coalesce(eb.fn<number>("round", [eb(eb(eb.fn("julianday", [eb.fn.max("ended_at")]), "-", eb.fn("julianday", [eb.fn.min("started_at")])), "*", eb.lit(86400))]), eb.lit(0)).as("wallSeconds"),
];

/** Input, output and cache tokens of a call, null counted as 0. */
const tokensOf = (eb: kx.Eb) => eb.fn.coalesce(eb.fn.sum<number>(eb(eb(eb(eb.fn.coalesce("input_tokens", eb.lit(0)), "+", eb.fn.coalesce("output_tokens", eb.lit(0))), "+", eb.fn.coalesce("cache_read_tokens", eb.lit(0))), "+", eb.fn.coalesce("cache_write_tokens", eb.lit(0)))), eb.lit(0));

export async function cost(db: Db, req: Req): Promise<CostReport> {
  const run = req.query.get("run") ?? "";
  const hidden = await hiddenRepos(db, req);
  const hide = excludeHiddenExpr(db, "repo", hidden);
  // Per-user usage is for staff. Under a repo filter a run counts only when it has items and all of them are visible.
  const hideRuns = excludeHiddenExpr(db, "x.repo", hidden);
  const staff = canSeeInternals(req);
  // Null-safe: calls without a repo (classification runs) stay in the totals.
  const flt = (eb: kx.Eb) => eb.and([...(run ? [eb("run_id", "=", run)] : []), ...(hide ? [eb.or([eb("repo", "is", null), hide])] : [])]);
  const usage = () => db.k.selectFrom("token_usage").where(flt);
  const total = (await db.get(usage().select((eb) => totals(eb, "items"))))!;
  const span = (await db.get(usage().select((eb) => [eb.fn.min<string | null>(eb.fn.coalesce("ended_at", "started_at")).as("a"), eb.fn.max<string | null>(eb.fn.coalesce("ended_at", "started_at")).as("b")])))!;
  const hours = span.a && span.b ? (Date.parse(span.b) - Date.parse(span.a)) / 3600_000 : 0;
  const bucketSize = hours > 72 ? "day" : "hour";
  const len = bucketSize === "day" ? 10 : 13;
  const lastAt = (eb: kx.Eb) => eb.fn.max(eb.fn.coalesce("ended_at", "started_at"));
  return {
    runs: await db.all(db.k.selectFrom("token_usage").select(["run_id as id", (eb) => eb.fn.min<string>("started_at").as("from"), (eb) => lastAt(eb).as("to")])
      .$narrowType<{ from: string; to: string }>().$if(!!hide, (q) => q.where((eb) => eb.or([eb("repo", "is", null), hide!])))
      .groupBy("run_id").orderBy(lastAt, (o) => o.desc().nullsLast()).orderBy("run_id")),
    run,
    total: { ...total },
    itemsClassified: (await db.get(db.k.selectFrom((eb) => eb.selectFrom("classifications").select(["repo", "number"]).distinct().where(flt).as("m")).select((eb) => eb.fn.countAll<number>().as("n"))))!.n,
    stages: await db.all(usage().select((eb) => [eb.fn.coalesce("stage", eb.val("")).as("stage"), eb.fn.coalesce("model", eb.val("")).as("model"), ...totals(eb, "items")])
      .groupBy(["stage", "model"]).orderBy("stage").orderBy("model")),
    repos: await db.all(usage().select((eb) => ["repo", ...totals(eb, "items")]).$narrowType<{ repo: NotNull }>().where("repo", "is not", null)
      .groupBy("repo").orderBy(tokensOf, "desc").orderBy("repo")),
    users: !staff ? [] : await db.all(db.k.selectFrom("agent_runs").select((eb) => ["user_login as login", ...totals(eb, "item_count")])
      .where("provider", "=", "claude")
      .$if(!!hideRuns, (q) => q.where((eb) => eb.and([
        eb.exists(eb.selectFrom("agent_run_items as y").select(eb.lit(1).as("one")).whereRef("y.run_id", "=", "agent_runs.id")),
        eb.not(eb.exists(eb.selectFrom("agent_run_items as x").select(eb.lit(1).as("one")).whereRef("x.run_id", "=", "agent_runs.id").where(eb.not(hideRuns!)))),
      ])))
      .$if(!!run, (q) => q.where((eb) => eb.between("started_at",
        eb.selectFrom("token_usage").select(eb.fn.min<string>("started_at").as("lo")).where("run_id", "=", run),
        eb.selectFrom("token_usage").select(eb.fn.max<string>(eb.fn.coalesce("ended_at", "started_at")).as("hi")).where("run_id", "=", run))))
      .groupBy("user_login").orderBy((eb) => eb.case().when("user_login", "is", null).then(eb.lit(1)).else(eb.lit(0)).end())
      .orderBy((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)), "desc").orderBy("user_login")),
    series: await db.all(usage().select((eb) => [eb.fn<string>("substr", [eb.fn.coalesce("ended_at", "started_at"), eb.lit(1), eb.lit(len)]).as("bucket"), tokensOf(eb).as("tokens"), eb.fn.sum<number | null>("cost_usd").as("usd")])
      .where((eb) => eb(eb.fn.coalesce("ended_at", "started_at"), "is not", null)).groupBy("bucket").orderBy("bucket")),
    bucketSize,
  };
}

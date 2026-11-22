// The public status layer: the only source of what anonymous people (the Discord bot, a PR status comment) may learn about an
// item or about the pipeline. It names an item's place on a fixed list of steps and gives counts. It never carries hold
// reasons, prompts, model output, account data or anything about a security fix, and it knows only public tracked repos.
import { scoreLookup } from "../rank/position.ts";
import { fastPositions } from "../fasttrack.ts";
import type { AliasableExpression, SqlBool } from "kysely";
import { quietExprFor, quietSqlFor } from "../security/quiet.ts";
import { sortSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { jsonBool, jsonEach, jsonText, jsonValid, like, ref, type Eb, type Ex } from "../db/kx.ts";

export const STEPS = ["New", "Triaged", "In review", "Waiting for CI", "Fix-up in progress", "Needs a maintainer decision", "In the merge queue", "Merged", "Closed"] as const;
export type PublicStep = (typeof STEPS)[number];

export type PublicStatus = {
  ref: string; title: string; url: string; kind: "issue" | "pr";
  state: "open" | "merged" | "closed";
  step: PublicStep;
  /** Only for step "In the merge queue": the place among the repo's PRs that will merge next, and how many there are. */
  queue?: { position: number; of: number };
};

// Mapping from stored data to a step (first match wins; open items only):
//
//   items.state MERGED / CLOSED                                   -> Merged / Closed
//   an open decisions row for the item (any kind)                 -> Needs a maintainer decision
//   issue: no item_stage row                                      -> New
//   issue: any other                                              -> Triaged
//   PR plan state in-batch, batch-checking, ready,
//     decision-answered-merge, and not held (view.queue.held)     -> In the merge queue (#n of m)
//   PR plan state needs-fix-up, or view.fixup = fix,
//     or view.cifix = cifix-queued | cifix-rerun                  -> Fix-up in progress
//   PR plan state waiting-ci, waiting-premerge, waiting-verify,
//     ci-approval, waiting-main-ci                                -> Waiting for CI
//   PR with no item_stage row                                     -> New
//   PR never reviewed (item_stage.reviewed = 0, no queue state)   -> Triaged
//   PR any other (reviewed: held, refused, conflict, changes
//     requested, stale ... all look the same)                     -> In review
//
// Held and refused states are deliberately folded into "In review": the reason is not public.
const QUEUED = ["in-batch", "batch-checking", "ready", "decision-answered-merge"];
const FIXING = ["needs-fix-up"];
const WAITING = ["waiting-ci", "waiting-premerge", "waiting-verify", "ci-approval", "waiting-main-ci"];
const NEVER_REVIEWED = ["not-reviewed", "label-not-reviewed", "out-of-scope", "scope", "draft"];

/** True for a repo that is tracked and public. */
export const isPublicRepo = async (db: Db, repo: string): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("main.tracked_repos as t").innerJoin("main.repos as r", "r.name", "t.name").select((eb) => eb.lit(1).as("one"))
    .where("t.name", "=", repo).where((eb) => eb(eb.fn("lower", ["r.visibility"]), "=", "public")));

/** Names of the tracked repos that are public. */
export const publicRepoNames = async (db: Db): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.tracked_repos as t").innerJoin("main.repos as r", "r.name", "t.name").select("t.name")
    .where((eb) => eb(eb.fn("lower", ["r.visibility"]), "=", "public")).orderBy("t.name"))).map((r) => r.name);

/** The security cases an anonymous viewer must not see: a quiet fix PR, any finding's fix PR, an item the classifier flagged or a label marks as security. */
export const hiddenSql = (repo: string, number: string, labels: string): string => `(${quietSqlFor(repo, number)}
  OR EXISTS (SELECT 1 FROM main.security_findings sf WHERE sf.repo = ${repo} AND (sf.fix_pr = ${number}))
  OR EXISTS (SELECT 1 FROM main.classifications c, json_each(CASE WHEN json_valid(c.flags) THEN c.flags ELSE '[]' END) f WHERE c.repo = ${repo} AND c.number = ${number} AND f.value = 'security')
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${labels}) THEN ${labels} ELSE '[]' END) l WHERE lower(l.value) LIKE '%security%'))`;

/** `hiddenSql` as an expression on the item's `repo`, `number` and `labels` (column references or values). */
export function hiddenExpr(db: Db, eb: Eb, repo: Ex, number: Ex, labels: Ex): AliasableExpression<SqlBool> {
  const array = (e: Ex) => eb.case().when(jsonValid(db, e)).then(ref<string>(e)).else("[]").end();
  return eb.or([
    quietExprFor(db, eb, repo, number),
    eb.exists(db.k.selectFrom("main.security_findings as sf").select(eb.lit(1).as("one")).where("sf.repo", "=", ref<string>(repo)).where("sf.fix_pr", "=", ref<number>(number))),
    eb.exists(db.k.selectFrom("main.classifications as c").crossJoin(jsonEach(db, array("c.flags"), "f")).select(eb.lit(1).as("one"))
      .where("c.repo", "=", ref<string>(repo)).where("c.number", "=", ref<number>(number)).where("f.value", "=", "security")),
    eb.exists(db.k.selectFrom(jsonEach(db, array(labels), "l")).select(eb.lit(1).as("one"))
      .where((e) => like(db, e.fn("lower", ["l.value"]), e.val("%security%")))),
  ]);
}

export async function publicStatus(db: Db, repo: string, number: number): Promise<PublicStatus | null> {
  if (!await isPublicRepo(db, repo)) return null;
  const row = await db.get(db.k.selectFrom("main.items as i")
    .leftJoin("main.item_stage as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select((eb) => ["i.title", "i.url", "i.kind", "i.state", hiddenExpr(db, eb, "i.repo", "i.number", "i.labels").as("hidden"),
      "s.stage", "s.reviewed", "p.state as plan", "p.view",
      eb.exists(eb.selectFrom("main.decisions as d").select(eb.lit(1).as("one")).whereRef("d.repo", "=", "i.repo").whereRef("d.number", "=", "i.number").where("d.answer", "is", null)).as("decision")])
    .where("i.repo", "=", repo).where("i.number", "=", number));
  if (!row || row.hidden || !row.url) return null;
  const kind = row.kind === "pr" ? "pr" : "issue";
  const base = { ref: `${repo}#${number}`, title: row.title ?? "", url: row.url, kind } as const;
  if (row.state === "MERGED") return { ...base, state: "merged", step: "Merged" };
  if (row.state === "CLOSED") return { ...base, state: "closed", step: "Closed" };
  const open = { ...base, state: "open" } as const;
  if (row.decision) return { ...open, step: "Needs a maintainer decision" };
  if (kind === "issue") return { ...open, step: row.stage === null ? "New" : "Triaged" };
  let view: { fixup?: string; cifix?: string; queue?: { held?: boolean } } = {};
  try {
    const v: unknown = row.view ? JSON.parse(row.view) : {};
    if (v && typeof v === "object") view = v;
  } catch {
    // An unreadable cached view counts as no view.
  }
  const plan = row.plan ?? "";
  if (QUEUED.includes(plan) && !view.queue?.held) {
    const q = await queuePlace(db, repo, number);
    if (q) return { ...open, step: "In the merge queue", queue: q };
  }
  if (FIXING.includes(plan) || view.fixup === "fix" || view.cifix === "cifix-queued" || view.cifix === "cifix-rerun") return { ...open, step: "Fix-up in progress" };
  if (WAITING.includes(plan)) return { ...open, step: "Waiting for CI" };
  if (row.stage === null) return { ...open, step: "New" };
  if (!row.reviewed && (NEVER_REVIEWED.includes(plan) || plan === "")) return { ...open, step: "Triaged" };
  return { ...open, step: "In review" };
}

/** Open PRs of a repo that are queued to merge, in the dashboard queue page's order: fast-tracked first, batch members after ready ones, then by work rank, repo and number. */
async function queueOf(db: Db, repo: string): Promise<number[]> {
  const rows = await db.all(db.k.selectFrom("main.item_plans as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.number", "p.state"])
    .where("p.repo", "=", repo).where("p.kind", "=", "pr").where("p.state", "in", QUEUED)
    .where((eb) => eb(jsonText(db, "p.view", "$.gh"), "=", "OPEN"))
    .where((eb) => eb(eb.fn.coalesce(jsonBool(db, "p.view", "$.queue.held"), eb.lit(0)), "=", 0))
    .where((eb) => eb.not(hiddenExpr(db, eb, "p.repo", "p.number", "i.labels"))));
  const fast = await fastPositions(db), score = scoreLookup(db);
  const fp = (n: number): number => fast.get(`${repo}#${n}`)?.position ?? 1e9;
  const cls = (s: string) => (s === "in-batch" || s === "batch-checking" ? 1 : 0);
  return (await sortSeq(rows, async (a, b) => fp(a.number) - fp(b.number) || cls(a.state) - cls(b.state)
    || (await score(repo, b.number) ?? -1) - (await score(repo, a.number) ?? -1) || a.number - b.number)).map((r) => r.number);
}

async function queuePlace(db: Db, repo: string, number: number): Promise<{ position: number; of: number } | null> {
  const q = await queueOf(db, repo);
  const at = q.indexOf(number);
  return at < 0 ? null : { position: at + 1, of: q.length };
}

export type PublicStats = {
  repo: string | null;
  openIssues: number; openPrs: number;
  mergedLast7Days: number; mergedByAutoCraftLast7Days: number;
  reviewsPostedLast7Days: number;
  /** Median hours from opening to merge over PRs merged in the last 30 days; null with none. */
  medianOpenToMergeHours30Days: number | null;
  queueLength: number;
};

const DAY = 86_400_000;

/** Counts for one public tracked repo, or all of them (`repo` omitted). null when `repo` is not public and tracked. */
export async function publicStats(db: Db, repo?: string, now = Date.now()): Promise<PublicStats | null> {
  if (repo !== undefined && !await isPublicRepo(db, repo)) return null;
  const repos = repo !== undefined ? [repo] : await publicRepoNames(db);
  const out: PublicStats = { repo: repo ?? null, openIssues: 0, openPrs: 0, mergedLast7Days: 0, mergedByAutoCraftLast7Days: 0, reviewsPostedLast7Days: 0, medianOpenToMergeHours30Days: null, queueLength: 0 };
  const since7 = new Date(now - 7 * DAY).toISOString(), since30 = new Date(now - 30 * DAY).toISOString();
  const open = async (r: string, kind: string): Promise<number> => (await db.get(db.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.repo", "=", r).where("i.kind", "=", kind).where("i.state", "=", "OPEN")
    .where((eb) => eb.not(hiddenExpr(db, eb, "i.repo", "i.number", "i.labels")))))!.n;
  const merged = (r: string) => db.all(db.k.selectFrom("main.items as i")
    .select((eb) => ["i.created_at", "i.merged_at", eb.or([
      eb.exists(eb.selectFrom("main.merges as m").select(eb.lit(1).as("one")).whereRef("m.repo", "=", "i.repo").whereRef("m.number", "=", "i.number").where("m.outcome", "=", "merged")),
      eb.exists(eb.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as b", "b.id", "bp.batch_id").select(eb.lit(1).as("one"))
        .whereRef("b.repo", "=", "i.repo").whereRef("bp.number", "=", "i.number").where("b.state", "=", "merged")),
    ]).as("ours")])
    .where("i.repo", "=", r).where("i.state", "=", "MERGED").where("i.kind", "=", "pr").where("i.merged_at", ">=", since30)
    .where((eb) => eb.not(hiddenExpr(db, eb, "i.repo", "i.number", "i.labels")))
    .$narrowType<{ merged_at: string }>());
  const reviews = async (r: string): Promise<number> => (await db.get(db.k.selectFrom("main.review_posts as rp")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "rp.repo").onRef("i.number", "=", "rp.number"))
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("rp.repo", "=", r).where("rp.posted_at", ">=", since7)
    .where((eb) => eb.not(hiddenExpr(db, eb, "i.repo", "i.number", "i.labels")))))!.n;
  const hours: number[] = [];
  for (const r of repos) {
    out.openIssues += await open(r, "issue");
    out.openPrs += await open(r, "pr");
    for (const m of await merged(r)) {
      const dur = m.created_at ? Date.parse(m.merged_at) - Date.parse(m.created_at) : NaN;
      if (dur >= 0) hours.push(dur / 3_600_000);
      if (m.merged_at >= since7) {
        out.mergedLast7Days++;
        if (m.ours) out.mergedByAutoCraftLast7Days++;
      }
    }
    out.reviewsPostedLast7Days += await reviews(r);
    out.queueLength += (await queueOf(db, r)).length;
  }
  if (hours.length) {
    hours.sort((a, b) => a - b);
    const mid = hours.length >> 1;
    out.medianOpenToMergeHours30Days = Math.round((hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2) * 10) / 10;
  }
  return out;
}


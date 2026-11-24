// GET /api/maintain/home: the new Home's read (behind each user's `ui_v2` switch). Items come from the live workflow rows
// (src/workflow/store.ts) of the repos the reader may see, narrowed to the picked project. An item needs an answer when its
// recommendation is open or its last answer was unclear; it counts for the reader only where they may act on the repo
// (mayRunRepo: operators on every repo, maintainers where GitHub grants write). Text is built by src/workflow/status.ts.
import type { MaintainQueueMeta, MaintainHome, MaintainRow, MaintainRunnerLine, MaintainStats } from "../../../web/src/api/types.ts";
import { t } from "../../i18n/index.ts";
import { listHelpers } from "../../remote/helpers.ts";
import { inferenceMode } from "../../remote/mode.ts";
import { readyRunners } from "../../remote/queue-view.ts";
import { stateLine, weightLabel } from "../../workflow/status.ts";
import { liveWorkflows, repoWorkflows } from "../../workflow/store.ts";
import type { ItemWorkflow } from "../../workflow/types.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Req } from "../types.ts";
import { problems } from "./home.ts";
import { stopped } from "./needs.ts";
import { canSeeInternals } from "./staff.ts";
import { excludeHiddenExpr, hiddenRepos, visibleRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";
import { inList, refIn } from "../../db/kx.ts";
import type { Eb } from "../../db/kx.ts";
import { latestCteExpr, trackedExpr } from "./stats.ts";

/** Workflow ids whose latest event is an unclear answer. */
async function unclear(db: Db, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db.all(db.k.selectFrom("main.workflow_events").select(["workflow_id", "kind"]).where(inList(db, "workflow_id", ids)).orderBy("id"));
  const last = new Map<number, string>();
  for (const r of rows) if (r.workflow_id !== null) last.set(r.workflow_id, r.kind);
  return new Set([...last].filter(([, kind]) => kind === "ambiguous").map(([id]) => id));
}

async function rowsOf(db: Db, wfs: ItemWorkflow[]): Promise<MaintainRow[]> {
  if (!wfs.length) return [];
  const [unclearIds, items] = await Promise.all([
    unclear(db, wfs.map((w) => w.id)),
    db.all(db.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.title", "i.author"]).where(refIn(db, "i", wfs.map((w) => [w.repo, w.number] as const)))),
  ]);
  const byRef = new Map(items.map((i) => [`${i.repo}#${i.number}`, i]));
  return wfs.map((w) => {
    const it = byRef.get(`${w.repo}#${w.number}`);
    const isUnclear = unclearIds.has(w.id);
    const open = w.state === "recommending" && w.rec !== null;
    return {
      repo: w.repo, number: w.number, kind: w.kind, title: it?.title ?? `${w.repo}#${w.number}`, author: it?.author ?? null, entry: w.entry,
      line: isUnclear ? t("Waiting for a clear answer") : open ? w.rec!.text : stateLine(w),
      waits: open || isUnclear, blocked: w.state === "blocked", weight: weightLabel(w.weight),
      startedBy: w.startedBy, approvedBy: w.approvedBy, stoppedBy: w.stoppedBy, updatedAt: w.updatedAt,
    };
  });
}

async function runnerLine(db: Db, login: string): Promise<MaintainRunnerLine> {
  const now = Date.now();
  const [mine, ready] = await Promise.all([listHelpers(db, login, now), readyRunners(db, now)]);
  const me = login.toLowerCase();
  return {
    mine: mine.map((h) => ({ name: h.label ?? t("Task Runner"), online: h.fresh, running: h.busy ?? 0 })),
    others: ready.filter((r) => r.login.toLowerCase() !== me && !r.manual).length,
  };
}

export async function home(db: Db, req: Req): Promise<MaintainHome> {
  const visible = new Set(await visibleRepos(db, req));
  const live = (await liveWorkflows(db)).filter((w) => visible.has(w.repo));
  const repos = [...new Set(live.map((w) => w.repo))];
  const may = req.user.role === "viewer" ? [] : await Promise.all(repos.map((r) => mayRunRepo(req.user, r)));
  const acting = new Set(repos.filter((_, i) => may[i]));
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const [rows, attention, runner] = await Promise.all([
    rowsOf(db, live),
    stopped(db, hidden, req.user).then((stops) => problems(db, hidden, staff, stops)),
    staff && await inferenceMode(db) === "user-local" ? runnerLine(db, req.user.login) : null,
  ]);
  // Most recently moved first.
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  if (req.user.role === "viewer") return { needs: [], mine: [], waiting: rows.filter((r) => r.waits), running: rows.filter((r) => !r.waits), runner: null, attention };
  const needs = rows.filter((r) => r.waits && acting.has(r.repo));
  const me = req.user.login.toLowerCase();
  const byMe = (l: string | null) => l !== null && l.toLowerCase() === me;
  const mine = rows.filter((r) => !needs.includes(r) && (byMe(r.startedBy) || byMe(r.approvedBy) || byMe(r.stoppedBy)));
  return { needs, mine, waiting: [], running: [], runner, attention };
}

/**
 * What the new Work queue page needs beyond the classic reads: the visible repos on the new workflow (their holds go through
 * the workflow controls, the others through the classic routes) and who approved each started item for merge.
 */
export async function queueMeta(db: Db, req: Req): Promise<MaintainQueueMeta> {
  const visible = new Set(await visibleRepos(db, req));
  const newRepos = (await repoWorkflows(db)).filter((r) => r.workflow === "new" && visible.has(r.repo)).map((r) => r.repo);
  const live = (await liveWorkflows(db)).filter((w) => visible.has(w.repo) && w.approvedBy !== null);
  return { newRepos, approvedBy: Object.fromEntries(live.map((w) => [`${w.repo}#${w.number}`, w.approvedBy!])) };
}

const DAY = 86400_000;

/** Headline numbers and merges per day for the last 7 or 30 days (UTC days, today last), over the repos the reader sees. */
export async function stats(db: Db, req: Req): Promise<MaintainStats> {
  const days = req.query.get("period") === "30d" ? 30 : 7;
  const hidden = await hiddenRepos(db, req);
  const today = new Date().toISOString().slice(0, 10);
  const labels = Array.from({ length: days }, (_, i) => new Date(Date.parse(today) - (days - 1 - i) * DAY).toISOString().slice(0, 10));
  const from = labels[0]!;
  const hideItems = (col: string) => excludeHiddenExpr(db, col, hidden);
  const day = (eb: Eb, col: string) => eb.fn<string>("substr", [col, eb.lit(1), eb.lit(10)]);
  const closed = await db.all(latestCteExpr(db).selectFrom("main.items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .select((eb) => [day(eb, "i.closed_at").as("d"), "i.state", "l.stage", "i.kind"])
    .where("i.closed_at", ">=", from).where("i.state", "<>", "OPEN")
    .where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))
    .$narrowType<{ d: string }>());
  const perDay = new Map(labels.map((d) => [d, 0]));
  let merged = 0, implemented = 0, closedN = 0;
  for (const r of closed) {
    closedN++;
    if (r.state === "MERGED") {
      merged++;
      if (perDay.has(r.d)) perDay.set(r.d, perDay.get(r.d)! + 1);
    } else if (r.stage === "fixed-by-us" && r.kind === "issue") implemented++;
  }
  const created = (await db.get(db.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.created_at", ">=", from).where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))))!.n;
  const backlog = (await db.get(db.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.state", "=", "OPEN").where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))))!.n;
  const reviewed = (await db.all(db.k.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number"]).distinct()
    .where("o.at", ">=", from).where((eb) => hideItems("o.repo") ?? eb.lit(true)))).length;
  const hideUsage = hideItems("repo");
  const spend = (await db.get(db.k.selectFrom("token_usage").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("s"))
    .where((eb) => eb(day(eb, eb.fn.coalesce("ended_at", "started_at") as never), ">=", from))
    .$if(!!hideUsage, (q) => q.where((eb) => eb.or([eb("repo", "is", null), hideUsage!])))))!.s;
  return { period: days === 30 ? "30d" : "7d", merged, implemented, reviewed, backlog, backlogChange: created - closedN, spend: Math.round(spend), perDay: labels.map((d) => ({ day: d, n: perDay.get(d)! })) };
}

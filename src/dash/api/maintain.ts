// GET /api/maintain/home: the new Home's read (behind each user's `ui_v2` switch). Items come from the live workflow rows
// (src/workflow/store.ts) of the repos the reader may see, narrowed to the picked project. An item needs an answer when its
// recommendation is open or its last answer was unclear; it counts for the reader only where they may act on the repo
// (mayRunRepo: operators on every repo, maintainers where GitHub grants write). Text is built by src/workflow/status.ts.
import type { MaintainHome, MaintainRepo, MaintainRow, MaintainRunnerLine } from "../../../web/src/api/types.ts";
import { t } from "../../i18n/index.ts";
import { listHelpers } from "../../remote/helpers.ts";
import { inferenceMode } from "../../remote/mode.ts";
import { readyRunners } from "../../remote/queue-view.ts";
import { stateLine, weightLabel } from "../../workflow/status.ts";
import { liveWorkflows } from "../../workflow/store.ts";
import type { ItemWorkflow } from "../../workflow/types.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Req } from "../types.ts";
import { problems } from "./home.ts";
import { stopped } from "./needs.ts";
import { canSeeInternals } from "./staff.ts";
import { allVisibleRepos, blankIfHidden, hiddenRepos, visibleRepos } from "./visible.ts";
import { stepTitle } from "./trace.ts";
import { mayResumeTrip } from "../../push-outcomes.ts";
import { parseTripKey } from "../../core/push-outcome.ts";
import type { Db } from "../../db/index.ts";
import { inList, refIn } from "../../db/kx.ts";

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

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** GET /api/maintain/repos: the Repos page, for every role. Counts and switches are the reader's visible tracked repos; only who may act differs. */
export async function repos(db: Db, req: Req): Promise<MaintainRepo[]> {
  const names = await allVisibleRepos(db, req);
  if (!names.length) return [];
  const hidden = await hiddenRepos(db, req);
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const [rows, open, merged, live, trips] = await Promise.all([
    db.all(db.k.selectFrom("main.tracked_repos").select(["name", "pipeline", "workflow"]).where("name", "in", names)),
    db.all(db.k.selectFrom("main.items").select((eb) => ["repo", eb.fn.countAll<number>().as("n")]).where("state", "=", "open").where("repo", "in", names).groupBy("repo")),
    db.all(db.k.selectFrom("main.items").select((eb) => ["repo", eb.fn.countAll<number>().as("n")]).where("merged_at", ">=", since).where("repo", "in", names).groupBy("repo")),
    liveWorkflows(db),
    db.all(db.k.selectFrom("stage_trips").select(["stage", "reason", "tripped_at"]).where("active", "=", 1).orderBy("tripped_at")),
  ]);
  const count = (xs: { repo: string; n: number }[], repo: string) => Number(xs.find((x) => x.repo === repo)?.n ?? 0);
  const out: MaintainRepo[] = [];
  for (const r of rows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const mine = live.filter((w) => w.repo === r.name);
    const stops: MaintainRepo["trips"] = [];
    for (const t of trips) {
      const k = parseTripKey(t.stage);
      if (k?.repo !== r.name) continue;
      stops.push({ key: t.stage, text: `${stepTitle(k.stage)}: ${blankIfHidden(t.reason, hidden)}`, since: t.tripped_at, canResume: await mayResumeTrip(req.user, t.stage) });
    }
    out.push({
      name: r.name, workflow: r.workflow === "new" ? "new" : "legacy", automatic: !!r.pipeline, canRun: await mayRunRepo(req.user, r.name),
      open: count(open, r.name), started: mine.length, waiting: mine.filter((w) => w.state === "recommending" && w.rec !== null).length, mergedWeek: count(merged, r.name), trips: stops,
    });
  }
  return out;
}

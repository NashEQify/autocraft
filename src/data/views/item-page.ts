// reads: (none; composes loaders)
// The item page's data and its stamp. Wave 1: the trace's sources (with the item's files, checks and read time), the tracked repo, the
// merge legs, the workflow history, the jobs of the item, the screenshot runs, the conversation thread, the held follow-ups and the
// implementation attempt. Wave 2: what the first wave's keys name (the build of the head, queue positions of queued jobs, the held
// issues' audit rows, the implementation's calls, workspaces and PR, the screenshot images' names).
import type { Db } from "../../db/index.ts";
import { loadHeldIssueAudits, loadTrackedRepos } from "../control/index.ts";
import type { TrackedRepo } from "../control/types.ts";
import { loadArtifacts } from "../build/index.ts";
import type { ArtifactRow } from "../build/types.ts";
import { loadHeld, loadThreads } from "../conversations/index.ts";
import type { HeldRow, Thread } from "../conversations/types.ts";
import { loadImplementStamps, loadImplementationView } from "../implement/index.ts";
import { loadActiveJobsOfItems, loadFailedJobsOfItems, loadJobStamp, loadQueuePositions } from "../jobs/index.ts";
import type { ActiveJob, FailedJob } from "../jobs/types.ts";
import { loadPrBuildViews, loadScreenshotRuns } from "../merge/index.ts";
import type { PrBuildView, ScreenshotRun } from "../merge/types.ts";
import { loadItemDetail, loadShown } from "../mirror/index.ts";
import type { ItemShown } from "../mirror/types.ts";
import { loadLegs, loadWorkflowHistory } from "../workflow/index.ts";
import type { ItemWorkflow, Preapproval } from "../workflow/types.ts";
import { completeImplementation, type ImplementationFacts } from "./item-implementation.ts";
import { loadItemTrace, loadItemTraceStamp, type ItemTraceRows, type TraceScope, type WriteActions } from "./trace.ts";

/** Failed jobs older than this do not show on the item. */
export const FAILED_JOBS_DAYS = 30;

export type ItemPageFacts = {
  trace: ItemTraceRows; tracked: TrackedRepo | null; legs: Preapproval[]; workflow: ItemWorkflow[];
  failedJobs: FailedJob[]; activeJobs: ActiveJob[]; positions: Map<number, number>;
  prBuild: PrBuildView | null; screenshots: ScreenshotRun[]; screenshotArtifacts: Map<number, ArtifactRow[]>;
  thread: Thread | null; held: HeldRow[]; heldAudits: Map<number, { number: number; url: string }>;
  implementation: ImplementationFacts | null; implementationPr: ItemShown | null;
};

/** `staff` reads the conversation thread, as the page's story shows it to them only. */
export async function loadItemPage(db: Db, scope: TraceScope, ref: { repo: string; number: number }, writeActions: WriteActions): Promise<ItemPageFacts> {
  const key = `${ref.repo}#${ref.number}`;
  const refs = [ref];
  const since = new Date(Date.now() - FAILED_JOBS_DAYS * 86_400_000).toISOString();
  const [trace, tracked, legs, workflow, failedJobs, activeJobs, screenshots, thread, held, view] = await db.together(() => Promise.all([
    loadItemTrace(db, scope, ref, writeActions, ["item", "comments", "activity", "commits", "files", "checks", "read"]),
    loadTrackedRepos(db, [ref.repo]), loadLegs(db, refs), loadWorkflowHistory(db, refs), loadFailedJobsOfItems(db, refs, since), loadActiveJobsOfItems(db, refs),
    loadScreenshotRuns(db, refs), scope.staff ? loadThreads(db, [key]) : Promise.resolve(new Map<string, Thread>()), loadHeld(db, [key]), loadImplementationView(db, key),
  ]));
  const head = trace.detail.item?.head_oid ?? null;
  const shots = [...screenshots.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const newestShot = shots[shots.length - 1];
  const heldRows = held.get(key) ?? [];
  const shotTasks = [...new Set([newestShot?.baseTaskId, newestShot?.headTaskId].filter((x): x is number => typeof x === "number"))];
  const queued = activeJobs.get(key)?.filter((j) => j.state === "queued").map((j) => j.id) ?? [];
  const [builds, positions, heldAudits, artifacts, implementation, implementationPr] = await db.together(() => Promise.all([
    trace.detail.item?.kind === "pr" ? loadPrBuildViews(db, [{ ref: key, head }]) : Promise.resolve(new Map<string, PrBuildView>()),
    loadQueuePositions(db, queued), loadHeldIssueAudits(db, heldRows.filter((h) => h.state === "filing").map((h) => h.id)),
    loadArtifacts(db, shotTasks, { contentType: "image/png" }),
    view ? completeImplementation(db, ref, view, trace.detail.comments) : Promise.resolve(null),
    view?.impl.prNumber != null ? loadShown(db, [{ repo: ref.repo, number: view.impl.prNumber }]) : Promise.resolve(new Map<string, ItemShown>()),
  ]));
  return {
    trace, tracked: tracked.get(ref.repo) ?? null, legs: legs.get(key) ?? [], workflow: workflow.get(key) ?? [], failedJobs: failedJobs.get(key) ?? [], activeJobs: activeJobs.get(key) ?? [], positions,
    prBuild: builds.get(key) ?? null, screenshots: shots, screenshotArtifacts: artifacts, thread: thread.get(key) ?? null, held: heldRows, heldAudits, implementation,
    implementationPr: view?.impl.prNumber != null ? implementationPr.get(`${ref.repo}#${view.impl.prNumber}`) ?? null : null,
  };
}

/** The trace's stamp plus the page's own sources, as plain values to hash. */
export async function loadItemStamp(db: Db, scope: TraceScope, ref: { repo: string; number: number }): Promise<unknown[]> {
  const key = `${ref.repo}#${ref.number}`;
  const refs = [ref];
  const [trace, tracked, legs, impl, screenshots, jobs, detail] = await db.together(() => Promise.all([
    loadItemTraceStamp(db, scope, ref), loadTrackedRepos(db, [ref.repo]), loadLegs(db, refs), loadImplementStamps(db, refs), loadScreenshotRuns(db, refs), loadJobStamp(db, ref.repo, refs),
    loadItemDetail(db, key, ["item", "files", "checks", "read"]),
  ]));
  const head = (detail.item?.head_oid ?? null) as string | null;
  const builds = detail.item?.kind === "pr" ? await loadPrBuildViews(db, [{ ref: key, head }]) : new Map<string, PrBuildView>();
  return [
    ...trace, tracked.get(ref.repo)?.pipeline ?? null, (legs.get(key) ?? []).map((l) => [l.id, l.state, l.updated_at]), impl.get(key) ?? null,
    [...screenshots.values()].map((s) => [s.headSha, s.state, s.verdict ?? "", s.held]), [jobs.count, jobs.newestId, jobs.states, [...jobs.positions.values()]],
    detail.item && [detail.item.title, detail.item.labels, detail.item.additions, detail.item.deletions, detail.item.url, detail.item.ci_state, detail.item.mergeable, detail.item.closing_issues],
    detail.checks && [detail.checks.head_oid, detail.checks.fetched_at, detail.checks.checks], detail.files.map((f) => [f.path, f.additions, f.deletions]), detail.read, builds.get(key) ?? null,
  ];
}


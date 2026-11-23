// The item page: one GET with everything the two-sided page draws (status, header, Opus reviews, result cards, AutoCraft's history and
// the GitHub side). Built from the item API (`itemCore`), the item trace and the write records. Redaction follows the helpers it reuses:
// viewers get no review text, card details or job errors; a quiet pull request is veiled by the trace context; costs stay visible.
import { filtered, isHiddenRepo } from "../../hidden-sql.ts";
import { prBuildView } from "../../prbuild/view.ts";
import { createHash } from "node:crypto";
import type { CiState, TimelineEntry, DiscordInfo, ItemBar, ItemImplementation, ItemKind, ItemPrBuild, ItemRef, ItemReleases, ItemState, Preapproval, QueueSlot, RepoName, ScreenshotRun, Tier } from "../../../web/src/api/types.ts";
import { statusFromItem, type ItemStatus } from "../../core/item-status.ts";
import { triggerWhy } from "../../review/trigger.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { fingerprint, rowValuesOf, context, gather, obj, arr, type Ctx, type Ev, hiddenExpr } from "./trace.ts";
import { timelineOf } from "./item-timeline.ts";
import { implementationData, implementationView } from "./item-implementation.ts";
import { barOf } from "./item-bar.ts";
import { discordOf } from "./discord.ts";
import { itemCore } from "./index.ts";
import { pushedCommits, writesOf, MATCH_WINDOW_MS, type WriteRow } from "./github-writes.ts";
import { actionsOf as releasesOf } from "../../operator-actions.ts";
import { preapprovalOf, preapprovalsOf } from "../../preapproval/index.ts";
import { queueSlots } from "../../rank/position.ts";
import { visibleRepos } from "./visible.ts";
import { itemReader, statusFor } from "./reader.ts";
import type { Req } from "../types.ts";
import { backlogHeld } from "../../dupes/held.ts";
import { canSettleCached } from "../../settlers.ts";
import type { Db } from "../../db/index.ts";
import { cols, exprOf, groupConcat, jsonNum, least, rowid, type Eb } from "../../db/kx.ts";

export type ItemPhase = ItemStatus["phase"];
export type { ItemStatus };

export type ReviewTrigger = "new-head" | "discussion" | "operator" | "base" | "model-change";
export type ReviewVerdict = "take" | "take-fix" | "hold" | "close";
export interface OpusReviewEntry {
  id: string; head: string; current: boolean; at: string; trigger: ReviewTrigger; why: string; verdict: ReviewVerdict; sure: boolean;
  summary: string; fixes: string[]; risks: string[]; claims: { path: string; line: number; text: string }[]; blockedBy: ItemRef[]; costUsd: number;
}
export interface ReviewHistory { latest: OpusReviewEntry | null; earlier: OpusReviewEntry[] }
export interface GithubEvent {
  id: string; type: "opened" | "comment" | "review" | "label" | "push" | "merged" | "closed"; at: string; actor: string; body: string | null;
  autocraft: { as: string; historyId: string } | null;
}
export interface GithubSide {
  description: string; events: GithubEvent[]; checks: { name: string; state: CiState }[];
  commits: { sha: string; message: string; author: string; at: string; byAutoCraft: boolean }[];
  files: { path: string; additions: number; deletions: number }[]; url: string;
  /** When AutoCraft last read the item from GitHub (poll or webhook re-read); null before the first read since this was recorded. */
  syncedAt: string | null;
}
export interface ItemPageHeader {
  labels: string[]; assignees: string[]; autocraftAssigned: boolean; pipelineOn: boolean; discord: DiscordInfo | null; queue: QueueSlot | null;
  fastTracked: boolean; held: boolean; preapproval: Preapproval | null; releases: ItemReleases; tier: Tier; size: "S" | "M" | "L" | "XL" | null;
  /** `held`: a Backlog answer holds the item; `canSettle`: the viewer may put it on the Backlog. */
  backlog: { held: boolean; canSettle: boolean };
}
export interface ItemPageData {
  repo: RepoName; number: number; kind: ItemKind; state: ItemState; title: string; author: string; stamp: string; header: ItemPageHeader;
  status: ItemStatus; bar: ItemBar; costUsd: number; reviews: ReviewHistory; timeline: TimelineEntry[]; github: GithubSide;
  /** PRs: our own build of the newest head; null when the pr-builds switch is off or there is none. */
  prBuild: ItemPrBuild | null;
  /** The screenshot run of the PR's latest head, for staff; empty when there is none. */
  screenshots: ScreenshotRun[];
  /** Issues: the current or newest ended implementation attempt. */
  implementation: ItemImplementation | null;
}
export type ItemPageUnchanged = { unchanged: true; stamp: string };

type Json = Record<string, any>;
type Item = Awaited<ReturnType<typeof itemCore>>;

const short = (s: string | null | undefined): string => (s ?? "").slice(0, 7);

/** Comment text from GitHub, cleaned for display: no HTML comments or tags, cut at `max` characters. */
const clean = (s: string, max = 1500): string => {
  const t = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

// ---- stamp ---------------------------------------------------------------------------------------------------------

/** What the page reads beyond the trace's fingerprint: header parts, comment edits, commits, checks, files and the plan view. */
const extraQueries = (db: Db, repo: string, n: number) => {
  const flag = (eb: Eb, col: string) => eb.fn.sum<number | null>(eb.case().when(col, "is not", null).then(eb.lit(1)).else(eb.lit(0)).end());
  const length = (eb: Eb, col: string) => eb.fn<number>("length", [eb.fn.coalesce(col, eb.val(""))]);
  const queued = (eb: Eb, j: string) => eb(jsonNum(db, `${j}.params`, "$.number"), "=", n);
  return [
    db.k.selectFrom("items").select((eb) => ["title", "labels", length(eb, "body").as("body_length"), "ci_state", "mergeable", "additions", "deletions", "url", "closing_issues"])
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("item_reads").select("synced_at").where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("item_plans").select("view").where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("comments").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.sum<number | null>(length(eb, "body")).as("length"), flag(eb, "url").as("urls"),
      groupConcat(db, eb.fn.coalesce("review_state", eb.val("")), ",", rowid("comments")).as("states")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("pr_commits").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("first_seen_at").as("newest"), eb.fn.sum<number | null>(length(eb, "message")).as("length")])
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("pr_checks").select(["head_oid", "fetched_at", "checks"]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("pr_files").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.sum<number | null>(eb("additions", "+", eb.ref("deletions"))).as("lines")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("item_activity").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("at").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("classifications").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("at").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("postmerge_followups").select(groupConcat(db, "state", ",", rowid("postmerge_followups")).as("states")).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("preapprovals").select(["id", "state", "updated_at"]).where("repo", "=", repo).where("number", "=", n).orderBy("id", "desc").limit(1),
    db.k.selectFrom("fast_track").select("id").where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("screenshot_runs").select((eb) => groupConcat(db, eb(eb(eb("head_sha", "||", eb.ref("state")), "||", eb.fn.coalesce("verdict", eb.val(""))), "||", exprOf(eb, "held")), ",", "head_sha").as("states"))
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("tracked_repos").select("pipeline").where("name", "=", repo),
    db.k.selectFrom("implementations").select(["id", "state", "updated_at"]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("implementation_rounds as r").innerJoin("implementations as m", "m.id", "r.implementation_id")
      .select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("r.id").as("newest"), eb.fn.sum<number | null>(length(eb, "r.result")).as("length")])
      .where("m.repo", "=", repo).where("m.number", "=", n),
    db.k.selectFrom("jobs").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest"), groupConcat(db, "state", ",", "id").as("states")])
      .where("state", "in", ["queued", "running"]).where("repo", "=", repo).where((eb) => queued(eb, "jobs")),
    db.k.selectFrom("jobs as j").select((eb) => groupConcat(db, eb.selectFrom("jobs as q").select((e) => e.fn.countAll<number>().as("n"))
      .where("q.state", "=", "queued").whereRef("q.step", "=", "j.step").whereRef("q.id", "<", "j.id"), ",", "j.id").as("ahead"))
      .where("j.state", "=", "queued").where("j.repo", "=", repo).where((eb) => queued(eb, "j")),
  ];
};

const prBuildOf = async (c: Ctx): Promise<ItemPrBuild | null> => {
  const r = await c.db.get(c.db.k.selectFrom("items").select(["kind", "head_oid"]).where("repo", "=", c.repo).where("number", "=", c.n));
  return r?.kind === "pr" ? await prBuildView(c.db, c.repo, c.n, r.head_oid, c.staff) : null;
};

async function stampOf(c: Ctx, req: Req): Promise<string> {
  const { db, repo, n, ref } = c;
  const [print, extra, slots, discord, releases, prBuild, backlog] = await Promise.all([fingerprint(c, "page"), rowValuesOf(db, extraQueries(db, repo, n)),
    visibleRepos(db, req).then((v) => queueSlots(db, v)), discordOf(db, repo, n), releasesOf(db, repo, n), prBuildOf(c), backlogOf(c, req)]);
  const parts: unknown[] = [print, c.veiled, ...extra, slots.get(ref) ?? null, discord, releases, prBuild, backlog];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

// ---- header and status -----------------------------------------------------------------------------------------------

const backlogOf = async (c: Ctx, req: Req): Promise<ItemPageHeader["backlog"]> => {
  const [held, canSettle] = await Promise.all([backlogHeld(c.db, c.repo, c.n), canSettleCached(c.db, req.user.login, req.user.role, [c.repo])]);
  return { held, canSettle };
};

async function headerOf(c: Ctx, it: Item, queue: QueueSlot | null, req: Req): Promise<ItemPageHeader> {
  const { db, repo, n } = c;
  const lines = it.additions + it.deletions;
  const [row, fast, hold, backlog] = await Promise.all([
    db.get(db.k.selectFrom("items").select("assignees").where("repo", "=", repo).where("number", "=", n)),
    db.get(db.k.selectFrom("main.fast_track").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n)),
    db.get(db.k.selectFrom("main.merge_holds").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n)),
    backlogOf(c, req),
  ]);
  const assignees = arr<string>(row!.assignees).filter((x) => typeof x === "string");
  const pre = it.kind === "pr" ? (it as { preapproval?: Preapproval | null }).preapproval ?? null : null;
  return {
    labels: it.labels, assignees,
    autocraftAssigned: c.box !== "" && assignees.includes(c.box), pipelineOn: it.pipelineOn === true, discord: it.discord ?? null, queue,
    fastTracked: fast !== undefined,
    held: hold !== undefined,
    preapproval: pre, releases: it.releases, tier: it.tier,
    size: it.kind !== "pr" ? null : lines < 50 ? "S" : lines < 300 ? "M" : lines < 1000 ? "L" : "XL",
    backlog,
  };
}

async function statusOf(c: Ctx, it: Item): Promise<ItemStatus> {
  const row = await c.db.get(c.db.k.selectFrom("item_plans").select("view").where("repo", "=", c.repo).where("number", "=", c.n));
  const stored = obj(row?.view).status as Partial<ItemStatus> | undefined;
  const since = it.mergedAt ?? it.closedAt ?? it.updatedAt ?? it.createdAt;
  const s = stored && typeof stored.phase === "string" ? ({ waiting: null, next: null, since, ...stored } as ItemStatus) : statusFromItem({ merged_at: it.mergedAt, closed_at: it.closedAt }, since);
  // A quiet pull request shows its viewers the phase only: the wait and next step quote the planner's reasons. A wait naming a hidden repo's item does not name it.
  return statusFor(itemReader(c), c.repo, c.n, s);
}

// ---- Opus reviews ------------------------------------------------------------------------------------------------------

const VERDICTS = new Set<string>(["take", "take-fix", "hold", "close"]);
type ReviewRow = { key: string; head_oid: string; at: string; model: string | null; verdict: string | null; sure: number | null; reason: string | null; summary: string | null; risks: string | null; fixes: string | null; claims: string | null; blocked_by: string | null; trigger: string | null };

async function reviewsOf(c: Ctx, headNow: string | null, events: Ev[]): Promise<ReviewHistory> {
  const { db, repo, n } = c;
  const [history, latest] = await Promise.all([
    db.all(db.k.selectFrom("opus_review_history")
      .select([rowid("opus_review_history").as("rowid"), "head_oid", "at", "model", "verdict", "sure", "reason", "summary", "risks", "fixes", "claims", "blocked_by", "trigger"])
      .where("repo", "=", repo).where("number", "=", n).where("verdict", "is not", null)),
    db.all(db.k.selectFrom("opus_reviews").select(["head_oid", "at", "model", "verdict", "sure", "reason", "risks", "fixes", "claims"])
      .where("repo", "=", repo).where("number", "=", n).where("verdict", "is not", null).orderBy("head_oid")),
  ]);
  const rows: (ReviewRow & { rowid: number })[] = history.map((r) => ({ ...r, key: `opus:${r.rowid}` }));
  // Reviews stored before the history table existed.
  const seen = new Set(rows.map((r) => `${r.head_oid}|${r.at}`));
  for (const r of latest)
    if (!seen.has(`${r.head_oid}|${r.at}`)) rows.push({ ...r, key: `opus-latest:${r.head_oid}`, summary: null, blocked_by: null, trigger: null, rowid: 0 });
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.rowid - a.rowid));
  const costs = new Map(events.filter((e) => e.kind === "review").map((e) => [e.id, e.costUsd ?? 0]));
  const staff = c.staff;
  const all = rows.map((r, i): OpusReviewEntry => {
    const older = rows[i + 1];
    // Rows from before the trigger was stored: the same head as the review before means the discussion moved.
    const trigger = (r.trigger && ["new-head", "discussion", "operator", "base"].includes(r.trigger) ? r.trigger : older && older.head_oid === r.head_oid ? "discussion" : "new-head") as ReviewTrigger;
    const fixes = arr<unknown>(r.fixes).map((f) => (typeof f === "string" ? f : `${(f as Json).file}: ${(f as Json).change}`));
    const claims = arr<Json>(r.claims).map((cl) => {
      // Claims are { claim, status, evidence }; the file and line sit in the evidence text.
      const m = /([\w./-]+\.\w+):(\d+)/.exec(String(cl.evidence ?? cl.claim ?? ""));
      return { path: m?.[1] ?? "", line: m ? Number(m[2]) : 0, text: String(cl.claim ?? cl.text ?? "") };
    }).filter((cl) => cl.text);
    return {
      id: r.key, head: short(r.head_oid), current: r.head_oid === headNow, at: r.at, trigger, why: staff ? triggerWhy(r.trigger, !older) ?? (older ? (trigger === "discussion" ? "New discussion since the last review" : "New commits since the last review") : "First review") : "",
      verdict: (VERDICTS.has(r.verdict ?? "") ? r.verdict : "hold") as ReviewVerdict, sure: r.sure === 1,
      summary: staff ? r.summary || r.reason || "" : "", fixes: staff ? fixes : [], risks: staff ? arr<string>(r.risks) : [], claims: staff ? claims : [],
      // Stored as "repo#n" strings.
      blockedBy: arr<unknown>(r.blocked_by).flatMap((b): ItemRef[] => {
        const m = typeof b === "string" ? /^([\w.-]+)#(\d+)$/.exec(b) : null;
        return m && !isHiddenRepo(c.hidden, m[1]!) ? [{ repo: m[1]!, number: Number(m[2]) }] : [];
      }),
      costUsd: costs.get(`review:${r.key}`) ?? 0,
    };
  });
  return { latest: all[0] ?? null, earlier: all.slice(1) };
}

// ---- GitHub side ---------------------------------------------------------------------------------------------------------

const IDENTITY: Record<string, string> = { legacy: "box account", app: "GitHub App" };
const asOf = (w: WriteRow | undefined): string => IDENTITY[w?.identity ?? "legacy"] ?? w?.identity ?? "box account";
const writeType = (action: string): GithubEvent["type"] =>
  action === "merge" ? "merged" : /-push$/.test(action) ? "push" : /^(labels-apply|act-unlabel|assign|unassign|label-create)$/.test(action) ? "label" : /^review-/.test(action) ? "review" : /close/.test(action) ? "closed" : "comment";

async function githubOf(c: Ctx, it: Item, ev: Ev[], url: string, syncedAt: string | null): Promise<GithubSide> {
  const { db, repo, n } = c;
  const events: GithubEvent[] = [];
  // The GitHub side's reads do not depend on each other, so they run together.
  const [allWrites, comments, acts, pushed, commitRows] = await Promise.all([
    writesOf(db, repo, n),
    db.all(db.k.selectFrom("comments").select(["id", "kind", "author", "created_at", "body", "review_state"]).where("repo", "=", repo).where("number", "=", n)
      .where("created_at", "is not", null).$narrowType<{ created_at: string }>()
      .where((eb) => eb.not(eb.and([eb("kind", "=", "review"), eb(eb.fn.coalesce(eb.fn<string | null>("trim", ["body"]), eb.val("")), "=", "")])))),
    db.all(db.k.selectFrom("item_activity").select(["id", "kind", "at", "actor", "label", "before_oid", "after_oid"]).where("repo", "=", repo).where("number", "=", n).orderBy("id")),
    pushedCommits(db, repo, n),
    db.all(db.k.selectFrom("pr_commits")
      .select((eb) => ["oid", "message", "author", least<string>(db, ["committed_at", eb.fn.coalesce("first_seen_at", "committed_at")], "text").as("at")])
      .$narrowType<{ at: string }>().where("repo", "=", repo).where("number", "=", n).orderBy("at").orderBy("oid")),
  ]);
  const writes = allWrites.filter((w) => w.state !== "failed");
  const summaryOf = new Map(ev.filter((e) => e.kind === "write").map((e) => [e.id, e.summary]));
  const byComment = new Map(writes.filter((w) => w.comment).map((w) => [w.comment!.id, w]));
  const used = new Set<number>();
  const own = c.own;
  if (it.createdAt) events.push({ id: "gh:opened", type: "opened", at: it.createdAt, actor: it.author, body: clean(it.body, 1500), autocraft: null });
  for (const m of comments) {
    const w = byComment.get(m.id);
    const ours = !!w || (!!m.author && own.has(m.author));
    if (w) used.add(w.rowid);
    events.push({
      id: `comment:${m.id}`, type: m.kind === "review" ? "review" : "comment", at: m.created_at, actor: ours ? "autocraft" : m.author ?? "unknown",
      body: clean(m.body ?? ""), autocraft: ours ? { as: asOf(w), historyId: w ? `audit:${w.rowid}` : `comment:${m.id}` } : null,
    });
  }
  const labelWrites = writes.filter((w) => w.action === "labels-apply" || w.action === "act-unlabel");
  for (const a of acts) {
    const ours = !!a.actor && own.has(a.actor);
    const w = ours && a.kind !== "force-push" ? labelWrites.find((x) => Math.abs(Date.parse(x.at) - Date.parse(a.at)) <= MATCH_WINDOW_MS) : undefined;
    if (w) used.add(w.rowid);
    events.push({
      id: `activity:${a.id}`, type: a.kind === "force-push" ? "push" : "label", at: a.at, actor: ours ? "autocraft" : a.actor ?? "unknown",
      body: a.kind === "force-push" ? `Force-pushed ${short(a.before_oid)} → ${short(a.after_oid)}` : `${a.kind === "labeled" ? "Added" : "Removed"} label ${a.label ?? ""}`,
      autocraft: ours ? { as: asOf(w), historyId: w ? `audit:${w.rowid}` : `activity:${a.id}` } : null,
    });
  }
  const merged = writes.find((w) => w.action === "merge");
  if (it.mergedAt && !merged) events.push({ id: "gh:merged", type: "merged", at: it.mergedAt, actor: it.mergedBy ?? "unknown", body: null, autocraft: null });
  else if (it.closedAt && !it.mergedAt) events.push({ id: "gh:closed", type: "closed", at: it.closedAt, actor: "unknown", body: null, autocraft: null });
  // Writes without a mirrored comment or activity row: pushes, merges, assignments, closes, labels the sync has not read yet.
  for (const w of writes) {
    if (used.has(w.rowid) || (w.comment && w.action !== "merge")) continue;
    if (/comment|review-/.test(w.action) && !GITHUB_ACTIONS[w.action]) continue;
    events.push({ id: `audit:${w.rowid}`, type: writeType(w.action), at: w.at, actor: "autocraft", body: summaryOf.get(`audit:${w.rowid}`) ?? GITHUB_ACTIONS[w.action] ?? w.action, autocraft: { as: asOf(w), historyId: `audit:${w.rowid}` } });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const commits = commitRows
    .map((m) => ({ sha: short(m.oid), message: clean(m.message ?? "", 500), author: m.author ?? "unknown", at: m.at, byAutoCraft: (!!m.author && own.has(m.author)) || pushed.has(m.oid) }));
  return {
    description: clean(it.body, 6000), events, checks: it.ciChecks.filter((x) => x.state !== "none").map((x) => ({ name: x.name, state: x.state })), commits,
    files: it.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })), url, syncedAt,
  };
}

// ---- screenshots -----------------------------------------------------------------------------------------------------

/** The latest screenshot run of the PR: one entry for staff, none for anyone else or a veiled PR. Images are served by the task artifact route. */
async function screenshotsOf(c: Ctx, headNow: string | null): Promise<ScreenshotRun[]> {
  if (!c.staff || c.veiled) return [];
  const r = await c.db.get(c.db.k.selectFrom("screenshot_runs").select(cols("screenshot_runs")).where("repo", "=", c.repo).where("number", "=", c.n)
    .orderBy("created_at", "desc").orderBy(rowid("screenshot_runs"), "desc").limit(1));
  if (!r) return [];
  const names = async (id: number | null): Promise<Set<string>> => new Set(id === null ? [] : (await c.db.all(c.db.k.selectFrom("build_artifacts").select("name").where("task_id", "=", id).where("content_type", "=", "image/png"))).map((x) => x.name));
  const [before, after] = await Promise.all([names(r.base_task_id), names(r.head_task_id)]);
  const shots = [...after].filter((n) => before.has(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
    .map((name) => ({ name, before: { taskId: r.base_task_id!, name }, after: { taskId: r.head_task_id!, name } }));
  return [{
    head: short(r.head_sha), current: r.head_sha === headNow, state: r.state as ScreenshotRun["state"], verdict: r.verdict as ScreenshotRun["verdict"], clear: r.clear === null ? null : r.clear === 1,
    comparison: r.comparison, held: r.held === 1, reason: r.reason, model: r.model, at: r.finished_at ?? r.created_at, shots,
  }];
}

// ---- the route -------------------------------------------------------------------------------------------------------------

export async function itemPage(db: Db, req: Req): Promise<ItemPageData | ItemPageUnchanged> {
  const c = await context(db, req);
  const since = req.query.get("since");
  // A poll with a stamp reads the stamp alone first, so an unchanged page costs only that; a first load reads both together.
  const stamped = stampOf(c, req);
  stamped.catch(() => {});
  if (since !== null && since === await stamped) return { unchanged: true, stamp: since };
  // The parts read independently, so each starts as soon as what it needs is read.
  const core = itemCore(db, req);
  const events = gather(c, null);
  const row = db.get(db.k.selectFrom("items").select(["url", "head_oid", (eb) => eb.selectFrom("item_reads as r").select("r.synced_at").whereRef("r.repo", "=", "items.repo").whereRef("r.number", "=", "items.number").as("synced_at")])
    .where("repo", "=", c.repo).where("number", "=", c.n)).then((r) => r!);
  const impl = implementationData(c);
  const status = core.then((it) => statusOf(c, it));
  const pr = core.then((it) => it.kind === "pr");
  const [it, cost, statusNow, bar, header, reviews, timeline, github, prBuild, screenshots, implementation, stamp] = await Promise.all([
    core,
    db.get(db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("r.cost_usd"), eb.lit(0)).as("cost"))
      .where("i.repo", "=", c.repo).where("i.number", "=", c.n).$if(filtered(c.hidden), (q) => q.where((eb) => hiddenExpr(db, eb, c.hidden)!))).then((r) => r!.cost),
    status,
    Promise.all([core, status]).then(([i, s]) => barOf(c, { kind: i.kind, state: i.state, mergedAt: i.mergedAt, pipelineOn: i.pipelineOn === true }, s)),
    core.then((i) => headerOf(c, i, i.queue ?? null, req)),
    Promise.all([pr, row, events]).then(([isPr, r, ev]) => (isPr ? reviewsOf(c, r.head_oid, ev) : { latest: null, earlier: [] })),
    Promise.all([pr.then((isPr) => (isPr ? preapprovalsOf(db, c.repo, c.n) : [])), events, impl]).then(([pre, ev, im]) => timelineOf(c, ev, pre, im)),
    Promise.all([core, events, row]).then(([i, ev, r]) => githubOf(c, i, ev, r.url ?? "", r.synced_at)),
    prBuildOf(c), row.then((r) => screenshotsOf(c, r.head_oid)), impl.then((im) => implementationView(c, im)),
    stamped,
  ]);
  return {
    repo: c.repo, number: c.n, kind: it.kind, state: it.state, title: it.title, author: it.author, stamp,
    header, status: statusNow, bar, costUsd: cost,
    reviews,
    timeline: timeline.slice(-200),
    github,
    prBuild,
    screenshots,
    implementation,
  };
}

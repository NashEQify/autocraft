// The Queue page: tabs All, Review, Fix, Verify and Merge over one repo filter, with fast-tracked items first, plus
// the operator's fast-track, hold and batch controls. Reads are for anyone signed in, limited to the repos the
// requester may see; every write is for operators (the route says so) and audited.
import { canSeeInternals } from "./staff.ts";
import type { FastPosition, ItemPrBuild, MergeWait, NextMerge, QueueMergeRow, QueueOrigin, QueuePage, QueuePendingRow, QueueRepos, QueueTab, QueueWorkRow, TypeLabel } from "../../../web/src/api/types.ts";
import type { CachedEntry } from "../../data/views/merge-queue.ts";
import { closingOf, loadQueuePage, type QueuePageFacts } from "../../data/views/queue.ts";
import { loadPrBuildViews, type PrBuildView } from "../../data/merge/index.ts";
import { loadTrackedRepos } from "../../data/control/index.ts";
import { loadItems, loadOpenPrLinks } from "../../data/mirror/index.ts";
import { featureOn } from "../../build/features.ts";
import { ownerOf } from "../../owners.ts";
import { HEAD_CHANGED, preapproveMerge } from "../../preapproval/index.ts";
import { requireSettle } from "../../settlers.ts";
import type { Exec } from "../../fixup/git.ts";
import { ControlError, holdMerge, releaseMerge, removeFromBatch, stopBatch } from "../../merge/controls.ts";
import { loadBatches } from "../../data/merge/index.ts";
import { loadHolds } from "../../data/workflow/index.ts";
import type { Preapproval } from "../../data/workflow/index.ts";
import { mergeOrder, queueSlots, scoreLookup } from "../../rank/position.ts";
import { classifyListOf, NOT_PLANNED } from "../../rank/next.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { toBatch, toRow } from "./queue.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import { mayRunRepo } from "../repo-access.ts";
import { readerOf, veiledFor } from "./reader.ts";
import { stageById } from "../../stages/registry.ts";
import type { Db } from "../../db/index.ts";
import { implementRefusal } from "../../implement/gate.ts";

export const TABS: QueueTab[] = ["all", "review", "fix", "verify", "merge"];
const NEXT_LIMIT = 10;

/** The tab a work row belongs to besides All, from its next step. */
export function tabOfNext(next: string): QueueTab | null {
  if (next === stageById("review").title) return "review";
  if (next.startsWith("Fix") || next.startsWith("Implement")) return "fix";
  if (next.startsWith("Verify")) return "verify";
  return null;
}

const WAITS: Record<string, [MergeWait, string, number]> = {
  ready: ["ready", "Ready", 0],
  "decision-answered-merge": ["ready", "Merge approved", 0],
  refused: ["refused", "Refused; tried again when GitHub reports something new", 1],
  "in-batch": ["batch-ci", "In a batch; waiting for the batch PR's CI", 1],
  "batch-checking": ["batch-check", "In a batch; checked in the sandbox", 1],
  "waiting-ci": ["ci", "Waiting for CI", 2],
  "waiting-main-ci": ["ci", "Waiting: main CI red", 2],
  "ci-approval": ["ci", "Waiting for CI run approval", 2],
  "waiting-verify": ["verify", "Waiting for Verify", 2],
  "waiting-premerge": ["premerge", "Waiting for the pre-merge review", 2],
};
const HELD: [MergeWait, string, number] = ["held", "Merge held by an operator", 9];

/** What merges next and what each PR waits for, from the queue states (src/merge/queue.ts). Fast-tracked first, held last. */
export function nextMerges(entries: CachedEntry[], fast: Map<string, FastPosition>, batchOf: Map<string, { id: number; branch: string }>, scores: Map<string, number>): NextMerge[] {
  const items = entries.flatMap((e) => {
    const w = e.held && e.state in WAITS ? HELD : e.state === "ci-approval" && e.runsBlocked ? WAITS[e.state]!.map((x, k) => (k === 1 ? "CI runs need a person to approve" : x)) as [MergeWait, string, number] : WAITS[e.state];
    return w ? [{ e, w }] : [];
  });
  items.sort((a, b) => {
    const fa = fast.get(`${a.e.repo}#${a.e.number}`)?.position ?? Infinity, fb = fast.get(`${b.e.repo}#${b.e.number}`)?.position ?? Infinity;
    return (a.w[2] === 9 ? 1 : 0) - (b.w[2] === 9 ? 1 : 0) || fa - fb || a.w[2] - b.w[2]
      || (scores.get(`${b.e.repo}#${b.e.number}`) ?? -1) - (scores.get(`${a.e.repo}#${a.e.number}`) ?? -1) || a.e.repo.localeCompare(b.e.repo) || a.e.number - b.e.number;
  });
  return items.slice(0, NEXT_LIMIT).map(({ e, w }) => ({
    repo: e.repo, number: e.number, title: e.title, waitsFor: w[0], label: w[1], fast: fast.get(`${e.repo}#${e.number}`) ?? null, batch: batchOf.get(`${e.repo}#${e.number}`) ?? null,
  }));
}

const refText = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;

/** `repo#number` of the item held by a feature switch row: PR builds are shown only where the repo has the switch on. */
async function prBuildsOf(db: Db, entries: CachedEntry[], internals: boolean): Promise<Map<string, ItemPrBuild>> {
  const repos = [...new Set(entries.map((e) => e.repo))];
  const on = new Set((await Promise.all(repos.map(async (r) => ((await featureOn(db, "pr-builds", r)) ? [r] : [])))).flat());
  const views = await loadPrBuildViews(db, entries.filter((e) => on.has(e.repo)).map((e) => ({ ref: refText(e), head: e.head })));
  return new Map(entries.flatMap((e): [string, ItemPrBuild][] => {
    const v = views.get(refText(e));
    return v ? [[refText(e), prBuildOf(v, e.head, internals)]] : [];
  }));
}

/** The build of the PR's current head, else the newest one. `internals` false: states only, no failure text. */
function prBuildOf(r: PrBuildView, head: string | null, internals: boolean): ItemPrBuild {
  const state = r.state === "queued" ? (r.taskState === "claimed" || r.taskState === "running" ? "running" : "queued") : r.state;
  return { headSha: r.headSha, current: r.headSha === head, state: state as ItemPrBuild["state"], summary: internals ? r.summary : null, disagree: r.disagree, ci: r.ciOverall as ItemPrBuild["ci"], createdAt: r.createdAt, finishedAt: r.finishedAt };
}

export async function queuePage(db: Db, req: Req): Promise<QueuePage> {
  const tab = (req.query.get("tab") || "all") as QueueTab;
  if (!TABS.includes(tab)) throw new HttpError(400, `tab must be one of ${TABS.join(", ")}`);
  const reposParam = (req.query.get("repos") || "pipeline") as QueueRepos;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const visible = await visibleRepos(db, req);
  const visibleSet = new Set(visible);
  if (reposParam !== "pipeline" && reposParam !== "all" && !visibleSet.has(reposParam)) throw new HttpError(404, `${reposParam} is not a tracked repo`);
  const internals = canSeeInternals(req);
  const reader = await readerOf(db, req);
  // The page's reads do not depend on each other, so they run together.
  const [facts, slots] = await db.together(() => Promise.all([
    loadQueuePage(db, { pipelineScope: reposParam === "pipeline", merge: tab === "merge", visible, hidden: reader.hidden }),
    queueSlots(db, visible),
  ]));
  const { views, holds: held, ranked, closes: closesOf, positions } = facts;
  const allEntries = facts.entries;
  const scoped = views ? new Set([...views].filter(([, v]) => v.scope).map(([k]) => k)) : null;
  const fastAll = new Map<string, FastPosition>([...positions].map(([k, p]) => [k, { position: p.position, of: p.of, weight: p.weight }]));
  const fast = new Map([...fastAll].filter(([k]) => visibleSet.has(k.slice(0, k.lastIndexOf("#")))));
  // The default view is the pipeline's scope (src/rank/position.ts), the same one the position badges count.
  const inScope = (repo: string, number: number): boolean =>
    reposParam === "all" ? visibleSet.has(repo) : reposParam === "pipeline" ? visibleSet.has(repo) && scoped!.has(`${repo}#${number}`) : repo === reposParam;
  const fastOf = (repo: string, number: number): FastPosition | null => fast.get(`${repo}#${number}`) ?? null;

  // A linked item (`item=repo:number`) comes with the first page: it is cut long enough to include the item.
  const item = req.query.get("item");
  const indexOf = (list: { repo: string; number: number }[]): number | null => {
    const at = item ? list.findIndex((r) => `${r.repo}:${r.number}` === item) : -1;
    return at < 0 ? null : at;
  };
  const sizeFor = (list: { repo: string; number: number }[], from: number): number => {
    const at = from === 0 ? indexOf(list) : null;
    return at === null ? limit : Math.min(500, Math.max(limit, Math.ceil((at + 1) / 100) * 100));
  };

  const score = scoreLookup(db);
  // Items in work order: the workflow's weight first, then the work rank.
  const inView = await Promise.all(ranked.filter((r) => visibleSet.has(r.repo) && inScope(r.repo, r.number)).map(async (r) => ({ r, s: await score(r.repo, r.number) ?? r.score })));
  inView.sort((a, b) => b.s - a.s);
  const work: QueueWorkRow[] = inView.map(({ r }) => {
    const bd = r.breakdown;
    return {
      repo: r.repo, number: r.number, kind: r.kind, title: r.title, score: r.score, level: bd.level, size: bd.size, breakdown: bd,
      label: r.label as TypeLabel | null, next: r.next ?? NOT_PLANNED, nextHref: r.itemState === "referee-due" ? classifyListOf(r.repo) : null,
      queue: slots.get(`${r.repo}#${r.number}`) ?? null, fast: fastOf(r.repo, r.number), held: held.has(`${r.repo}#${r.number}`),
    };
  });

  // Merge queue rows
  const entries = allEntries.filter((e) => e.state !== "merged" && visibleSet.has(e.repo) && inScope(e.repo, e.number));
  const originOf = queueOriginOf(facts, internals);
  const builds = tab === "merge" ? await prBuildsOf(db, entries, internals) : new Map<string, ItemPrBuild>();
  const asRow = (e: CachedEntry): QueueMergeRow => ({ ...toRow(e, reader), fast: fastOf(e.repo, e.number), held: e.held, prBuild: builds.get(refText(e)) ?? null, closes: closesOf.get(refText(e)) ?? [], added: originOf(e) });
  // Tabs come from the stored next step; the text is veiled afterwards, so a quiet pull request stays in its tab.
  const tabOf = new Map(work.map((w) => [w, tabOfNext(w.next)]));
  const veilNext = (w: QueueWorkRow): QueueWorkRow => (veiledFor(reader, w.repo, w.number) ? { ...w, next: "" } : w);
  const pending = pendingRows(facts, entries, inScope, originOf, fastOf, held, internals);
  const count = (t: QueueTab): number => (t === "all" ? work.length : t === "merge" ? entries.length + pending.length : work.filter((w) => tabOf.get(w) === t).length);
  const counts = { all: count("all"), review: count("review"), fix: count("fix"), verify: count("verify"), merge: count("merge") };

  const out: QueuePage = { tab, repos: reposParam, counts, rows: [], mergeRows: [], nextMerges: [], batches: [], total: 0, next: null };
  if (tab !== "merge") {
    const match = tab === "all" ? work : work.filter((w) => tabOf.get(w) === tab);
    out.itemIndex = indexOf(match);
    out.rows = match.slice(offset, offset + sizeFor(match, offset)).map(veilNext);
    out.total = match.length;
    out.next = offset + out.rows.length < match.length ? offset + out.rows.length : null;
    return out;
  }
  const rows = entries.map((e) => [e, asRow(e)] as const);
  const ordered = await mergeOrder(db, entries);
  const active = facts.batches.filter((b) => (b.state === "checking" || b.state === "open") && b.members.some((p) => inScope(b.repo, p.number)));
  const rowOfEntry = new Map(rows);
  const rowOf = new Map(rows.map(([e, r]) => [`${e.repo}#${e.number}`, r]));
  const batchOf = new Map(active.flatMap((b) => b.members.map((p) => [`${b.repo}#${p.number}`, { id: b.id, branch: b.branch }] as const)));
  // The merge rows are the ones built above, in merge order.
  const free = ordered.map((e) => rowOfEntry.get(e)!);
  out.itemIndex = indexOf(free);
  out.mergeRows = free.slice(offset, offset + sizeFor(free, offset));
  out.total = free.length;
  out.next = offset + out.mergeRows.length < free.length ? offset + out.mergeRows.length : null;
  out.nextMerges = nextMerges(entries, fast, batchOf, facts.scores);
  out.batches = active.map((b) => toBatch(b, reader, b.members.flatMap((p) => rowOf.get(`${b.repo}#${p.number}`) ?? [])));
  out.pending = pending;
  return out;
}

/**
 * Open PRs queued with Queue items or pre-approved that are no merge queue row yet: no take review at their head, so they wait for
 * the fix-up or the review first. `entries` are the queue rows the view shows and `want` is the view's scope, so a PR is in exactly one
 * group. Oldest first.
 */
function pendingRows(f: QueuePageFacts, entries: CachedEntry[], want: (repo: string, number: number) => boolean, originOf: (e: Pick<CachedEntry, "repo" | "number" | "reviewedAt">) => QueueOrigin,
  fastOf: (repo: string, number: number) => FastPosition | null, held: Set<string>, staff: boolean): QueuePendingRow[] {
  void staff;
  const queued = new Set(entries.map((e) => `${e.repo}#${e.number}`));
  const seen = new Set<string>();
  const out: QueuePendingRow[] = [];
  for (const p of f.legs) {
    const k = `${p.repo}#${p.number}`;
    if (p.state !== "fixup" && p.state !== "review" && p.state !== "ci") continue;
    const it = f.pending.get(k);
    if (!it || it.state !== "OPEN" || it.kind !== "pr" || seen.has(k) || queued.has(k) || !want(p.repo, p.number)) continue;
    seen.add(k);
    out.push({
      repo: p.repo, number: p.number, kind: "pr", title: it.title ?? "", author: it.author ?? "", size: f.ranks.get(k)?.breakdown.size ?? null, step: p.state,
      fast: fastOf(p.repo, p.number), held: held.has(k), added: originOf({ repo: p.repo, number: p.number, reviewedAt: "" }),
    });
  }
  return out;
}

/**
 * How each PR came into the merge queue, and who put it there: an active pre-approval (added with Queue items, or a pre-approval
 * after a fix-up), else the take review itself. Operator logins are shown to staff only.
 */
export function queueOriginOf(f: Pick<QueuePageFacts, "legs" | "carried">, staff: boolean): (e: Pick<CachedEntry, "repo" | "number" | "reviewedAt">) => QueueOrigin {
  const pre = new Map<string, Preapproval>();
  for (const p of f.legs) pre.set(`${p.repo}#${p.number}`, p);
  // A Merge answer carried to a new head is audited as such when its row is made.
  const carried = (target: string, id: number): boolean => (f.carried.get(target) ?? []).some((a) => a.details?.id === id && a.details?.carried != null);
  const who = (login: string | null | undefined) => (staff ? login || null : null);
  return (e) => {
    const p = pre.get(`${e.repo}#${e.number}`);
    if (p) return { how: p.instructions ? "preapproved" : carried(`${p.repo}#${p.number}`, p.id) ? "answer" : "queued", by: who(p.by), at: p.at };
    return { how: "review", by: null, at: e.reviewedAt };
  };
}

// ---- repo list, merge holds, queueing and batch controls --------------------------------

/** Visible repos whose pipeline is on. */
export async function pipelineRepoNames(db: Db, req: Req): Promise<string[]> {
  const tracked = await loadTrackedRepos(db);
  return (await visibleRepos(db, req)).filter((r) => tracked.get(r)?.pipeline === true);
}

/** Fast track is retired: the workflow's weight orders the queue, so no item is listed. */
export async function fastTrackRefs(_db: Db, _req: Req): Promise<string[]> {
  return [];
}

/** PRs whose merge an operator holds, as `repo#number`, in visible repos. */
export async function heldMergeRefs(db: Db, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  return [...(await loadHolds(db)).keys()].filter((k) => visible.has(k.slice(0, k.lastIndexOf("#")))).sort();
}

/** `https://github.com/<owner>/<repo>/pull/<n>` (or `/issues/<n>`), `<repo>#<n>` or `<owner>/<repo>#<n>`. */
function parseItemRef(input: unknown): { repo: string; number: number } {
  const t = typeof input === "string" ? input.trim() : "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new Error("not an item: use a GitHub URL, repo#number or owner/repo#number");
  if (m[1] && m[1].toLowerCase() !== ownerOf(m[2]!).toLowerCase()) throw new Error(`${m[1]}/${m[2]} is not a tracked repo of ${m[1]}`);
  return { repo: m[2]!, number: Number(m[3]) };
}

function item(req: Req): { repo: string; number: number } {
  const b = req.json;
  const text = b && typeof b === "object" && !Array.isArray(b) ? (b as { item?: unknown }).item : undefined;
  try {
    return parseItemRef(text);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Hold and the batch controls are for whoever runs the repo (src/dash/repo-access.ts). */
async function needRunner(req: Req, repo: string): Promise<void> {
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
}

/** Runs a library call, turning its errors into HTTP ones. */
async function guarded<T>(f: () => Promise<Promise<T> | T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ControlError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

const RETIRED = "fast track is retired: start the item with a command and set its weight with the weight command";

async function retiredRoute(db: Db, req: Req): Promise<never> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  throw new HttpError(410, RETIRED);
}

export const fastTrackAdd = async (db: Db, req: Req): Promise<string[]> => retiredRoute(db, req);
export const fastTrackWeight = async (db: Db, req: Req): Promise<string[]> => retiredRoute(db, req);
export const fastTrackRemove = async (db: Db, req: Req): Promise<string[]> => retiredRoute(db, req);

/** Queuing an issue is the start of its workflow: the row that carries the queuer and the weight is written by the command, so nothing is stored here. */
export async function queueIssue(_db: Db, _by: string, _repo: string, _number: number, _w: number | null, _via?: string): Promise<void> {}

/** The open PRs of `repo` that close issue `issue` when they merge (GitHub's closing references, from the mirror), in number order. */
export async function openPrsClosing(db: Db, repo: string, issue: number): Promise<number[]> {
  return (closingIndex(await loadOpenPrLinks(db, [repo])).get(`${repo}#${issue}`) ?? []);
}

/** The open PRs that close each issue, by `repo#issue`, in number order. */
function closingIndex(links: Awaited<ReturnType<typeof loadOpenPrLinks>>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [pr, issues] of closingOf(links)) {
    const repo = pr.slice(0, pr.lastIndexOf("#"));
    const n = Number(pr.slice(pr.lastIndexOf("#") + 1));
    for (const i of new Set(issues)) out.set(`${repo}#${i}`, [...(out.get(`${repo}#${i}`) ?? []), n]);
  }
  for (const l of out.values()) l.sort((a, b) => a - b);
  return out;
}

/** What Queue items does, as the refusal of `settleRefusal` names it. */
export const queueWhat = (repo: string): string => `queues items on ${repo}`;

/**
 * "Queue items", one line, for an operator or a maintainer who settles on the repo. A PR is pre-approved at its current head (it merges
 * once the review says take, the pre-merge review is clean and CI is green). An issue is queued for Fix; when exactly one open PR closes
 * it, that PR is queued as above. Several closing PRs are only listed: a person picks one.
 * `pin` (a command in a comment) names the one head each PR may be pre-approved at, or null for a PR that may not be queued: one
 * opened or pushed to after the comment.
 */
export async function queueAdd(db: Db, req: Req, via?: string, pin?: (pr: number) => string | null): Promise<{ label: string; fast: string[] }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  // A pre-approved merge is a Merge answer given ahead, so it takes the rule of an answer (src/settlers.ts): an operator with write access, or a maintainer where they settle decisions.
  await requireSettle(db, req.user, [r.repo], queueWhat(r.repo));
  const by = req.user.login;
  const kind = (await loadItems(db, [r], "ref")).get(refText(r))?.kind;
  if (kind === "issue") {
    await queueIssue(db, by, r.repo, r.number, null, via);
    const prs = await openPrsClosing(db, r.repo, r.number);
    if (!prs.length) {
      const waits = await implementRefusal(db, r.repo, r.number);
      return { label: waits ? `Queued; it is not implemented while ${waits}` : "Queued: AutoCraft plans and implements it", fast: [] };
    }
    let rest: string;
    if (prs.length > 1) rest = `${prs.map((n) => `#${n}`).join(", ")} close it; queue one of them`;
    else if (pin && pin(prs[0]!) === null) rest = `#${prs[0]} closes it but was opened or pushed to after your comment, so it was not queued; comment on #${prs[0]} to queue it`;
    else {
      try {
        await preapproveMerge(db, { repo: r.repo, number: prs[0]!, by, via, ...(pin ? { head: pin(prs[0]!)! } : {}) });
        rest = `queued #${prs[0]}, which closes it`;
      } catch (e) {
        rest = `#${prs[0]} closes it but was not queued: ${(e as Error).message}`;
      }
    }
    return { label: `Queued the issue; ${rest}`, fast: [] };
  }
  let done: { label: string };
  const head = pin ? pin(r.number) : undefined;
  if (head === null) throw new HttpError(409, HEAD_CHANGED);
  try {
    done = await preapproveMerge(db, { repo: r.repo, number: r.number, by, via, ...(head === undefined ? {} : { head }) });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  return { label: done.label, fast: [] };
}

export async function mergeHoldPr(db: Db, req: Req, on: boolean): Promise<{ ok: true }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  const changed = await guarded(async () => (on ? await holdMerge(db, req.user.login, r.repo, r.number) : await releaseMerge(db, req.user.login, r.repo, r.number)));
  if (!changed) throw new HttpError(409, `${r.repo}#${r.number} is ${on ? "already" : "not"} held`);
  return { ok: true };
}

export async function batchRemovePr(db: Db, req: Req, run?: Exec): Promise<{ batch: string; closed: number | null }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  return guarded(async () => removeFromBatch(db, req.user.login, r.repo, r.number, run));
}

export async function batchStop(db: Db, req: Req, run?: Exec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? (await loadBatches(db, [id])).get(id)?.repo : undefined;
  if (!repo) throw new HttpError(404, `no batch ${req.params.id}`);
  await needVisible(db, req, repo);
  await needRunner(req, repo);
  return guarded(async () => stopBatch(db, req.user.login, id, run));
}

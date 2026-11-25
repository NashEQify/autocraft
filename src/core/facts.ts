// Facts: everything the review-to-merge rules read about open PRs, built for a whole pass or a slice of it from the module loads of
// core/pass-load.ts. Each concept has one definition here.
import { listQuietPrs } from "../data/security/index.ts";
import { loadOwnLogins } from "../data/access/index.ts";
import { loadMainFixPrs, attemptsIn, conflictAskRetryAtOf, conflictBucketOf, cifixAt, fixupAtHead, lintOf, operatorTriesIn, premergeFixUsedIn, pushChainOf } from "../data/changes/index.ts";
import { loadAssignments, withConfig, config } from "../data/control/index.ts";
import { loadUnsureHeads } from "../data/review/index.ts";
import { fullPass } from "../data/planner/index.ts";
import type { KeySource, Ref } from "../data/keys.ts";
import { authorWritesOf } from "../fixup/author-permission.ts";
import { longLivedAll, pushable, sameRepo } from "../fixup/pushable.ts";
import { ENDED_STATES, type ImplementationState } from "../implement/types.ts";
import { refereeClosed, settle, type Settled } from "../classify/settled.ts";
import { classifyRun, loadSettled } from "../data/triage/index.ts";
import { redMainRepos, MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import { changesRequestedWhy, GATE_FAILURES, failureNote } from "../merge/changes-requested.ts";
import { effectiveCiWith } from "../optional-checks.ts";
import { parseFixes } from "../fixup/candidates.ts";
import { tierKey, tiersOf, type AuthorRef } from "../whitelist.ts";
import { findingsOf } from "../premerge/store.ts";
import { parsePublic } from "../review/opus-parse.ts";
import { rereadPaceAt } from "../review/diff.ts";
import { slugOf } from "../owners.ts";
import { EXTRAS_PENDING_REASON } from "./sensitive.ts";
import { CARRIED, carriedReview } from "../review/carry.ts";
import { postSourcesOf } from "../review/post-source.ts";
import { staleReviews } from "../review/discussion.ts";
import { nextUtcMidnight, reviewHolds } from "../review/gate.ts";
import { NOT_RUST_REASON, PRIVATE_REASON, cachedRust } from "../verify/candidates.ts";
import { BASE_NAME, FIXUP_MAX_ATTEMPTS, MAX_FAILURES, PIPELINE_LOGIN_KEY, mergeDecisionId, pipelineWrites, sizeOf } from "./rules.ts";
import { tripsOfRepo } from "./push-outcome.ts";
import { pushAllowed } from "./gates.ts";
import type { WorkflowGate } from "./may.ts";
import { loadPrPass, type PrPassData } from "./pass-load.ts";
import type { AssignFacts, PassFacts, PrFacts, PrTier } from "./plan.ts";
import type { ItemWorkflow } from "../workflow/types.ts";
import type { Db } from "../db/index.ts";

export type { PrFacts } from "./plan.ts";

export type LoadOptions = {
  repo?: string;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The pass keys (planner.fullPass / changedPass); default: `refs`, else every item of the pass universe. */
  keys?: KeySource;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** Not read: own logins come from access. */
  appSlug?: string | null;
  /** The classification run for labels (default: latestRun). */
  run?: string | null;
};

type Mirrored = PrPassData["mirror"] extends Map<string, infer V> ? V : never;
type RunApproval = PrPassData["merge"]["runs"] extends Map<string, infer V> ? V : never;

const parseList = (s: string | null): unknown[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };
const safeJson = (s: string | null | undefined): unknown => { try { return JSON.parse(s!); } catch { return null; } };
const asRef = (key: string): Ref => { const i = key.lastIndexOf("#"); return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) }; };

/** The instance-wide inputs of decidePr at `now`: read once per pass, not per PR. */
export const loadPass = (now: number = Date.now()): PassFacts => ({ rereadPaceAt: rereadPaceAt(now) });

/** Keeps the earliest time after `now` per ref: what `refreshAt` is made from. */
export function refreshTimes(now: number): { soon: (ref: string, at: number | undefined) => void; at: (ref: string, ...more: (number | undefined)[]) => number | undefined } {
  const times = new Map<string, number>();
  const later = (t: number | undefined): t is number => t !== undefined && Number.isFinite(t) && t > now;
  return {
    soon: (ref, t) => { if (later(t) && !(times.get(ref)! <= t)) times.set(ref, t); },
    at: (ref, ...more) => [times.get(ref), ...more].filter(later).reduce<number | undefined>((m, t) => (m === undefined || t < m ? t : m), undefined),
  };
}

/** The PR's current head: checks fetched after the mirror's last update win over the mirror. */
function currentHead(m: Mirrored): string | null {
  const c = m.checks, i = m.item;
  if (c?.head_oid && c.fetched_at && (!i.updated_at || c.fetched_at > i.updated_at)) return c.head_oid;
  return i.head_oid ?? c?.head_oid ?? null;
}

/** The live workflow of the PR, or of the issue whose implementation PR it is. */
const workflowFactOf = (d: PrPassData, ref: string) => d.workflow.live.get(ref) ?? d.workflow.ofPr.get(ref) ?? null;

/** What `mayMerge` and `mayPush` read of a live workflow row; null without a live one. */
export function workflowGate(w: ItemWorkflow | undefined, fixupAsked: boolean): WorkflowGate | null {
  if (!w) return null;
  return {
    live: true, entry: w.entry === "fixup" ? "fix-up" : w.entry, state: w.state, startedBy: w.startedBy, approvedBy: w.approvedBy, approvedAt: w.approvedAt,
    blocker: w.blocker, baseHead: w.baseHead, fixupAsked,
  };
}

/** The work score of a live workflow (higher first), as `workflow.fragments.weightScoreExpr` orders: weight, then the older workflow. */
const weightScore = (w: { id: number; weight: number } | null): number | null => (w ? 1e15 + w.weight * 1e12 - w.id : null);

/** Our own integration PR of a batch. */
function integrationOf(d: PrPassData, ref: string): boolean {
  const m = d.mirror.get(ref);
  return d.merge.batchPrs.has(ref) && !!m?.item.author && d.ownLogins.has(m.item.author);
}

/** The pass universe: open PRs, merged PRs with a take review or merged by us, PRs of a live implementation attempt. */
function inUniverse(d: PrPassData, ref: string, state: string): boolean {
  if (state === "OPEN") return true;
  const v = d.review.latest.get(ref)?.verdict;
  if (state === "MERGED" && (v === "take" || v === "take-fix")) return true;
  if (d.merge.merged.has(ref)) return true;
  const a = d.implement.byPr.get(ref);
  return !!a && !ENDED_STATES.has(a.state as ImplementationState);
}

/** PRs the pipeline opened itself: quiet security PRs and default-branch fix PRs, when a pipeline account is set. */
const ownPrSet = (mainFix: Set<string>, quiet: Set<string>, login: string | null): Set<string> => (login ? new Set([...quiet, ...mainFix]) : new Set());

/** Facts of every open PR (and merged PRs with a take or take-fix review, merged by us, or of a live implementation) of the keys given. One load for all PRs. */
export async function loadPrFacts(db: Db, opts: LoadOptions = {}): Promise<PrFacts[]> {
  const now = opts.now ?? Date.now();
  const refs = opts.refs ? [...opts.refs] : undefined;
  // NEEDS planner.repoPass: the pass universe of one repo; a repo-only load reads the full pass and keeps that repo's PRs.
  const keys: KeySource = opts.keys ?? (refs ? refs.map(asRef) : fullPass());
  const mergeEntryHead = (d: PrPassData, ref: string): string | null => {
    const m = d.mirror.get(ref);
    if (!m || m.item.kind !== "pr" || m.item.state !== "OPEN" || integrationOf(d, ref)) return null;
    return workflowFactOf(d, ref)?.entry === "merge" ? currentHead(m) : null;
  };
  // Clock-driven changes the facts below do not show as a time of their own (expiries, daily counts, cache lifetimes), per PR.
  const refresh = refreshTimes(now);
  return await db.read(async () => {
    const [d, run, stale, staleActionable, mainRed, quiet, authorWrites, longLived, holdOf] = await Promise.all([
      loadPrPass(db, keys, { now, mergeEntryHead }),
      opts.run !== undefined ? Promise.resolve(opts.run) : classifyRun(db),
      staleReviews(db, opts.repo, false, { now, refresh: refresh.soon }),
      staleReviews(db, opts.repo, true, { now, refresh: refresh.soon }),
      redMainRepos(db), listQuietPrs(db, { repo: opts.repo }), authorWritesOf(db, now), longLivedAll(db), reviewHolds(db, now, refs),
    ]);
    const keep = (ref: string): boolean => (!opts.repo || asRef(ref).repo === opts.repo) && (!refs || refs.includes(ref));
    const rows = [...d.mirror].filter(([ref, m]) => keep(ref) && m.item.kind === "pr" && inUniverse(d, ref, m.item.state));
    const scoped = rows.filter(([ref]) => d.inScope.has(ref) && !integrationOf(d, ref)).map(([ref]) => ref);
    const ownPrs = ownPrSet(d.mainFixPrs, quiet, d.control.settings.get(PIPELINE_LOGIN_KEY) ?? null);
    const authors = rows.filter(([ref, m]) => scoped.includes(ref) && m.item.author).map(([, m]) => ({ login: m.item.author!, id: m.item.author_id ?? null }));
    const [settled, tiers, postSource] = await Promise.all([
      loadSettled(db, scoped.map(asRef), run).then((m) => async (repo: string, number: number): Promise<Settled> => m.get(`${repo}#${number}`) ?? settle(null, null)), tiersOf(db, authors),
      postSourcesOf(db, rows.filter(([ref]) => d.review.latest.get(ref)?.mode === CARRIED).map(([ref]) => ref)),
    ]);
    const ctx: Ctx = { now, refresh, stale, staleActionable, mainRed, quiet, ownPrs, authorWrites, longLived, holdOf, settled, tiers, postSource };
    return await withConfig(db, async () => {
      const out: PrFacts[] = [];
      for (const [ref, m] of rows) {
        const f = await buildPr(db, d, ref, m, ctx);
        if (f) out.push(f);
      }
      // The timed waits the facts hold end at their own times; the refresh also covers the clock uses they do not show.
      const until = (u: { until: number } | "final" | undefined): number | undefined => (typeof u === "object" ? u.until : undefined);
      for (const f of out) {
        const at = refresh.at(`${f.repo}#${f.number}`, f.reviewHold?.until, f.conflict?.until, until(f.fixup?.unsent), until(f.cifix?.unsent));
        if (at !== undefined) f.refreshAt = at;
      }
      return out;
    }, { preload: d.control });
  });
}

/** Facts of one PR, or null when it is not an open PR (or a merged one with a take review). */
export async function loadPrFact(db: Db, repo: string, number: number, opts: Omit<LoadOptions, "repo" | "refs" | "keys"> = {}): Promise<PrFacts | null> {
  return (await loadPrFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
export type { PrTier };

type Ctx = {
  now: number; refresh: ReturnType<typeof refreshTimes>; stale: Set<string>; staleActionable: Set<string>; mainRed: Set<string>; quiet: Set<string>; ownPrs: Set<string>;
  authorWrites: Awaited<ReturnType<typeof authorWritesOf>>; longLived: Awaited<ReturnType<typeof longLivedAll>>; holdOf: Awaited<ReturnType<typeof reviewHolds>>;
  settled: (repo: string, number: number) => Promise<Settled>; tiers: Awaited<ReturnType<typeof tiersOf>>; postSource: Awaited<ReturnType<typeof postSourcesOf>>;
};

function runsOf(w: RunApproval | undefined, ciApproved: boolean): PrFacts["runs"] {
  if (!w) return null;
  const waiting = w.runs.length + (w.reread ? 1 : 0);
  const failed = (id: number) => w.failed[String(id)] ?? 0;
  const blocked: NonNullable<PrFacts["runs"]>["blocked"] = !waiting ? null : !ciApproved ? "off" : w.runs.some((x) => failed(x.id) >= MAX_FAILURES) ? "failed"
    : !w.reread && (!w.crossRepo || !w.runs.some((x) => x.event === "pull_request")) ? "unsupported" : null;
  return { waiting, reread: w.reread, crossRepo: w.crossRepo, approvable: w.runs.filter((x) => x.event === "pull_request" && failed(x.id) < MAX_FAILURES).length, blocked };
}

/** The retired Merge? and Hold questions: no item has one. */
const NO_DECISION: PrFacts["decision"] = { asked: false, openQuestion: false, answer: null, mergeAnswerAfterReview: false, inOpenGroup: false, execWaiting: false, hold: { asked: false, open: false, answer: null, otherOpen: false } };

async function buildPr(db: Db, d: PrPassData, ref: string, m: Mirrored, c: Ctx): Promise<PrFacts | null> {
  const { now, refresh } = c;
  const i = m.item, ch = m.checks;
  const repo = i.repo, number = i.number;
  const state = i.state as PrFacts["ghState"];
  const integration = integrationOf(d, ref);
  const inPilot = d.inScope.has(ref);
  // The queue leaves merged PRs outside the scope and our own integration PRs out.
  if (state !== "OPEN" && (!inPilot || integration)) return null;
  const cfg = config(db);
  const approvals = d.control.approvals.get(repo) ?? {};
  const repoRow = d.repos.get(repo);
  const rf: PrFacts["repoFacts"] = {
    mergeApproved: !!approvals.merge, pushApproved: !!approvals.push, commentApproved: !!approvals.comment, ciApproved: !!approvals.ci,
    noCi: !!d.ciSignals.get(repo)?.noCi, mainRed: c.mainRed.has(repo), fixIssueApproved: !!approvals.fixissue,
    implementOn: cfg.repo(repo).buildFeature("implement"), workflow: "new",
  };
  const pub = repoRow?.visibility === "public";
  const defaultBranch = repoRow?.default_branch ?? null;
  const optional = cfg.repo(repo).optionalChecks;
  const ciOf = (overall: string | null | undefined): string => effectiveCiWith(optional, overall ?? "none", ch?.checks ?? null);
  const isOwn = (author: string | null): boolean => !!author && d.ownLogins.has(author);
  const fresh = !!ch?.fetched_at && (!i.updated_at || ch.fetched_at > i.updated_at);
  // An integration PR's head is the batch tip, where the run approvals are recorded.
  const batchRow = integration ? d.merge.integration.get(ref) : undefined;
  const pipelineRepo = !!d.control.tracked.get(repo)?.pipeline;
  const inScope = integration ? pipelineRepo || (!!batchRow && batchRow.members.length > 0 && batchRow.members.every((x) => d.inScope.has(`${repo}#${x.number}`))) : inPilot;
  const head = batchRow?.commitSha ?? currentHead(m);
  const patch = d.patches.get(ref) ?? { fixups: [], cifixes: [], conflicts: [], pushes: [] };
  const push = d.pushes.get(ref);
  const movedAt = head ? push?.movedOffAt.get(head) : undefined;
  const pushedOff = state === "OPEN" && !integration && !!head && !!movedAt && (!i.updated_at || Date.parse(i.updated_at) < Date.parse(movedAt));
  const lines = (i.additions ?? 0) + (i.deletions ?? 0);
  const wfFact = workflowFactOf(d, ref);
  const wfRow = wfFact ? d.workflowRows.get(wfFact.id) : undefined;
  const operator = d.workflow.operator.get(ref);
  const ownHeads = (h: string): string[] => pushChainOf(patch.pushes, h).filter((x) => d.ownCommits.has(`${repo}@${x}`));
  const ownHead = (h: string): boolean => ownHeads(h).length > 0;
  const assigned = d.assignments.get(ref);
  const pipelineLogin = d.control.settings.get(PIPELINE_LOGIN_KEY) ?? null;
  const assignment: AssignFacts = {
    login: pipelineLogin ?? assigned?.assignee ?? null, assignees: parseList(i.assignees).filter((x): x is string => typeof x === "string"),
    ours: assigned !== undefined && (pipelineLogin === null || assigned.assignee === pipelineLogin),
  };
  const trips: Record<string, string> = {};
  for (const [stage, t] of d.control.trips) if (t.active) trips[stage] = t.reason;
  const outsideHold = d.outsideHolds.get(ref);
  const implementation = d.implement.byPr.get(ref);
  const latest = d.review.latest.get(ref);
  const base: PrFacts = {
    repo, number, ...(pushedOff ? { pushedOff } : {}), assignment, now, pipelineOn: pipelineWrites(d.control.settings.get("pipeline_enabled") ?? undefined),
    tripped: tripsOfRepo(trips, repo), ghState: state, head, draft: fresh ? ch!.state !== "OPEN" || !!ch!.is_draft : !!i.is_draft,
    author: i.author, authorIsPipeline: isOwn(i.author), tier: "not", lines, size: sizeOf(lines), label: null, needsDecisionFlag: false,
    scopeAnswer: null,
    inScope, ...(outsideHold ? { outsideHold } : {}), integration, batchPr: d.merge.batchPrs.has(ref),
    heldBacklog: !wfFact && d.workflow.ended.get(ref) === "backlog", heldDuplicate: false, quiet: c.quiet.has(ref), mergeHeld: d.workflow.holds.has(ref),
    fast: false, score: weightScore(wfFact) ?? d.ranks.get(ref)?.score ?? null, repoFacts: rf,
    review: null, post: { postable: false, posted: null },
    checksHere: false, checksOpen: false, ci: "unknown", mergeable: i.mergeable ?? "UNKNOWN", unknown: null, runs: null,
    lastMerge: null, runsApprovedAfterMerge: false, verifyOverride: false, verification: null, verifyUnavailable: null,
    decision: NO_DECISION,
    premerge: null, premergeFixUsed: false, sensitive: null, statementConflicts: [], pushable: false, pushChain: [], conflict: null, inActiveBatch: d.merge.activeBatched.has(ref),
    fixup: null, carry: [], lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false, stackedOn: null, changesRequested: null, gateFailureNote: null,
    may: { repoMerge: approvals.merge ?? null, repoPush: approvals.push ?? null, workflow: workflowGate(wfRow, (operator?.requests.length ?? 0) > 0), ownHeads: head ? ownHeads(head) : [],
      fixupBy: (head ? operator?.requests.findLast((r) => r.from_head === head)?.by : undefined) ?? null },
  };
  base.inFlight = state === "OPEN" && !integration && isOwn(i.author) && c.ownPrs.has(ref);
  base.implementation = implementation ? { issue: implementation.issue, state: implementation.state, revisedHeads: implementation.revisedHeads } : null;
  base.workflow = wfFact;
  base.endedWorkflow = d.workflow.ended.get(ref) ?? null;
  if (integration) {
    // The batch tip's run approvals count only while the batch is open and every member keeps its take review at its batched head.
    const tipRuns = batchRow?.state === "open" && batchRow.membersReviewed ? d.merge.runs.get(`${ref}@${batchRow.commitSha}`) : undefined;
    base.runs = runsOf(tipRuns, rf.ciApproved);
    return base;
  }
  if (!inScope) {
    const v = head ? d.merge.verifications.get(`${ref}@${head}`) : undefined;
    base.outside = {
      review: latest && latest.head === head && !c.stale.has(`${ref}@${latest.head}`) ? latest.verdict : null,
      verify: v?.state ?? null, ci: head && ch?.head_oid === head ? ch.overall ?? null : null,
    };
    return base;
  }

  const s = await c.settled(repo, number);
  base.label = s.label ?? null;
  base.needsDecisionFlag = s.flags.includes("needs decision");
  base.labelUnsure = s.status === "settled" && !!s.referee && !s.referee.sure && refereeClosed(s.referee);
  const tierOf = (h: string | null): PrTier => {
    const t = (i.author ? c.tiers.get(tierKey({ login: i.author, id: i.author_id ?? null })) : undefined) ?? "not";
    // The pipeline's own fix PRs count as whitelisted at a head the pipeline itself pushed (others may push to the branch); an operator's deny still wins.
    return t === "not" && isOwn(i.author) && c.ownPrs.has(ref) && !!h && ownHead(h) ? "whitelisted" : t;
  };
  base.tier = tierOf(head);
  const pm = d.merge.merged.get(ref);
  if (pm) base.postmerge = { mergedAt: pm.firstAt, head: pm.lastHead, since: d.control.settings.get("postmerge_since") ?? "9999", review: d.review.postmerge.get(ref) ?? null };
  const mxh = state === "OPEN" && wfFact?.entry === "merge" ? head : null;
  // Checks describe the PR when they were fetched for the reviewed head (or, without a review, the current one).
  const checksAtHead = ch?.head_oid === (mxh ?? latest?.head ?? head);
  base.mergeable = (checksAtHead ? ch?.mergeable : i.mergeable) ?? "UNKNOWN";
  // An author whose permission has not been read yet counts as able to write: the job that pushes reads it first.
  base.pushable = pushable(i.head_repo, repo, checksAtHead ? ch?.maintainer_can_modify : i.maintainer_can_modify, i.head_ref, c.longLived(repo), false,
    sameRepo(i.head_repo, repo) && c.authorWrites(repo, { author: i.author, author_type: i.author_type, author_id: i.author_id ?? null }, (t) => refresh.soon(ref, t)) !== "no");
  if (operator && state === "OPEN") {
    const legs = operator.legs;
    base.operator = {
      fix: !!head && operator.requests.some((r) => r.from_head === head) ? { attempts: operatorTriesIn(patch.fixups) } : null,
      hold: legs.some((l) => l.state !== "queued"), premerge: !!head && legs.some((l) => l.state === "ci" && l.head === head), preapproved: legs.length > 0,
    };
  }
  // A fix-up request holds the PR's merge only while the planner can work it: same head, pushable, approved, not conflicting, not a draft, tries left.
  if (base.operator?.fix && !base.heldBacklog && !base.draft && base.mergeable !== "CONFLICTING" && base.pushable && pushAllowed(base, "fixup", true) && operatorTriesIn(patch.fixups) < FIXUP_MAX_ATTEMPTS) base.operator.hold = true;
  const lintAt = (qh: string, cifixHead: string) => lintOf(patch, qh, { cifixHead, operatorHead: head ?? qh, tasks: d.tasks });
  if (operator && state === "OPEN" && head) {
    for (const l of lintAt(head, head)) if (l.source === "operator") base.lint.push({ step: "fixup", source: "operator", ended: l.ended });
    if (base.lint.length) base.inFlight = true;
  }
  if (state === "OPEN" && head && !base.draft) { const hold = await c.holdOf(repo, number, head, (t) => refresh.soon(ref, t)); if (hold) base.reviewHold = hold; }
  // A merge-entry PR has no review: its queue facts below are read at its current head (the queue head), and it entered the queue when its workflow started.
  if (!mxh && !latest) return base;
  const mx = mxh !== null;
  const qh = mxh ?? latest!.head;
  const qAt = mx ? wfFact!.startedAt : latest!.at;
  const verdict = latest?.verdict;

  const take = mx || verdict === "take" || verdict === "take-fix";
  const chain = take ? pushChainOf(patch.pushes, qh) : [qh];
  if (!mx) {
    const unsure = take && (!latest!.sure || chain.some((h) => d.review.unsureHeads.has(`${ref}@${h}`)));
    base.review = {
      head: qh, at: qAt, verdict: verdict!, unsure, mode: latest!.mode, reason: latest!.reason ?? "", fixes: latest!.fixes.length,
      stale: c.stale.has(`${ref}@${qh}`), staleActionable: c.staleActionable.has(`${ref}@${qh}`),
    };
    // Our own plain fix-up, or a base merge that left the diff the same, made the head: the review of the earlier head may carry to it.
    const ours = patch.pushes.some((e) => e.to === head && ((e.kind === "fixup" && e.source === null && e.state === "pushed") || (e.kind === "conflict" && e.state === "merged" && e.ownDiff === "same")));
    if (state === "OPEN" && head && head !== qh && ours && await carriedReview(db, { repo, number, head_oid: head }, c.stale)) base.carriable = true;
  }
  base.pushChain = chain;
  if (state === "OPEN" && (chain.length > 1 || (!!head && !!push?.pushed.has(head)))) base.inFlight = true;
  // The facts of the queue head's cached diff (src/review/diff.ts writes them with the cache); null when it is not cached.
  const dr = d.diff.get(`${ref}@${qh}`);
  const diffFacts = !dr || dr.lines === null ? null : { reasons: parseList(dr.reasons) as string[], lines: dr.lines, pending: dr.pending === 1, lastRead: dr.last_read };
  // While the extras are pending the reasons are the conservative ones, and the wait itself keeps the PR off the rule.
  base.sensitive = diffFacts ? (diffFacts.pending ? [...diffFacts.reasons, EXTRAS_PENDING_REASON] : diffFacts.reasons) : null;
  if (diffFacts?.pending) base.diffPending = { lastRead: diffFacts.lastRead };
  if (diffFacts) { base.lines = diffFacts.lines; base.size = sizeOf(diffFacts.lines); }
  const pmRow = d.review.premerge.get(`${ref}@${qh}`) ?? null;
  base.statementConflicts = statementConflicts(d, [mx ? null : latest!.conflicts, safeJson(pmRow?.conflicts)]);
  const p = d.review.posts.get(ref);
  // A carried review has no text of its own: the post uses the text of the review it was carried from.
  const src = !mx && latest!.mode === CARRIED ? await c.postSource(repo, number, qh) : null;
  const hasPublic = src ? src.hasPublic : !mx && latest!.public_summary !== null;
  const pubText = src ? src.public : !hasPublic ? { ok: true } : parsePublic({ summary: latest!.public_summary ?? "", points: [] });
  base.post = { postable: (hasPublic || !!p?.review_id) && !!pubText, posted: p ? { head: p.head, at: p.posted_at, opusAt: p.opus_at } : null };
  const cifixOf = (cfHead: string): NonNullable<PrFacts["cifix"]> => ({ ...cifixAt(patch.cifixes, cfHead, now, d.tasks), checksAt: ch?.fetched_at ?? null });
  const redNow = !!ch && ch.head_oid === head && ciOf(ch.overall) === "failure";
  // A non-take review at an earlier head while the review gate waits on red CI at the new head: the CI fix cannot start, so the contributor is asked (src/core/decide.ts unreviewedRed).
  if (!take && state === "OPEN" && head && head !== qh && base.reviewHold?.kind === "ci" && base.reviewHold.red && redNow) {
    base.ci = "failure";
    base.gateRed = true;
    base.cifix = cifixOf(head);
  }
  if (!take) return base;

  const wait = d.merge.runs.get(`${ref}@${qh}`);
  const checksHere = ch?.head_oid === qh;
  base.checksHere = checksHere;
  base.checksOpen = checksHere && ch!.state === "OPEN" && !ch!.is_draft;
  base.ci = checksHere ? ((wait?.approved.length ?? 0) > 0 ? "pending" : ciOf(ch!.overall)) : "unknown";
  base.runs = runsOf(wait, rf.ciApproved);
  // Our push to this head turned its required checks red: the CI fix works on it now, without waiting for a review of the new head.
  // A head that our own push or the review's CI gate (red CI at a new head, reviewed earlier) left red is repaired against that head.
  base.brokeByUs = push?.brokeHead === head && redNow;
  base.gateRed = !base.brokeByUs && !!base.reviewHold?.red && !!head && head !== qh && redNow;
  base.tier = tierOf(head);
  const ownHere = isOwn(i.author) && c.ownPrs.has(ref) && !!head && ownHead(head);

  const last = d.merge.attempts.get(`${ref}@${qh}`);
  // An operator's Retry after a refusal asks for another try now, without waiting for CI or the mergeable state to change.
  const retried = last?.outcome === "refused" && (d.retries.get(mergeDecisionId(repo, number, qh)) ?? "") > last.at;
  if (last && !retried) {
    base.lastMerge = { outcome: last.outcome, reason: last.reason, ci: last.ci, mergeable: last.mergeable, refusals: last.refusals };
    base.runsApprovedAfterMerge = !!wait?.approvedAt && wait.approvedAt > last.at;
  }
  const v = d.merge.verifications.get(`${ref}@${qh}`);
  base.verification = v ? { state: v.state, kind: v.kind, summary: v.summary, note: v.note } : null;
  if (!base.verification || base.verification.state === "stale") {
    base.verifyUnavailable = !pub ? PRIVATE_REASON : rf.noCi && cachedRust(repo, qh) === false ? NOT_RUST_REASON : null;
  }
  if (state === "OPEN" && base.mergeable !== "MERGEABLE" && base.mergeable !== "CONFLICTING") {
    const u = d.merge.unknown.get(ref);
    base.unknown = u && u.head === qh ? { since: u.since, reads: u.reads, rereads: u.rereads, stuck: u.stuck } : null;
  }
  if (state !== "OPEN") return base;

  if (pmRow) {
    const all = findingsOf(pmRow);
    const defects = all.filter((f) => f.severity === "defect");
    base.premerge = { at: pmRow.at, tries: pmRow.tries, hasFindings: pmRow.findings !== null, unsure: pmRow.unsure !== 0, defects: defects.length, defectsAllFixable: defects.every((f) => f.fix), fixesSafe: parseFixes(JSON.stringify(defects.map((f) => f.fix))).length === defects.length, minor: all.length - defects.length, error: pmRow.error ?? null };
    if (defects.length) base.premergeFixUsed = premergeFixUsedIn(patch.fixups);
  }
  if (base.mergeable === "CONFLICTING" && i.base_ref) {
    const bucket = conflictBucketOf(patch.conflicts, { head: qh, pushable: base.pushable }, { push: pushAllowed(base, "conflict"), comment: rf.commentApproved }, now);
    const until = bucket === "capped" ? nextUtcMidnight(now) : bucket === "ask-retry" ? conflictAskRetryAtOf(patch.conflicts, qh, now) : undefined;
    base.conflict = { bucket, base: i.base_ref, baseOk: BASE_NAME.test(i.base_ref), ...(until !== undefined ? { until } : {}) };
  }
  if (!mx && verdict === "take-fix") base.fixup = { fixes: parseFixes(JSON.stringify(latest!.fixes)).length, attempts: attemptsIn(patch.fixups), ...fixupAtHead(patch.fixups, qh, now) };
  for (const l of lintAt(qh, base.brokeByUs || base.gateRed ? head ?? qh : qh)) if (l.source !== "operator") base.lint.push(l);
  if (base.lint.length) base.inFlight = true;
  if (base.ci === "failure" || base.brokeByUs || base.gateRed) {
    const cfHead = base.brokeByUs || base.gateRed || (head && head !== qh) ? head : qh;
    base.cifix = cifixOf(cfHead ?? qh);
  }
  base.batch = d.merge.batchStates.get(`${ref}@${qh}`) ?? null;
  if (i.base_ref) base.stackedOn = (d.stacked.get(`${repo} ${i.base_ref} ${`${slugOf(repo)}`.toLowerCase()}`) ?? []).find((n) => n !== number) ?? null;
  base.baseOffDefault = !!i.base_ref && !!defaultBranch && i.base_ref !== defaultBranch;
  base.mainFix = !!i.head_ref?.startsWith(MAIN_FIX_BRANCH_PREFIX) && ownHere;
  const g = d.gates.get(ref);
  const gate = g ? { blocked: g.blocked === 1, by: g.by_login ? g.by_login.split(",") : [], readAt: g.read_at ?? "", failures: g.failures } : undefined;
  const { why, live } = changesRequestedWhy(gate, i.updated_at, d.formal.get(ref) ?? [], i.review_decision);
  if (gate && gate.failures >= GATE_FAILURES) base.gateFailureNote = failureNote(gate.failures);
  if (why) base.changesRequested = { why, live };
  return base;
}

/** The statements named by the given `conflicts` values ([{id, reason}]), one entry per id with the first reason; unknown ids and unreadable values count for nothing. */
function statementConflicts(d: PrPassData, stored: unknown[]): PrFacts["statementConflicts"] {
  const out: PrFacts["statementConflicts"] = [];
  for (const v of stored) {
    if (!Array.isArray(v)) continue;
    for (const h of v as { id?: unknown; reason?: unknown }[]) {
      if (typeof h?.id !== "number" || out.some((x) => x.id === h.id)) continue;
      const s = d.statements.get(h.id);
      if (s) out.push({ id: s.id, where: s.number === null ? s.repo : `${s.repo}#${s.number}`, text: s.text, reason: typeof h.reason === "string" ? h.reason : "" });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** True when any stored Opus review at the head (the current row or an overwritten one in the history) was a take or take-fix with sure = 0. */
export async function headWasUnsure(db: Db, repo: string, number: number, head: string): Promise<boolean> {
  return (await loadUnsureHeads(db, [{ repo, number }])).has(`${repo}#${number}@${head}`);
}

export { tierKey, tiersOf, type AuthorRef };

/** PRs the pipeline opened itself (quiet security PRs, default-branch fix PRs), as `repo#number`, and who counts as the pipeline. */
export async function ownFixPrs(db: Db, repo?: string, _slug?: string | null): Promise<{ login: string | null; prs: Set<string>; quiet: Set<string>; isOwn: (repo: string, author: string | null) => Promise<boolean> }> {
  const [own, quiet, mainFix, login] = await db.together(() => Promise.all([
    loadOwnLogins(db), listQuietPrs(db, { repo: repo }), loadMainFixPrs(db, repo ? [repo] : undefined), withConfig(db, async () => config(db).pipelineLogin),
  ]));
  return { login, prs: ownPrSet(mainFix, quiet, login), quiet, isOwn: async (_r, author) => !!author && own.has(author) };
}

/** The pipeline account and the last successful assign of every item; the returned function gives an item's assignment facts from its mirrored `assignees` (JSON). */
export async function assignmentsOf(db: Db, repo?: string): Promise<(ref: string, assignees: string | null) => AssignFacts> {
  const [last, login] = await db.together(() => Promise.all([loadAssignments(db, repo ? { repo } : {}), withConfig(db, async () => config(db).pipelineLogin)]));
  return (ref, assignees) => {
    const list = parseList(assignees).filter((x): x is string => typeof x === "string");
    const by = last.get(ref);
    // Without a recorded account, the audit's own assignee stands for it.
    return { login: login ?? by?.assignee ?? null, assignees: list, ours: by !== undefined && (login === null || by.assignee === login) };
  };
}

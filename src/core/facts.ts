// Facts: everything the review-to-merge rules read about open PRs, built for a whole pass or a slice of it from the module loads of
// core/pass-load.ts. Each concept has one definition here.
import { listQuietPrs } from "../data/security/index.ts";
import { HOLD_MAX, loadOwnLogins, permKey, standing, type ActFacts, type ActIdentity, type PermKey } from "../data/access/index.ts";
import { loadMainFixPrs, attemptsIn, conflictAskRetryAtOf, conflictBucketOf, cifixAt, fixupAtHead, lintOf, operatorTriesIn, premergeFixRunningIn, premergeFixUsedIn, pushChainOf, type PushEdge } from "../data/changes/index.ts";
import { withConfig, config } from "../data/control/index.ts";
import { loadUnsureHeads } from "../data/review/index.ts";
import { prPass } from "../data/planner/index.ts";
import type { KeySource, Ref } from "../data/keys.ts";
import { pushable, sameRepo } from "../fixup/pushable.ts";
import { ENDED_STATES, type ImplementationState } from "../implement/types.ts";
import { refereeClosed, settle } from "../classify/settled.ts";
import { MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import { changesRequestedWhy, GATE_FAILURES, failureNote } from "../merge/changes-requested.ts";
import { effectiveCiWith } from "../optional-checks.ts";
import { parseFixes } from "../fixup/candidates.ts";
import { tierKey, tiersOf, type AuthorRef } from "../whitelist.ts";
import { findingsOf } from "../premerge/store.ts";
import { parsePublic } from "../review/opus-parse.ts";
import { rereadPaceAt } from "../review/diff.ts";
import { slugOf } from "../owners.ts";
import { EXTRAS_PENDING_REASON } from "./sensitive.ts";
import { CARRIED } from "../review/carry.ts";
import { staleFrom } from "../review/discussion.ts";
import { holdsFrom, MIN_INTERVAL_KEY, minIntervalOf, nextUtcMidnight, type HoldCheck } from "../review/gate.ts";
import { NOT_RUST_REASON, PRIVATE_REASON, cachedRust } from "../verify/candidates.ts";
import { BASE_NAME, FIXUP_MAX_ATTEMPTS, MAX_FAILURES, PIPELINE_LOGIN_KEY, RULE_SIZES, mergeDecisionId, pipelineWrites, sizeOf } from "./rules.ts";
import { tripsOfRepo } from "./push-outcome.ts";
import { pushAllowed } from "./gates.ts";
import { reviewOwed } from "./evidence.ts";
import { mergeWaits, workflowGate } from "./may.ts";
import { keptFixes, settlerOf, verdictKept } from "../workflow/work.ts";
import { inStep, loadPassBase, loadPrPass, type EndWave, type PassBase, type PrPassData, type SharedDupes } from "./pass-load.ts";
import type { AssignFacts, PassFacts, PrFacts, PrTier } from "./plan.ts";
import type { Db } from "../db/index.ts";

export type { PrFacts } from "./plan.ts";

export type LoadOptions = {
  repo?: string;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The pass keys (planner.prPass / changedPass); default: `refs`, else every PR of the pass universe. */
  keys?: KeySource;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The classification run for labels (default: latestRun). */
  run?: string | null;
  /** Our logins and the run, when the caller read them. */
  base?: PassBase;
};

type Mirrored = PrPassData["mirror"] extends Map<string, infer V> ? V : never;
type DiffRow = PrPassData["diff"] extends Map<string, infer V> ? V : never;
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

/** Who an implementation runs for (settlerOf), from the pass's access rows; a confirmed write permission stops counting with the clock alone, told to `soon`. */
export function queuerIn(
  actors: readonly string[] | undefined, repo: string, o: { act: Map<PermKey, ActFacts>; identity: ActIdentity; now: number; soon: (at: number | undefined) => void },
): { queuedBy: string | null; standing: "yes" | "no" | "unknown"; boxIdentity?: boolean } {
  const s = settlerOf(actors ?? [], (login) => {
    const a = o.act.get(permKey(login, repo));
    if (a?.perm) o.soon(Date.parse(a.perm.checkedAt) + HOLD_MAX);
    return standing(a, o.identity, o.now);
  });
  return { queuedBy: s?.by ?? null, standing: s?.standing ?? "no", ...(o.identity !== "app" ? { boxIdentity: true } : {}) };
}

/** The PR's current head: checks fetched after the mirror's last update win over the mirror. */
function currentHead(m: Mirrored): string | null {
  const c = m.checks, i = m.item;
  if (c?.head_oid && c.fetched_at && (!i.updated_at || c.fetched_at > i.updated_at)) return c.head_oid;
  return i.head_oid ?? c?.head_oid ?? null;
}

/** Whether the PR is a draft, or no longer open (`gone`, which `draft` includes), as the freshest of mirror and checks says. */
export function draftOf(i: { is_draft: number | null; updated_at: string | null }, ch: { state: string | null; is_draft: number | null; fetched_at: string | null } | null | undefined): { draft: boolean; gone?: true } {
  if (!ch?.fetched_at || (i.updated_at && ch.fetched_at <= i.updated_at)) return { draft: !!i.is_draft };
  return ch.state === "OPEN" ? { draft: !!ch.is_draft } : { draft: true, gone: true };
}

/** The live workflow of the PR, or of the issue whose implementation PR it is. */
const workflowFactOf = (d: PrPassData, ref: string) => d.workflow.live.get(ref) ?? d.workflow.ofPr.get(ref) ?? null;

/** An item's assignment from its last successful assign and its mirrored `assignees` (JSON). Without a recorded account, the audit's own assignee stands for it. */
export function assignmentIn(pipelineLogin: string | null, assigned: { assignee: string | null } | undefined, assignees: string | null): AssignFacts {
  return {
    login: pipelineLogin ?? assigned?.assignee ?? null, assignees: parseList(assignees).filter((x): x is string => typeof x === "string"),
    ours: assigned !== undefined && (pipelineLogin === null || assigned.assignee === pipelineLogin),
  };
}

/** The work score of a live workflow (higher first): weight, then the older workflow. */
export const weightScore = (w: { id: number; weight: number } | null): number | null => (w ? 1e15 + w.weight * 1e12 - w.id : null);

/** Our own integration PR of a batch. */
function integrationOf(d: PrPassData, ref: string): boolean {
  const m = d.mirror.get(ref);
  return d.merge.batchPrs.has(ref) && !!m?.item.author && d.ownLogins.has(m.item.author.toLowerCase());
}

/** The head a PR's facts are about: an integration PR's is the batch tip, where the run approvals are recorded. */
const headOf = (d: PrPassData, ref: string, m: Mirrored): string | null =>
  (integrationOf(d, ref) ? d.merge.integration.get(ref)?.commitSha : undefined) ?? currentHead(m);

/** Our own plain fix-up, or a base merge that left the diff the same, made `head`. */
const madeByUs = (pushes: PushEdge[], head: string): boolean =>
  pushes.some((e) => e.to === head && ((e.kind === "fixup" && e.source === null && e.state === "pushed") || (e.kind === "conflict" && e.state === "merged" && e.ownDiff === "same")));

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
export const ownPrSet = (mainFix: Set<string>, quiet: Set<string>, login: string | null): Set<string> => (login ? new Set([...quiet, ...mainFix]) : new Set());

/** Facts of every open PR (and merged PRs with a take or take-fix review, merged by us, or of a live implementation) of the keys given. One load for all PRs. */
export async function loadPrFacts(db: Db, opts: LoadOptions = {}): Promise<PrFacts[]> {
  return await (await db.read(async () => {
    const base = opts.base ?? await loadPassBase(db, opts.run);
    return (await inStep<[FactsOf<PrFacts>]>(db, (endWave) => prFacts(db, { ...opts, base }, endWave)))[0];
  }))();
}

/** Builds the facts from rows already loaded: no statement, so a caller ends its read transaction first. */
export type FactsOf<F> = () => Promise<F[]>;

/** loadPrFacts() as one load of a group that runs in step: loads the rows and returns what builds the facts from them. */
export async function prFacts(db: Db, opts: LoadOptions & { base: PassBase; dupes?: SharedDupes }, endWave: EndWave): Promise<FactsOf<PrFacts>> {
  const now = opts.now ?? Date.now();
  const refs = opts.refs ? new Set(opts.refs) : undefined;
  const keys: KeySource = opts.keys ?? (refs ? [...refs].map(asRef) : prPass(opts.repo));
  const mergeEntryHead = (d: PrPassData, ref: string): string | null => {
    const m = d.mirror.get(ref);
    if (!m || m.item.kind !== "pr" || m.item.state !== "OPEN" || integrationOf(d, ref)) return null;
    return workflowFactOf(d, ref)?.entry === "merge" ? currentHead(m) : null;
  };
  const carryHead = (d: PrPassData, ref: string): string | null => {
    const m = d.mirror.get(ref)!, latest = d.review.latest.get(ref);
    const head = m.item.state === "OPEN" && latest ? headOf(d, ref, m) : null;
    return head && head !== latest!.head && madeByUs(d.patches.get(ref)?.pushes ?? [], head) ? head : null;
  };
  const keep = (ref: string): boolean => (!opts.repo || asRef(ref).repo === opts.repo) && (!refs || refs.has(ref));
  const rowsOf = (d: PrPassData) => {
    // In repo and number order, as the planner keeps them (plan-engine.ts byRef).
    const all = [...d.mirror].filter(([ref, m]) => keep(ref) && m.item.kind === "pr" && inUniverse(d, ref, m.item.state))
      .sort(([, { item: x }], [, { item: y }]) => (x.repo === y.repo ? x.number - y.number : x.repo < y.repo ? -1 : 1)).map(([ref]) => ref);
    return { all, scoped: all.filter((ref) => d.inScope.has(ref) && !integrationOf(d, ref)) };
  };
  // Clock-driven changes the facts below do not show as a time of their own (expiries, daily counts, cache lifetimes), per PR.
  const refresh = refreshTimes(now);
  const d = await loadPrPass(db, keys, { now, base: opts.base, repo: opts.repo, dupes: opts.dupes, mergeEntryHead, carryHead, rows: rowsOf }, endWave);
  const ownPrs = ownPrSet(d.mainFixPrs, d.quiet, d.control.settings.get(PIPELINE_LOGIN_KEY) ?? null);
  const openPrs = new Map([...d.mirror].filter(([, m]) => m.item.kind === "pr" && m.item.state === "OPEN").map(([ref, m]) => [ref, m.item] as const));
  const staleOf = (respectCap: boolean): Promise<Set<string>> => staleFrom({ facts: d.review, items: openPrs, repos: d.repos, reads: d.blockers }, respectCap, { now, refresh: refresh.soon });
  return () => withConfig(db, async () => {
    const cfg = config(db);
    const ctx: Ctx = {
      now, refresh, stale: await staleOf(false), staleActionable: await staleOf(true), ownPrs, identity: cfg.githubIdentity,
      holdOf: holdsFrom({ ...d.holds, facts: d.review, optional: (repo) => cfg.repo(repo).optionalChecks, interval: minIntervalOf(d.control.settings.get(MIN_INTERVAL_KEY)), reads: d.blockers, edges: new Map([...d.patches].map(([ref, p]) => [ref, p.pushes])) }, now),
    };
    const out: PrFacts[] = [];
    for (const ref of rowsOf(d).all) {
      const f = await buildPr(db, d, ref, d.mirror.get(ref)!, ctx);
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
}

/** Facts of one PR, or null when it is not an open PR (or a merged one with a take review). */
export async function loadPrFact(db: Db, repo: string, number: number, opts: Omit<LoadOptions, "repo" | "refs" | "keys"> = {}): Promise<PrFacts | null> {
  return (await loadPrFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
export type { PrTier };

type Ctx = {
  now: number; refresh: ReturnType<typeof refreshTimes>; stale: Set<string>; staleActionable: Set<string>; ownPrs: Set<string>; holdOf: HoldCheck; identity: ActIdentity;
};

function runsOf(w: RunApproval | undefined, ciApproved: boolean): PrFacts["runs"] {
  if (!w) return null;
  const waiting = w.runs.length + (w.reread ? 1 : 0);
  const failed = (id: number) => w.failed[String(id)] ?? 0;
  const blocked: NonNullable<PrFacts["runs"]>["blocked"] = !waiting ? null : !ciApproved ? "off" : w.runs.some((x) => failed(x.id) >= MAX_FAILURES) ? "failed"
    : !w.reread && (!w.crossRepo || !w.runs.some((x) => x.event === "pull_request")) ? "unsupported" : null;
  return { waiting, reread: w.reread, crossRepo: w.crossRepo, approvable: w.runs.filter((x) => x.event === "pull_request" && failed(x.id) < MAX_FAILURES).length, blocked };
}

async function buildPr(db: Db, d: PrPassData, ref: string, m: Mirrored, c: Ctx): Promise<PrFacts | null> {
  const { now, refresh } = c;
  const i = m.item, ch = m.checks;
  const repo = i.repo, number = i.number;
  const state = i.state as PrFacts["ghState"];
  const integration = integrationOf(d, ref);
  const itemScope = d.inScope.has(ref);
  // The queue leaves merged PRs outside the scope and our own integration PRs out.
  if (state !== "OPEN" && (!itemScope || integration)) return null;
  const cfg = config(db);
  const approvals = d.control.approvals.get(repo) ?? {};
  const repoRow = d.repos.get(repo);
  const rf: PrFacts["repoFacts"] = {
    commentApproved: !!approvals.comment, ciApproved: !!approvals.ci,
    noCi: !!d.ciSignals.get(repo)?.noCi, mainRed: d.mainRed.has(repo), fixIssueApproved: !!approvals.fixissue,
    implementOn: cfg.repo(repo).buildFeature("implement"),
  };
  const pub = repoRow?.visibility === "public";
  const defaultBranch = repoRow?.default_branch ?? null;
  const optional = cfg.repo(repo).optionalChecks;
  const ciOf = (overall: string | null | undefined): string => effectiveCiWith(optional, overall ?? "none", ch?.checks ?? null);
  const isOwn = (author: string | null): boolean => !!author && d.ownLogins.has(author.toLowerCase());
  const batchRow = integration ? d.merge.integration.get(ref) : undefined;
  const pipelineRepo = !!d.control.tracked.get(repo)?.pipeline;
  const inScope = integration ? pipelineRepo || (!!batchRow && batchRow.members.length > 0 && batchRow.members.every((x) => d.inScope.has(`${repo}#${x.number}`))) : itemScope;
  const head = headOf(d, ref, m);
  const patch = d.patches.get(ref) ?? { fixups: [], cifixes: [], conflicts: [], pushes: [] };
  const push = d.pushes.get(ref);
  const movedAt = head ? push?.movedOffAt.get(head) : undefined;
  const pushedOff = state === "OPEN" && !integration && !!head && !!movedAt && (!i.updated_at || Date.parse(i.updated_at) < Date.parse(movedAt));
  const lines = (i.additions ?? 0) + (i.deletions ?? 0);
  const wfFact = workflowFactOf(d, ref);
  const wfRow = wfFact ? d.workflowRows.get(wfFact.id) : undefined;
  const operator = d.workflow.operator.get(ref);
  const ours = d.ownPushes.get(ref) ?? [];
  const moves = ours.map(({ from, to }) => ({ from, to }));
  // A commit we pushed to a branch of our own, or our later pushes on top of one. Our commit on someone else's has a recorded parent that is neither.
  const ownHead = (h: string): boolean => pushChainOf(moves, h).some((x) => d.ownCommits.has(`${repo}@${x}`) && !moves.some((m) => m.to === x && m.from !== x));
  const assignment = assignmentIn(d.control.settings.get(PIPELINE_LOGIN_KEY) ?? null, d.assignments.get(ref), i.assignees);
  const trips: Record<string, string> = {};
  for (const [stage, t] of d.control.trips) if (t.active) trips[stage] = t.reason;
  const outsideHold = d.outsideHolds.get(ref);
  const implementation = d.implement.byPr.get(ref);
  // A merge entry's review is the one a push of ours since the approval asked for: an older review stays ignored.
  const owed = state === "OPEN" && !!head && wfFact?.entry === "merge" && reviewOwed(ours, head, wfFact.since);
  const stored = d.review.latest.get(ref);
  const latest = owed && stored && stored.at <= wfFact.since ? undefined : stored;
  const base: PrFacts = {
    repo, number, ...(pushedOff ? { pushedOff } : {}), ...(owed ? { reviewOwed: true } : {}), assignment, now, pipelineOn: pipelineWrites(d.control.settings.get("pipeline_enabled") ?? undefined),
    tripped: tripsOfRepo(trips, repo), ghState: state, head, ...draftOf(i, ch),
    author: i.author, authorIsPipeline: isOwn(i.author), tier: "not", lines, size: sizeOf(lines), label: null, needsDecisionFlag: false,
    inScope, ...(outsideHold ? { outsideHold } : {}), integration, batchPr: d.merge.batchPrs.has(ref),
    heldBacklog: !wfFact && d.workflow.ended.get(ref) === "backlog", quiet: d.quiet.has(ref), mergeHeld: d.workflow.holds.has(ref),
    score: weightScore(wfFact) ?? d.ranks.get(ref)?.score ?? null, repoFacts: rf,
    review: null, post: { postable: false, posted: null },
    checksHere: false, checksOpen: false, ci: "unknown", mergeable: i.mergeable ?? "UNKNOWN", unknown: null, runs: null,
    lastMerge: null, runsApprovedAfterMerge: false, verifyOverride: false, verification: null, verifyUnavailable: null,
    handOver: false, mergeWaiting: false,
    premerge: null, premergeFixUsed: false, sensitive: null, statementConflicts: [], pushable: false, pushChain: [], conflict: null, inActiveBatch: d.merge.activeBatched.has(ref),
    fixup: null, lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false, changesRequested: null, gateFailureNote: null,
    may: { repoMerge: approvals.merge ?? null, repoPush: approvals.push ?? null, workflow: workflowGate(wfRow, { fixupAsked: (operator?.requests.length ?? 0) > 0, legs: operator?.legs ?? [] }), ended: d.workflow.ended.get(ref) ?? null, pushes: moves, ownHead: !!head && ownHead(head),
      fixupBy: (head ? operator?.requests.findLast((r) => r.from_head === head)?.by : undefined) ?? null },
  };
  base.inFlight = state === "OPEN" && !integration && isOwn(i.author) && c.ownPrs.has(ref);
  base.implementation = implementation ? { issue: implementation.issue, state: implementation.state, revisedHeads: implementation.revisedHeads,
    ...queuerIn(d.workflow.actors.get(d.workflow.ofPr.get(ref)?.id ?? -1), repo, { act: d.act, identity: c.identity, now, soon: (at) => refresh.soon(ref, at) }) } : null;
  base.workflow = wfFact;
  base.endedWorkflow = d.workflow.ended.get(ref) ?? null;
  if (integration) {
    // The batch tip's run approvals count only while the batch is open and every member keeps its take review, or its approval for merge with a clean pre-merge review, at its batched head.
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

  const duplicates = state === "OPEN" ? d.duplicates.get(ref) : undefined;
  if (duplicates) base.duplicates = duplicates;
  const ownDiff = state === "OPEN" && head ? diffFactsOf(d.diff.get(`${ref}@${head}`)) : null;
  if (ownDiff && !ownDiff.pending) {
    const size = sizeOf(ownDiff.lines);
    const out = [...(RULE_SIZES.includes(size) ? [] : [`size ${size}`]), ...ownDiff.reasons];
    if (out.length) base.ruledOut = out;
  }
  const s = d.settled.get(ref) ?? settle(null, null);
  base.label = s.label ?? null;
  base.needsDecisionFlag = s.flags.includes("needs decision");
  base.labelUnsure = s.status === "settled" && !!s.referee && !s.referee.sure && refereeClosed(s.referee);
  const tierOf = (h: string | null): PrTier => {
    const t = (i.author ? d.tiers.get(tierKey({ login: i.author, id: i.author_id ?? null })) : undefined) ?? "not";
    // The pipeline's own fix PRs count as whitelisted at a head the pipeline itself pushed (others may push to the branch); an operator's deny still wins.
    return t === "not" && isOwn(i.author) && c.ownPrs.has(ref) && !!h && ownHead(h) ? "whitelisted" : t;
  };
  base.tier = tierOf(head);
  const pm = d.merge.merged.get(ref);
  if (pm) base.postmerge = { mergedAt: pm.firstAt, head: pm.lastHead, since: d.control.settings.get("postmerge_since") ?? "9999", review: d.review.postmerge.get(ref) ?? null };
  const mxh = state === "OPEN" && wfFact?.entry === "merge" && !owed ? head : null;
  // Checks describe the PR when they were fetched for the reviewed head (or, without a review, the current one).
  const checksAtHead = ch?.head_oid === (mxh ?? latest?.head ?? head);
  base.mergeable = (checksAtHead ? ch?.mergeable : i.mergeable) ?? "UNKNOWN";
  // An author whose permission has not been read yet counts as able to write: the job that pushes reads it first.
  base.pushable = pushable(i.head_repo, repo, checksAtHead ? ch?.maintainer_can_modify : i.maintainer_can_modify, i.head_ref, d.longLived(repo), false,
    sameRepo(i.head_repo, repo) && d.authorWrites(repo, { author: i.author, author_type: i.author_type, author_id: i.author_id ?? null }, (t) => refresh.soon(ref, t)) !== "no");
  if (operator && state === "OPEN") {
    const legs = operator.legs;
    // A request counts only while GitHub confirmed its maker's write permission within HOLD_MAX, which ends with the clock alone.
    for (const r of operator.requests) if (r.maker_checked_at) refresh.soon(ref, Date.parse(r.maker_checked_at) + HOLD_MAX);
    base.operator = {
      fix: !!head && operator.requests.some((r) => r.from_head === head) ? { attempts: operatorTriesIn(patch.fixups) } : null,
      hold: legs.some((l) => l.state !== "queued"), premerge: !!head && legs.some((l) => l.state === "ci" && l.head === head),
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
  // The merge queue's operator path: the approved workflow's leg handed the PR over at this head (moveLegs sets `updated_at`).
  const handed = wfRow && (wfRow.approvedBy !== null || wfRow.entry === "merge") ? operator?.legs.find((l) => l.state === "queued" && l.head === qh && l.workflow_id === wfRow.id) : undefined;
  base.handOver = handed !== undefined;
  base.mergeWaiting = mergeWaits(d.mergeActions.get(ref), wfRow, qh);
  // A hold or close review that the leg went on past is one the person answered after (src/preapproval accepted): it counts as a take.
  const wentOn = !mx && (latest!.verdict === "hold" || latest!.verdict === "close") && !!wfRow
    && !!operator?.legs.some((l) => (l.state === "ci" || l.state === "queued") && l.head === qh && l.workflow_id === wfRow.id && l.updated_at > latest!.at);
  const fixes = latest ? keptFixes(latest.fixes, wfFact?.dropped) : [];
  const verdict = wentOn ? "take" : latest && verdictKept(latest.verdict, latest.fixes, wfFact?.dropped);

  const take = mx || verdict === "take" || verdict === "take-fix";
  const chain = take ? pushChainOf(patch.pushes, qh) : [qh];
  if (!mx) {
    const unsure = take && (!latest!.sure || chain.some((h) => d.review.unsureHeads.has(`${ref}@${h}`)));
    base.review = {
      head: qh, at: qAt, verdict: verdict!, unsure, mode: latest!.mode, reason: latest!.reason ?? "", fixes: fixes.length,
      stale: c.stale.has(`${ref}@${qh}`), staleActionable: c.staleActionable.has(`${ref}@${qh}`),
    };
    // A stale review does not carry: it has not read the discussion as it is now.
    const carried = d.carried.get(ref);
    if (carried && head !== qh && !c.stale.has(`${ref}@${carried.from}`)) base.carriable = true;
  }
  base.pushChain = chain;
  if (state === "OPEN" && (chain.length > 1 || (!!head && !!push?.pushed.has(head)))) base.inFlight = true;
  // The facts of the queue head's cached diff (src/review/diff.ts writes them with the cache); null when it is not cached.
  const diffFacts = diffFactsOf(d.diff.get(`${ref}@${qh}`));
  // While the extras are pending the reasons are the conservative ones, and the wait itself keeps the PR off the rule.
  base.sensitive = diffFacts ? (diffFacts.pending ? [...diffFacts.reasons, EXTRAS_PENDING_REASON] : diffFacts.reasons) : null;
  if (diffFacts?.pending) base.diffPending = { lastRead: diffFacts.lastRead };
  if (diffFacts) { base.lines = diffFacts.lines; base.size = sizeOf(diffFacts.lines); }
  const pmRow = d.review.premerge.get(`${ref}@${qh}`) ?? null;
  base.statementConflicts = statementConflicts(d, [mx ? null : latest!.conflicts, safeJson(pmRow?.conflicts)]);
  const p = d.review.posts.get(ref);
  // A carried review has no text of its own: the post uses the text of the review it was carried from.
  const src = !mx && latest!.mode === CARRIED ? await d.postSource(repo, number, qh) : null;
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
  // An operator's Retry after a refusal, or a hand-over after it (a person answered), asks for another try now, without waiting for CI or the mergeable state to change.
  const retried = last?.outcome === "refused" && ((d.retries.get(mergeDecisionId(repo, number, qh)) ?? "") > last.at || (!!handed && handed.updated_at > last.at));
  if (last && !retried) {
    base.lastMerge = { outcome: last.outcome, reason: last.reason, ci: last.ci, mergeable: last.mergeable, refusals: last.refusals };
    base.runsApprovedAfterMerge = !!wait?.approvedAt && wait.approvedAt > last.at;
  }
  const v = d.merge.verifications.get(`${ref}@${qh}`);
  base.verification = v ? { state: v.state, kind: v.kind, summary: v.summary, note: v.note } : null;
  // The leg went to the queue over this result: the person had seen it when they answered (src/preapproval handOver).
  base.verifyOverride = !!handed && !!v?.finishedAt && (v.state === "failed" || v.state === "error") && v.finishedAt <= handed.updated_at;
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
    if (defects.length) {
      base.premergeFixUsed = premergeFixUsedIn(patch.fixups);
      if (premergeFixRunningIn(patch.fixups, qh, pushedOff)) base.premergeFixRunning = true;
    }
  }
  if (base.mergeable === "CONFLICTING" && i.base_ref) {
    const bucket = conflictBucketOf(patch.conflicts, { head: qh, pushable: base.pushable }, { push: pushAllowed(base, "conflict"), comment: rf.commentApproved }, now);
    const until = bucket === "capped" ? nextUtcMidnight(now) : bucket === "ask-retry" ? conflictAskRetryAtOf(patch.conflicts, qh, now) : undefined;
    base.conflict = { bucket, base: i.base_ref, baseOk: BASE_NAME.test(i.base_ref), ...(until !== undefined ? { until } : {}) };
  }
  if (!mx && verdict === "take-fix") base.fixup = { fixes: parseFixes(JSON.stringify(fixes)).length, attempts: attemptsIn(patch.fixups), ...fixupAtHead(patch.fixups, qh, now) };
  for (const l of lintAt(qh, base.brokeByUs || base.gateRed ? head ?? qh : qh)) if (l.source === "review" || l.source === "premerge") base.lint.push({ ...l, source: l.source });
  if (base.lint.length) base.inFlight = true;
  if (base.ci === "failure" || base.brokeByUs || base.gateRed) {
    const cfHead = base.brokeByUs || base.gateRed || (head && head !== qh) ? head : qh;
    base.cifix = cifixOf(cfHead ?? qh);
  }
  base.batch = d.merge.batchStates.get(`${ref}@${qh}`) ?? null;
  base.baseOffDefault = !!i.base_ref && !!defaultBranch && i.base_ref !== defaultBranch;
  base.mainFix = !!i.head_ref?.startsWith(MAIN_FIX_BRANCH_PREFIX) && ownHere;
  const g = d.gates.get(ref);
  const gate = g ? { blocked: g.blocked === 1, by: g.by_login ? g.by_login.split(",") : [], readAt: g.read_at ?? "", failures: g.failures } : undefined;
  const { why, live } = changesRequestedWhy(gate, i.updated_at, d.formal.get(ref) ?? [], i.review_decision);
  if (gate && gate.failures >= GATE_FAILURES) base.gateFailureNote = failureNote(gate.failures);
  if (why) base.changesRequested = { why, live };
  return base;
}

/** A head's stored diff facts; null when its diff is not cached. */
const diffFactsOf = (r: DiffRow | undefined): { reasons: string[]; lines: number; pending: boolean; lastRead: number | null } | null =>
  !r || r.lines === null ? null : { reasons: parseList(r.reasons) as string[], lines: r.lines, pending: r.pending === 1, lastRead: r.last_read };

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
  return { login, prs: ownPrSet(mainFix, quiet, login), quiet, isOwn: async (_r, author) => !!author && own.has(author.toLowerCase()) };
}

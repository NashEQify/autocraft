// The planner pass's inputs: every module's set loader for the pass keys, loaded inside one read snapshot. The first wave
// carries every loader keyed by the pass keys; the second only what needs the first one's rows (task states of stored patches,
// our own commits on the push chains, stacked heads, operators' retries of refused merges, the pre-merge rows of merge-entry heads,
// labels, author tiers and blockers); the third the owner statements the reviews name, and only when one does. The PR load and the
// item load of a pass run in step, so their waves share round trips.
import type { Db } from "../db/index.ts";
import type { KeySource, Ref } from "../data/keys.ts";
import { loadActFacts, loadOwnLogins, type ActFacts, type PermKey } from "../data/access/index.ts";
import { loadTaskStates } from "../data/build/index.ts";
import { loadMainFixPrs, loadPatchFacts, pushChainOf, type PatchFacts, type TaskStates } from "../data/changes/index.ts";
import { loadAssignments, loadAuditMax, loadControl, loadOwnCommits, loadPushFacts, type ControlSnapshot, type PushFacts } from "../data/control/index.ts";
import { loadStatements, type Statement } from "../data/conversations/index.ts";
import { loadImplementFacts, type ImplementFacts } from "../data/implement/index.ts";
import { loadHolds as loadOutsideHolds, type HoldInfo } from "../data/intake/index.ts";
import { loadMergeFacts, loadOwnIntegration, type MergeFacts } from "../data/merge/index.ts";
import {
  loadAuthorPermissions, loadComments, loadDiffFacts, loadFormalReviews, loadGates, loadItems, loadItemsWithHashes, loadOpenPrLinks, loadPrMirror, loadRepoCiSignals, loadRepos, loadStackedHeads,
  type DiffFactsRow, type Gate, type PrMirror, type RepoCiSignals, type RepoRow, type ReviewFact,
} from "../data/mirror/index.ts";
import type { CommentOut, ItemHashes, ItemOf, OpenPrRow } from "../data/mirror/types.ts";
import { loadStageFacts, type StageFacts } from "../data/planner/index.ts";
import { loadPremerge, loadReviewFacts, type ReviewFacts } from "../data/review/index.ts";
import { listQuietPrs } from "../data/security/index.ts";
import { classifyRun, loadDupeState, loadSettled, loadRanks, loadTriageFacts, prDuplicates, type DupeState, type PrDuplicates, type RankRow, type TriageFactsResult } from "../data/triage/index.ts";
import { listWorkflows, loadActions, loadActionsDue, loadInScope, loadWorkflowFacts, type DueAction, type WorkflowAction, type WorkflowPassFacts } from "../data/workflow/index.ts";
import type { ItemWorkflow } from "../workflow/types.ts";
import { ACTION_WAITS } from "./may.ts";
import { mergeDecisionId, PIPELINE_LOGIN_KEY } from "./rules.ts";
import { authorWritesIn } from "../fixup/author-permission.ts";
import { longLivedAll } from "../fixup/pushable.ts";
import type { Settled } from "../classify/settled.ts";
import { redMainRepos } from "../mainci/index.ts";
import { loadBlockerReads, type BlockerReads } from "../review/blockers.ts";
import { CARRIED } from "../review/carry.ts";
import { loadHoldInputs } from "../review/gate.ts";
import { postSourcesOf } from "../review/post-source.ts";
import { tiersOf } from "../whitelist.ts";

type RefKey = `${string}#${number}` | string;

export type PrPassData = {
  now: number;
  control: ControlSnapshot;
  mirror: Map<RefKey, PrMirror>;
  repos: Map<string, RepoRow>;
  ciSignals: Map<string, RepoCiSignals>;
  /** Diff facts keyed "repo#number@head", every head stored for the keyed PRs. */
  diff: Map<string, DiffFactsRow>;
  formal: Map<RefKey, ReviewFact[]>;
  gates: Map<RefKey, Gate>;
  ranks: Map<RefKey, RankRow>;
  /** The open PRs that duplicate another open or merged one. */
  duplicates: Map<RefKey, PrDuplicates>;
  merge: MergeFacts;
  patches: Map<RefKey, PatchFacts>;
  pushes: Map<RefKey, PushFacts>;
  mainFixPrs: Set<RefKey>;
  workflow: WorkflowPassFacts;
  /** Live workflow rows by id: the approval inputs `mayMerge` and `mayPush` read (base head, blocker, approval time). */
  workflowRows: Map<number, ItemWorkflow>;
  implement: ImplementFacts;
  review: ReviewFacts;
  assignments: Map<string, { assignee: string | null; run: string | null }>;
  outsideHolds: Map<RefKey, HoldInfo>;
  ownLogins: Set<string>;
  /** In-scope PRs (the workflow scope fragment). */
  inScope: Set<RefKey>;
  /** Merges that wait for their person's sign-in or access. */
  mergeActions: Map<RefKey, WorkflowAction[]>;
  tasks: TaskStates;
  /** Our own commits on the loaded PRs' push chains, keyed "repo@sha". */
  ownCommits: Set<string>;
  stacked: Map<string, number[]>;
  statements: Map<number, Statement>;
  /** An operator's latest Retry of a refused merge, by the retry target of the queue head (`mergeDecisionId`). */
  retries: Map<string, string>;
  /** Repos whose default branch is red. */
  mainRed: Set<string>;
  quiet: Set<string>;
  longLived: Awaited<ReturnType<typeof longLivedAll>>;
  authorWrites: ReturnType<typeof authorWritesIn>;
  holds: Awaited<ReturnType<typeof loadHoldInputs>>;
  /** The items the latest reviews of the open PRs name as blocking. */
  blockers: BlockerReads;
  /** Labels of the PRs in scope; an absent one is unclassified. */
  settled: Map<RefKey, Settled>;
  /** Tiers of the authors of the PRs in scope. */
  tiers: Awaited<ReturnType<typeof tiersOf>>;
  postSource: Awaited<ReturnType<typeof postSourcesOf>>;
};

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const asRef = (key: RefKey): Ref => { const i = key.lastIndexOf("#"); return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) }; };

/** The ids of the stored patches' tasks (lint tasks and CI-fix formatter tasks): their states decide `lint[].ended` and `formatterEnded`. */
function patchTaskIds(patches: Map<RefKey, PatchFacts>): number[] {
  const ids = new Set<number>();
  for (const p of patches.values()) {
    for (const r of p.fixups) if (r.lintTask !== null) ids.add(r.lintTask);
    for (const r of p.conflicts) if (r.lintTask !== null) ids.add(r.lintTask);
    for (const r of p.cifixes) { if (r.lintTask !== null) ids.add(r.lintTask); if (r.taskId !== null) ids.add(r.taskId); }
  }
  return [...ids];
}

/** The owner statement ids that stored reviews and pre-merge reviews name in their `conflicts`. */
function statementIds(review: ReviewFacts, more: Iterable<ReviewFacts["premerge"]>): number[] {
  const ids = new Set<number>();
  const add = (v: unknown) => { if (Array.isArray(v)) for (const h of v as { id?: unknown }[]) if (typeof h?.id === "number") ids.add(h.id); };
  for (const r of review.latest.values()) add(r.conflicts);
  for (const m of [review.premerge, ...more]) for (const p of m.values()) { try { add(JSON.parse(p.conflicts ?? "null")); } catch { /* unreadable: names nothing */ } }
  return [...ids];
}

/** A load's end of a wave (inStep): resolves once every load of the group ended it. */
export type EndWave = () => Promise<void>;

/**
 * Runs the loads of one unit in step in one read snapshot: each calls `endWave` between two waves, and the next wave of one goes out
 * with the next wave of the others, so their reads share round trips.
 */
export async function inStep<T extends readonly unknown[]>(db: Db, ...loads: { [K in keyof T]: (endWave: EndWave) => Promise<T[K]> }): Promise<T> {
  let running = loads.length;
  let waiting: (() => void)[] = [];
  const release = (): void => {
    if (waiting.length < running) return;
    const all = waiting;
    waiting = [];
    for (const go of all) go();
  };
  const endWave: EndWave = () => new Promise((go) => { waiting.push(go); release(); });
  const run = async <R>(load: (endWave: EndWave) => Promise<R>): Promise<R> => {
    try { return await load(endWave); } finally { running--; release(); }
  };
  return await db.read(async () => await db.together(async () => await Promise.all(loads.map((l) => run(l as (e: EndWave) => Promise<unknown>))))) as unknown as T;
}

/** What every fact load of a pass reads first: our logins and the classification run. */
export type PassBase = { own: Set<string>; run: string | null };

/** The duplicate state of a pass whose PR and item loads both read it: one read, sent with the first wave that asks for it. */
export type SharedDupes = () => Promise<DupeState>;

export function sharedDupes(db: Db): SharedDupes {
  let state: Promise<DupeState> | undefined;
  return () => (state ??= loadDupeState(db));
}

export async function loadPassBase(db: Db, run?: string | null): Promise<PassBase> {
  const [own, r] = await db.together(() => Promise.all([loadOwnLogins(db), run !== undefined ? run : classifyRun(db)]));
  return { own, run: r };
}

/** The repos of a key list; undefined for other key sources. */
const reposOf = (keys: KeySource): string[] | undefined => (Array.isArray(keys) ? [...new Set((keys as Ref[]).map((k) => k.repo))] : undefined);

export type PrPassOptions = {
  now: number; base: PassBase;
  /** Narrows the loads that are not keyed. */
  repo?: string | undefined;
  dupes?: SharedDupes | undefined;
  /** From the loaded rows, the PR's current head when its live workflow's entry is merge: its pre-merge rows are read there. */
  mergeEntryHead: (d: PrPassData, key: RefKey) => string | null;
  /** From the loaded rows, the PRs whose facts are built, and of those the ones in scope (they alone need an author tier and a label). */
  rows: (d: PrPassData) => { all: RefKey[]; scoped: RefKey[] };
};

/** Loads the PR facts inputs of `keys`, in step with the pass's other loads. */
export async function loadPrPass(db: Db, keys: KeySource, o: PrPassOptions, endWave: EndWave): Promise<PrPassData> {
  const own = [...o.base.own];
  const keyRepos = reposOf(keys);
  const dupeRepo = o.repo ?? (keyRepos?.length === 1 ? keyRepos[0] : undefined);
  const [control, mirror, repos, ciSignals, diff, formal, gates, ranks, dupes, merge, patches, pushes, mainFixPrs, workflow, live, implement, review, assignments, outsideHolds, scoped, mergeActions, mainRed, quiet, longLived, authorPerms, holds] =
    await Promise.all([
      loadControl(db), loadPrMirror(db, keys), loadRepos(db, { all: true }), loadRepoCiSignals(db), loadDiffFacts(db, keys),
      loadFormalReviews(db, keys), loadGates(db, keys), loadRanks(db, keys), o.dupes?.() ?? loadDupeState(db, dupeRepo ? { repo: dupeRepo } : {}), loadMergeFacts(db, keys), loadPatchFacts(db, keys), loadPushFacts(db, keys),
      loadMainFixPrs(db), loadWorkflowFacts(db, keys, { nowMs: o.now }), listWorkflows(db, { live: true }), loadImplementFacts(db, keys),
      loadReviewFacts(db, keys, { now: o.now, own }), loadAssignments(db, {}), loadOutsideHolds(db, keys),
      loadInScope(db, keys), loadActions(db, { kinds: ["merge"], states: ACTION_WAITS }),
      redMainRepos(db), listQuietPrs(db, { repo: o.repo }), longLivedAll(db, keyRepos), loadAuthorPermissions(db), loadHoldInputs(db, keys, o.now),
    ]);
  const data: PrPassData = {
    now: o.now, control, mirror, repos, ciSignals, diff, formal, gates, ranks, duplicates: prDuplicates(dupes), merge, patches, pushes, mainFixPrs, workflow,
    workflowRows: new Map(live.map((w) => [w.id, w])), implement, review, assignments, outsideHolds, ownLogins: o.base.own,
    inScope: scoped, mergeActions, mainRed, quiet, longLived, authorWrites: authorWritesIn(control.settings.get(PIPELINE_LOGIN_KEY), authorPerms, o.now), holds,
    tasks: new Map(), ownCommits: new Set(), stacked: new Map(), statements: new Map(), retries: new Map(),
    settled: new Map(), tiers: new Map(), postSource: async () => null, blockers: { item: new Map(), pending: new Set(), latest: new Map() },
  };
  await endWave();

  const pairs: { repo: string; sha: string }[] = [];
  const entryHeads: { repo: string; number: number; head: string }[] = [];
  const retryTargets: string[] = [];
  for (const [key, m] of mirror) {
    const { repo, number } = asRef(key);
    const head = m.item.head_oid;
    const moves = [...(patches.get(key)?.pushes ?? []), ...(pushes.get(key)?.moves ?? [])];
    if (head) for (const h of pushChainOf(moves, head)) pairs.push({ repo, sha: h });
    const latest = review.latest.get(key);
    if (latest) for (const h of pushChainOf(moves, latest.head)) pairs.push({ repo, sha: h });
    const eh = o.mergeEntryHead(data, key);
    if (eh) entryHeads.push({ repo, number, head: eh });
    const qh = eh ?? latest?.head;
    if (qh && merge.attempts.get(`${key}@${qh}`)?.outcome === "refused") retryTargets.push(mergeDecisionId(repo, number, qh));
  }
  // Members of an integration PR's batch decide its scope; a ref list of keys may leave them out.
  const members = [...merge.integration.values()].flatMap((b) => b.members.map((m) => ({ repo: b.repo, number: m.number }))).filter((m) => !mirror.has(refKey(m.repo, m.number)));
  const rows = o.rows(data);
  const blockers = new Set<string>();
  for (const [key, r] of review.latest) if (mirror.get(key)?.item.state === "OPEN") for (const b of r.blocked_by) blockers.add(b);
  const authors = rows.scoped.flatMap((key) => { const i = mirror.get(key)!.item; return i.author ? [{ login: i.author, id: i.author_id ?? null }] : []; });
  const [tasks, ownCommits, stacked, retries, premerge, membersInScope, settled, tiers, postSource, reads] = await Promise.all([
    loadTaskStates(db, patchTaskIds(patches)), loadOwnCommits(db, pairs), loadStackedHeads(db, [...new Set([...mirror.values()].map((m) => m.item.repo))]),
    retryTargets.length ? loadAuditMax(db, "retry", retryTargets) : Promise.resolve(new Map<string, string>()),
    loadPremerge(db, entryHeads), loadInScope(db, members), loadSettled(db, rows.scoped.map(asRef), o.base.run), tiersOf(db, authors),
    postSourcesOf(db, rows.all.filter((key) => review.latest.get(key)?.mode === CARRIED)), loadBlockerReads(db, blockers),
  ]);
  for (const k of membersInScope) data.inScope.add(k);
  Object.assign(data, { tasks, ownCommits, stacked, retries, settled, tiers, postSource, blockers: reads });
  for (const [k, v] of premerge) data.review.premerge.set(k, v);
  await endWave();

  const ids = statementIds(data.review, []);
  if (ids.length) data.statements = await loadStatements(db, ids);
  return data;
}

/** The issue and PR triage inputs of the pass keys (core/issue-facts.ts). `items` holds the keys' mirror rows, open or not. */
export type ItemPassData = {
  now: number;
  run: string | null;
  control: ControlSnapshot;
  items: Map<RefKey, ItemOf<"card"> & ItemHashes>;
  triage: TriageFactsResult;
  outsideHolds: Map<RefKey, HoldInfo>;
  stages: Map<RefKey, StageFacts>;
  workflow: WorkflowPassFacts;
  implement: ImplementFacts;
  /** In-scope items of the pass keys (the workflow scope fragment). */
  inScope: Set<RefKey>;
  ownLogins: Set<string>;
  quiet: Set<string>;
  mainFixPrs: Set<RefKey>;
  /** Integration PRs of merge batches (any author). */
  batchPrs: Set<RefKey>;
  assignments: Map<string, { assignee: string | null; run: string | null }>;
  repos: Map<string, RepoRow>;
  openPrs: OpenPrRow[];
  /** The closes people commanded that are due, by item. */
  closes: Map<RefKey, DueAction>;
  /** Second wave: the text of the items `needs` named. */
  texts: Map<RefKey, ItemOf<"text">>;
  /** Second wave: mirror state of the PRs `needs` named. */
  prs: Map<RefKey, ItemOf<"pr">>;
  /** Second wave: comments created after the earliest `asked` time, of the items asked. */
  comments: Map<RefKey, CommentOut[]>;
  /** Second wave: role and cached permission of each login on a repo `needs` named. */
  act: Map<PermKey, ActFacts>;
};

/** What the second wave reads, named from the first wave's rows. */
export type ItemPassNeeds = { texts: Ref[]; prs: Ref[]; asked: { ref: Ref; since: string }[]; logins: { login: string; repo: string }[] };

/**
 * Loads the item facts inputs of `keys`, in step with the pass's other loads: one wave keyed by the pass keys, then one for what
 * `needs` names from its rows (texts, implementation PRs, comments after a question, the people who started work). `repo` narrows the
 * loaders that are not keyed.
 */
export async function loadItemPass(db: Db, keys: KeySource, o: { now: number; base: PassBase; model: string; repo?: string | undefined; dupes?: SharedDupes | undefined; needs: (d: ItemPassData) => ItemPassNeeds }, endWave: EndWave): Promise<ItemPassData> {
  const repos = o.repo ? [o.repo] : undefined;
  const [control, items, triage, outsideHolds, stages, workflow, implement, scoped, quiet, mainFixPrs, batchPrs, assignments, repoRows, openPrs, due] =
    await Promise.all([
      loadControl(db), loadItemsWithHashes(db, keys), loadTriageFacts(db, keys, { model: o.model, run: o.base.run, nowMs: o.now, dupes: o.dupes }), loadOutsideHolds(db, keys),
      loadStageFacts(db, keys), loadWorkflowFacts(db, keys, { nowMs: o.now }), loadImplementFacts(db, keys),
      loadInScope(db, keys),
      listQuietPrs(db, { repo: o.repo }), loadMainFixPrs(db, repos), loadOwnIntegration(db, repos),
      loadAssignments(db, o.repo ? { repo: o.repo } : {}), loadRepos(db, { all: true }), loadOpenPrLinks(db, repos ?? reposOf(keys)),
      loadActionsDue(db, { kinds: ["close", "comment-close"], ...(repos && { repos }) }),
    ]);
  const data: ItemPassData = {
    now: o.now, run: o.base.run, control, items, triage, outsideHolds, stages, workflow, implement, inScope: scoped,
    ownLogins: o.base.own, quiet, mainFixPrs, batchPrs, assignments, repos: repoRows, openPrs, closes: new Map(due.map((a) => [refKey(a.repo, a.number), a])),
    texts: new Map(), prs: new Map(), comments: new Map(), act: new Map(),
  };
  await endWave();
  const n = o.needs(data);
  const after = n.asked.reduce<string | null>((m, a) => (m === null || a.since < m ? a.since : m), null);
  const [texts, prs, comments, act] = await Promise.all([
    n.texts.length ? loadItems(db, n.texts, "text") : Promise.resolve(new Map<RefKey, ItemOf<"text">>()),
    n.prs.length ? loadItems(db, n.prs, "pr") : Promise.resolve(new Map<RefKey, ItemOf<"pr">>()),
    after !== null ? loadComments(db, n.asked.map((a) => a.ref), { after, order: "rowid" }) : Promise.resolve(new Map<RefKey, CommentOut[]>()),
    n.logins.length ? loadActFacts(db, n.logins) : Promise.resolve(new Map<PermKey, ActFacts>()),
  ]);
  Object.assign(data, { texts, prs, comments, act });
  return data;
}

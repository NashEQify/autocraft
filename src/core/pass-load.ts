// The planner pass's PR inputs: every module's set loader for the pass keys, loaded inside one read snapshot. The first wave
// carries every loader keyed by the pass keys; the second only what needs the first one's rows (task states of stored patches,
// our own commits on the push chains, stacked heads, operators' retries of refused merges, the pre-merge rows of merge-entry heads); the third the owner statements
// the reviews name, and only when one does.
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
  loadComments, loadDiffFacts, loadFormalReviews, loadGates, loadItems, loadItemsWithHashes, loadOpenPrLinks, loadPrMirror, loadRepoCiSignals, loadRepos, loadStackedHeads,
  type DiffFactsRow, type Gate, type PrMirror, type RepoCiSignals, type RepoRow, type ReviewFact,
} from "../data/mirror/index.ts";
import type { CommentOut, ItemHashes, ItemOf, OpenPrRow } from "../data/mirror/types.ts";
import { loadStageFacts, type StageFacts } from "../data/planner/index.ts";
import { loadReviewFacts, type ReviewFacts } from "../data/review/index.ts";
import { listQuietPrs } from "../data/security/index.ts";
import { loadRanks, loadTriageFacts, type RankRow, type TriageFactsResult } from "../data/triage/index.ts";
import { listWorkflows, loadActions, loadActionsDue, loadInScope, loadWorkflowFacts, type DueAction, type WorkflowAction, type WorkflowPassFacts } from "../data/workflow/index.ts";
import type { ItemWorkflow } from "../workflow/types.ts";
import { ACTION_WAITS } from "./may.ts";
import { mergeDecisionId } from "./rules.ts";

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

/**
 * Loads the PR facts inputs of `keys` in one read snapshot. `mergeEntryHead` names, from the loaded rows, the PRs whose queue head is
 * their current head (a live merge-entry workflow): their pre-merge rows at that head are read in the second wave.
 */
export async function loadPrPass(db: Db, keys: KeySource, o: { now: number; mergeEntryHead: (d: PrPassData, key: RefKey) => string | null }): Promise<PrPassData> {
  return await db.read(async () => {
    const [control, mirror, repos, ciSignals, diff, formal, gates, ranks, merge, patches, pushes, mainFixPrs, workflow, live, implement, review, assignments, outsideHolds, ownLogins, scoped, mergeActions] =
      await db.together(() => Promise.all([
        loadControl(db), loadPrMirror(db, keys), loadRepos(db, { all: true }), loadRepoCiSignals(db), loadDiffFacts(db, keys),
        loadFormalReviews(db, keys), loadGates(db, keys), loadRanks(db, keys), loadMergeFacts(db, keys), loadPatchFacts(db, keys), loadPushFacts(db, keys),
        loadMainFixPrs(db), loadWorkflowFacts(db, keys, { nowMs: o.now }), listWorkflows(db, { live: true }), loadImplementFacts(db, keys),
        loadReviewFacts(db, keys, { now: o.now }), loadAssignments(db, {}), loadOutsideHolds(db, keys), loadOwnLogins(db),
        loadInScope(db, keys), loadActions(db, { kinds: ["merge"], states: ACTION_WAITS }),
      ]));
    const data: PrPassData = {
      now: o.now, control, mirror, repos, ciSignals, diff, formal, gates, ranks, merge, patches, pushes, mainFixPrs, workflow,
      workflowRows: new Map(live.map((w) => [w.id, w])), implement, review, assignments, outsideHolds, ownLogins,
      inScope: scoped, mergeActions, tasks: new Map(), ownCommits: new Set(), stacked: new Map(), statements: new Map(), retries: new Map(),
    };

    const pairs: { repo: string; sha: string }[] = [];
    const entryHeads: { repo: string; number: number; head: string }[] = [];
    const retryTargets: string[] = [];
    for (const [key, m] of mirror) {
      const { repo, number } = asRef(key);
      const head = m.item.head_oid;
      if (head) for (const h of pushChainOf(patches.get(key)?.pushes ?? [], head)) pairs.push({ repo, sha: h });
      const latest = review.latest.get(key);
      if (latest) for (const h of pushChainOf(patches.get(key)?.pushes ?? [], latest.head)) pairs.push({ repo, sha: h });
      const eh = o.mergeEntryHead(data, key);
      if (eh) entryHeads.push({ repo, number, head: eh });
      const qh = eh ?? latest?.head;
      if (qh && merge.attempts.get(`${key}@${qh}`)?.outcome === "refused") retryTargets.push(mergeDecisionId(repo, number, qh));
    }
    // Members of an integration PR's batch decide its scope; a ref list of keys may leave them out.
    const members = [...merge.integration.values()].flatMap((b) => b.members.map((m) => ({ repo: b.repo, number: m.number }))).filter((m) => !mirror.has(refKey(m.repo, m.number)));
    const [tasks, ownCommits, stacked, retries, entryReview, membersInScope] = await db.together(() => Promise.all([
      loadTaskStates(db, patchTaskIds(patches)), loadOwnCommits(db, pairs), loadStackedHeads(db, [...new Set([...mirror.values()].map((m) => m.item.repo))]),
      retryTargets.length ? loadAuditMax(db, "retry", retryTargets) : Promise.resolve(new Map<string, string>()),
      entryHeads.length ? loadReviewFacts(db, entryHeads.map((h) => ({ repo: h.repo, number: h.number })), { now: o.now, own: [...ownLogins], premergeHeads: entryHeads }) : Promise.resolve(null),
      loadInScope(db, members),
    ]));
    for (const k of membersInScope) data.inScope.add(k);
    data.tasks = tasks;
    data.ownCommits = ownCommits;
    data.stacked = stacked;
    data.retries = retries;
    if (entryReview) for (const [k, v] of entryReview.premerge) data.review.premerge.set(k, v);
    const ids = statementIds(data.review, []);
    if (ids.length) data.statements = await loadStatements(db, ids);
    return data;
  });
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
  prs: Map<RefKey, ItemOf<"ref">>;
  /** Second wave: comments created after the earliest `asked` time, of the items asked. */
  comments: Map<RefKey, CommentOut[]>;
  /** Second wave: role and cached permission of each login on a repo `needs` named. */
  act: Map<PermKey, ActFacts>;
};

/** What the second wave reads, named from the first wave's rows. */
export type ItemPassNeeds = { texts: Ref[]; prs: Ref[]; asked: { ref: Ref; since: string }[]; logins: { login: string; repo: string }[] };

/**
 * Loads the item facts inputs of `keys` in one read snapshot: one wave keyed by the pass keys, then one for what `needs` names from
 * its rows (texts, implementation PRs, comments after a question, the people who started work). `repo` narrows the loaders that
 * are not keyed.
 */
export async function loadItemPass(db: Db, keys: KeySource, o: { now: number; run: string | null; model: string; repo?: string; needs: (d: ItemPassData) => ItemPassNeeds }): Promise<ItemPassData> {
  return await db.read(async () => {
    const repos = o.repo ? [o.repo] : undefined;
    const [control, items, triage, outsideHolds, stages, workflow, implement, scoped, ownLogins, quiet, mainFixPrs, batchPrs, assignments, repoRows, openPrs, due] =
      await db.together(() => Promise.all([
        loadControl(db), loadItemsWithHashes(db, keys), loadTriageFacts(db, keys, { model: o.model, run: o.run, nowMs: o.now }), loadOutsideHolds(db, keys),
        loadStageFacts(db, keys), loadWorkflowFacts(db, keys, { nowMs: o.now }), loadImplementFacts(db, keys),
        loadInScope(db, keys),
        loadOwnLogins(db), listQuietPrs(db, o.repo ? { repo: o.repo } : {}), loadMainFixPrs(db, repos), loadOwnIntegration(db, repos),
        loadAssignments(db, o.repo ? { repo: o.repo } : {}), loadRepos(db, { all: true }), loadOpenPrLinks(db, repos),
        loadActionsDue(db, { kinds: ["close", "comment-close"], ...(repos && { repos }) }),
      ]));
    const data: ItemPassData = {
      now: o.now, run: o.run, control, items, triage, outsideHolds, stages, workflow, implement, inScope: scoped,
      ownLogins, quiet, mainFixPrs, batchPrs, assignments, repos: repoRows, openPrs, closes: new Map(due.map((a) => [refKey(a.repo, a.number), a])),
      texts: new Map(), prs: new Map(), comments: new Map(), act: new Map(),
    };
    const n = o.needs(data);
    const after = n.asked.reduce<string | null>((m, a) => (m === null || a.since < m ? a.since : m), null);
    const [texts, prs, comments, act] = await db.together(() => Promise.all([
      n.texts.length ? loadItems(db, n.texts, "text") : Promise.resolve(new Map<RefKey, ItemOf<"text">>()),
      n.prs.length ? loadItems(db, n.prs, "ref") : Promise.resolve(new Map<RefKey, ItemOf<"ref">>()),
      after !== null ? loadComments(db, n.asked.map((a) => a.ref), { after, order: "rowid" }) : Promise.resolve(new Map<RefKey, CommentOut[]>()),
      n.logins.length ? loadActFacts(db, n.logins) : Promise.resolve(new Map<PermKey, ActFacts>()),
    ]));
    Object.assign(data, { texts, prs, comments, act });
    return data;
  });
}

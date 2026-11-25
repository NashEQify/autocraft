// The planner pass's PR inputs: every module's set loader for the pass keys, loaded inside one read snapshot. The first wave
// carries every loader keyed by the pass keys; the second only what needs the first one's rows (task states of stored patches,
// our own commits on the push chains, stacked heads, the pre-merge rows of merge-entry heads); the third the owner statements
// the reviews name, and only when one does.
import type { Db } from "../db/index.ts";
import type { KeySource, Ref } from "../data/keys.ts";
import { loadOwnLogins } from "../data/access/index.ts";
import { loadTaskStates } from "../data/build/index.ts";
import { loadMainFixPrs, loadPatchFacts, pushChainOf, type PatchFacts, type TaskStates } from "../data/changes/index.ts";
import { loadAssignments, loadControl, loadOwnCommits, loadPushFacts, type ControlSnapshot, type PushFacts } from "../data/control/index.ts";
import { loadStatements, type Statement } from "../data/conversations/index.ts";
import { loadImplementFacts, type ImplementFacts } from "../data/implement/index.ts";
import { loadHolds as loadOutsideHolds, type HoldInfo } from "../data/intake/index.ts";
import { loadMergeFacts, type MergeFacts } from "../data/merge/index.ts";
import {
  listItems, loadDiffFacts, loadFormalReviews, loadGates, loadPrMirror, loadRepoCiSignals, loadRepos, loadStackedHeads,
  type DiffFactsRow, type Gate, type PrMirror, type RepoCiSignals, type RepoRow, type ReviewFact,
} from "../data/mirror/index.ts";
import { loadReviewFacts, type ReviewFacts } from "../data/review/index.ts";
import { loadRanks, type RankRow } from "../data/triage/index.ts";
import { listWorkflows, loadWorkflowFacts, type WorkflowPassFacts } from "../data/workflow/index.ts";
import type { ItemWorkflow } from "../workflow/types.ts";

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
  tasks: TaskStates;
  /** Our own commits on the loaded PRs' push chains, keyed "repo@sha". */
  ownCommits: Set<string>;
  stacked: Map<string, number[]>;
  statements: Map<number, Statement>;
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
    const [control, mirror, repos, ciSignals, diff, formal, gates, ranks, merge, patches, pushes, mainFixPrs, workflow, live, implement, review, assignments, outsideHolds, ownLogins, scoped] =
      await db.together(() => Promise.all([
        loadControl(db), loadPrMirror(db, keys), loadRepos(db, { all: true }), loadRepoCiSignals(db), loadDiffFacts(db, keys),
        loadFormalReviews(db, keys), loadGates(db, keys), loadRanks(db, keys), loadMergeFacts(db, keys), loadPatchFacts(db, keys), loadPushFacts(db, keys),
        loadMainFixPrs(db), loadWorkflowFacts(db, keys, { nowMs: o.now }), listWorkflows(db, { live: true }), loadImplementFacts(db, keys),
        loadReviewFacts(db, keys, { now: o.now }), loadAssignments(db, {}), loadOutsideHolds(db, keys), loadOwnLogins(db),
        // NEEDS workflow.loadInScope: the scope fragment for a key source (Set<RefKey>); the filter below reads every in-scope PR.
        listItems(db, { kind: "pr", states: ["OPEN", "MERGED"], inScope: true }, "ref"),
      ]));
    const data: PrPassData = {
      now: o.now, control, mirror, repos, ciSignals, diff, formal, gates, ranks, merge, patches, pushes, mainFixPrs, workflow,
      workflowRows: new Map(live.map((w) => [w.id, w])), implement, review, assignments, outsideHolds, ownLogins,
      inScope: new Set(scoped.map((r) => refKey(r.repo, r.number))), tasks: new Map(), ownCommits: new Set(), stacked: new Map(), statements: new Map(),
    };

    const pairs: { repo: string; sha: string }[] = [];
    const entryHeads: { repo: string; number: number; head: string }[] = [];
    for (const [key, m] of mirror) {
      const { repo, number } = asRef(key);
      const head = m.item.head_oid;
      if (head) for (const h of pushChainOf(patches.get(key)?.pushes ?? [], head)) pairs.push({ repo, sha: h });
      const latest = review.latest.get(key);
      if (latest) for (const h of pushChainOf(patches.get(key)?.pushes ?? [], latest.head)) pairs.push({ repo, sha: h });
      const eh = o.mergeEntryHead(data, key);
      if (eh) entryHeads.push({ repo, number, head: eh });
    }
    const [tasks, ownCommits, stacked, entryReview] = await db.together(() => Promise.all([
      loadTaskStates(db, patchTaskIds(patches)), loadOwnCommits(db, pairs), loadStackedHeads(db, [...new Set([...mirror.values()].map((m) => m.item.repo))]),
      entryHeads.length ? loadReviewFacts(db, entryHeads.map((h) => ({ repo: h.repo, number: h.number })), { now: o.now, own: [...ownLogins], premergeHeads: entryHeads }) : Promise.resolve(null),
    ]));
    data.tasks = tasks;
    data.ownCommits = ownCommits;
    data.stacked = stacked;
    if (entryReview) for (const [k, v] of entryReview.premerge) data.review.premerge.set(k, v);
    const ids = statementIds(data.review, []);
    if (ids.length) data.statements = await loadStatements(db, ids);
    return data;
  });
}

// Merge approval. A repo's `merge` step approval lets the pipeline merge PRs nobody approved one by one (the automatic
// path); an operator, or a maintainer of the repo, turns it on (src/dash/api/admin.ts). A live workflow carries the
// approval of its own PR. `mergeVerdicts` applies the one rule (src/core/may.ts) to freshly loaded facts.
import { loadOwnCommits, loadStepApprovals, loadTrackedRepos, repoStepApproval, SETTINGS, setStepApproval, setting } from "../data/control/index.ts";
import type { StepApproval } from "../data/control/types.ts";
import { loadPushEdges } from "../data/changes/index.ts";
import { listWorkflows, loadLiveRepos } from "../data/workflow/index.ts";
import type { ItemWorkflow } from "../data/workflow/types.ts";
import { mayMerge, type MayResult, type WorkflowGate } from "../core/may.ts";
import type { Db } from "../db/index.ts";

export type MergeApproval = StepApproval;

export async function mergeApprovalOf(db: Db, repo: string): Promise<MergeApproval | null> {
  return await repoStepApproval(db, repo, "merge");
}

// Returns false when nothing changed.
export async function setMergeApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "merge", on: approved }], by) > 0;
}

const gateOf = (w: ItemWorkflow): WorkflowGate => ({
  // The stored entry is `fixup`; the rule spells it `fix-up`.
  live: true, entry: w.entry === "fixup" ? "fix-up" : w.entry, state: w.state, startedBy: w.startedBy, approvedBy: w.approvedBy, approvedAt: w.approvedAt,
  blocker: w.blocker, baseHead: w.baseHead, fixupAsked: false,
});

/** Whether each PR of the repo may merge at the given head: the repo's approval, the PR's live workflow and the heads we pushed, in one load. */
export async function mergeVerdicts(db: Db, repo: string, items: { number: number; head: string }[]): Promise<Map<number, MayResult>> {
  const out = new Map<number, MayResult>();
  if (!items.length) return out;
  const refs = items.map((i) => ({ repo, number: i.number }));
  const [approvals, workflows, edges, own] = await db.together(() => Promise.all([
    loadStepApprovals(db, [repo], ["merge"]),
    listWorkflows(db, { refs, live: true }),
    loadPushEdges(db, refs),
    loadOwnCommits(db, items.map((i) => ({ repo, sha: i.head }))),
  ]));
  const repoApproval = approvals.get(repo)?.merge ?? null;
  const gates = new Map(workflows.map((w) => [w.number, gateOf(w)]));
  for (const i of items) {
    const ownHeads = new Set((edges.get(`${repo}#${i.number}`) ?? []).map((e) => e.to));
    if (own.has(`${repo}@${i.head}`)) ownHeads.add(i.head);
    out.set(i.number, mayMerge({ repoApproval, workflow: gates.get(i.number) ?? null, head: i.head, ownHeads }));
  }
  return out;
}

/** `repo#n: why` of the first PR that may not merge, or null when all may. */
export const firstRefusal = (verdicts: Map<number, MayResult>, repo: string): string | null => {
  for (const [n, v] of verdicts) if (!v.ok) return `${repo}#${n}: ${v.why}`;
  return null;
};

/**
 * The repos the merge stages act in. `full`: the pipeline flag is on (and, with a pilot set, one of its items names the repo).
 * `any`: those and the tracked repos with a live workflow, which take part for those items alone.
 */
export async function mergeScope(db: Db): Promise<{ full: Set<string>; any: Set<string> }> {
  const [tracked, live, pilot] = await db.together(() => Promise.all([loadTrackedRepos(db), loadLiveRepos(db), setting(db, "pilot_items")]));
  const items = SETTINGS.pilotItems.read(pilot) as string[];
  const named = new Set(items.map((i) => i.split("#")[0]!));
  const full = new Set([...tracked.values()].filter((t) => t.pipeline && (!items.length || named.has(t.name))).map((t) => t.name));
  return { full, any: new Set([...full, ...[...live].filter((r) => tracked.has(r))]) };
}

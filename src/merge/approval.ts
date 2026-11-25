// Merge approval. A repo's `merge` step approval lets the pipeline merge PRs nobody approved one by one (the automatic
// path); an operator, or a maintainer of the repo, turns it on (src/dash/api/admin.ts). A live workflow carries the
// approval of its own PR, or of the PR that implements its issue. `mergeVerdicts` applies the one rule (src/core/may.ts) to freshly loaded facts.
import { loadOwnCommits, loadStepApprovals, loadTrackedRepos, repoStepApproval, SETTINGS, setStepApproval, setting } from "../data/control/index.ts";
import type { StepApproval } from "../data/control/types.ts";
import { loadPushEdges } from "../data/changes/index.ts";
import { loadLegs, loadLiveRepos, loadPrWorkflows } from "../data/workflow/index.ts";
import { legHeadOf, mayMerge, workflowGate, type MayResult } from "../core/may.ts";
import type { Db } from "../db/index.ts";

export type MergeApproval = StepApproval;

export async function mergeApprovalOf(db: Db, repo: string): Promise<MergeApproval | null> {
  return await repoStepApproval(db, repo, "merge");
}

// Returns false when nothing changed.
export async function setMergeApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "merge", on: approved }], by) > 0;
}

/**
 * Whether each PR of the repo may merge at the given head: the repo's approval, the live workflow that works on it (its own, or its
 * issue's), that workflow's merge leg and the heads we pushed, in one load.
 */
export async function mergeVerdicts(db: Db, repo: string, items: { number: number; head: string }[]): Promise<Map<number, MayResult>> {
  const out = new Map<number, MayResult>();
  if (!items.length) return out;
  const refs = items.map((i) => ({ repo, number: i.number }));
  const [approvals, workflows, legs, edges, own] = await db.together(() => Promise.all([
    loadStepApprovals(db, [repo], ["merge"]),
    loadPrWorkflows(db, refs),
    loadLegs(db, refs, { activeOnly: true }),
    loadPushEdges(db, refs),
    loadOwnCommits(db, items.map((i) => ({ repo, sha: i.head }))),
  ]));
  const repoApproval = approvals.get(repo)?.merge ?? null;
  for (const i of items) {
    const ownHeads = new Set((edges.get(`${repo}#${i.number}`) ?? []).map((e) => e.to));
    if (own.has(`${repo}@${i.head}`)) ownHeads.add(i.head);
    const w = workflows.get(`${repo}#${i.number}`);
    out.set(i.number, mayMerge({ repoApproval, workflow: workflowGate(w, { legHead: legHeadOf(legs.get(`${repo}#${i.number}`), w) }), head: i.head, ownHeads }));
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

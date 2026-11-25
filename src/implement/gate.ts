// What an implement job needs before it starts, checked again at the run: the repo's issue implementation approval, its
// Implement switch, and a live implement workflow on the issue started by someone who still acts on the repo (data/access stillCounts).
// A job that only ends an attempt whose PR merged or closed needs none of them.
import { featureOn } from "../build/features.ts";
import type { Db } from "../db/index.ts";
import { loadActFacts, permKey, stillCounts } from "../data/access/index.ts";
import { repoStepApproval } from "../data/control/index.ts";
import { loadImplementFacts } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import type { ItemWorkflow } from "../data/workflow/index.ts";
import { githubIdentity } from "../github/identity.ts";
import { ENDED_STATES } from "./types.ts";

/** Who started the issue's live implement workflow, or null. */
export const queuerOfWorkflow = (w: ItemWorkflow | null | undefined): string | null => (w?.entry === "implement" ? w.startedBy : null);

/** The login that queued the issue: who started its live implement workflow, or null. */
export async function queuerOf(db: Db, repo: string, number: number): Promise<string | null> {
  return queuerOfWorkflow((await listWorkflows(db, { live: true, refs: [{ repo, number }] }))[0]);
}

/** Why an implement job of the issue may not run, or null. `dry`: a dry run, which may run while the repo's Implement switch is off. */
export async function implementRefusal(db: Db, repo: string, number: number, o: { dry?: boolean } = {}): Promise<string | null> {
  const ref = `${repo}#${number}` as const;
  const [facts, approval, workflows] = await db.together(() => Promise.all([
    loadImplementFacts(db, [{ repo, number }]), repoStepApproval(db, repo, "fixissue"), listWorkflows(db, { live: true, refs: [{ repo, number }] }),
  ]));
  // A live attempt whose PR merged or closed only ends (attempt and workspace): bookkeeping that always runs.
  const attempt = facts.byIssue.get(ref)?.attempt;
  if (!o.dry && attempt && !ENDED_STATES.has(attempt.state) && attempt.prNumber !== null) {
    const pr = (await loadItems(db, [{ repo, number: attempt.prNumber }], "ref")).get(`${repo}#${attempt.prNumber}`);
    if (pr && pr.state !== "OPEN") return null;
  }
  if (!approval) return `issue implementations in ${repo} are not approved`;
  if (!o.dry && !await featureOn(db, "implement", repo)) return `Implement is off for ${repo}`;
  const by = queuerOfWorkflow(workflows[0]);
  if (!by) return `${ref} is not queued`;
  const [act, identity] = await Promise.all([loadActFacts(db, [{ login: by, repo }]), githubIdentity(db)]);
  if (!stillCounts(act.get(permKey(by, repo)), identity)) return `${by}, who queued ${ref}, does not settle on ${repo}`;
  return null;
}

// Read model of the PR status comment step (src/prstatus/index.ts): the stored comments, the PRs in the pipeline's scope and the
// started items of one repo in one wave, then the batch, answer and quiet facts of the PRs the step looks at.
// reads: workflow.pr_status_comments, workflow.item_workflows, workflow.workflow_events, mirror.items, planner.item_stage, merge.merge_batches, merge.merge_batch_prs, security (quiet)
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { loadAnswers, loadLatestWorkflows, loadStatusComments } from "../workflow/index.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import { loadQuiet } from "../security/index.ts";
import { ACTIVE_BATCH } from "../merge/types.ts";
import type { StatusExtras, StatusInputs } from "./types.ts";

/**
 * The repo's stored comments that are not final, the open PRs in scope past triage (a stage row) that are not integration
 * PRs, and each started item's latest workflow with whether the item is open. One `together` wave.
 */
export async function loadStatusInputs(db: Db, repo: string): Promise<StatusInputs> {
  const q = queryDb(db);
  const k = q.k as any;
  const scopeQ = k.selectFrom("main.items as i").select("i.number")
    .where("i.repo", "=", repo).where("i.kind", "=", "pr").where("i.state", "=", "OPEN")
    .where((eb: any) => eb.exists(eb.selectFrom("main.item_stage as s").select(eb.lit(1).as("one")).whereRef("s.repo", "=", "i.repo").whereRef("s.number", "=", "i.number")))
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.merge_batches as b").select(eb.lit(1).as("one")).whereRef("b.repo", "=", "i.repo").whereRef("b.pr_number", "=", "i.number"))))
    .where((eb: any) => inScopeExpr(db, eb, "i.repo", "i.number"));
  const [stored, scope, started] = await db.together(() => Promise.all([
    loadStatusComments(db, repo),
    q.all(scopeQ) as Promise<{ number: number }[]>,
    loadLatestWorkflows(db, repo),
  ]));
  return { stored, inScope: new Set(scope.map((r) => Number(r.number))), started };
}

/**
 * For the PRs `numbers` of the repo: each one's open merge batch at its current head (`open:N`) and the batch it merged with
 * (`merged:N`), with the batch's PR number (null before it opens); the latest answer of each workflow in `workflowIds`; and the
 * quiet PRs. One `together` wave.
 */
export async function loadStatusExtras(db: Db, repo: string, numbers: number[], workflowIds: number[]): Promise<StatusExtras> {
  const q = queryDb(db);
  const k = q.k as any;
  const batchQ = k.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as b", "b.id", "bp.batch_id")
    .innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "b.repo").onRef("i.number", "=", "bp.number"))
    .select(["bp.number", "b.state", "b.pr_number", "bp.head_oid", "i.head_oid as head"])
    .where("b.repo", "=", repo).where(kx.inList(db, "bp.number", numbers, "bigint")).where("b.state", "in", [...ACTIVE_BATCH, "merged"]).orderBy("b.id");
  const [rows, answered, quiet] = await db.together(() => Promise.all([
    numbers.length ? q.all(batchQ) as Promise<{ number: number; state: string; pr_number: number | null; head_oid: string; head: string | null }[]> : Promise.resolve([]),
    loadAnswers(db, workflowIds),
    loadQuiet(db, numbers.map((n) => `${repo}#${n}`)),
  ]));
  const batches = new Map<string, { pr: number | null }>();
  for (const r of rows) {
    const pr = r.pr_number === null ? null : Number(r.pr_number);
    if (r.state === "merged") batches.set(`merged:${Number(r.number)}`, { pr });
    else if (r.head_oid === r.head) batches.set(`open:${Number(r.number)}`, { pr });
  }
  return { batches, answered, quiet: new Set(numbers.filter((n) => quiet.has(`${repo}#${n}`))) };
}

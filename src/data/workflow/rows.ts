// `item_workflows` and `workflow_events` (M10 workflow-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { Preapproval, ItemWorkflow, NewWorkflow, QueuePosition, RefKey, StartedFilter, StartedWork, StoredEvent, WorkflowEvent, WorkflowEventKind, WorkflowFilter, WorkflowPassFacts, WorkflowPatch } from "./types.ts";
import type { Surface } from "../../workflow/types.ts";

/** The planner pass's set loader: live workflows with their implementation PR, latest ended state per item, merge holds, queued requests and active legs; five statements in one wave. */
export async function loadWorkflowFacts(db: Db, keys: KeySource, o?: { nowMs?: number }): Promise<WorkflowPassFacts> {
  throw new Error("not built: workflow.loadWorkflowFacts");
}

/** Filter loader ordered by id. */
export async function listWorkflows(db: Db, f: WorkflowFilter): Promise<ItemWorkflow[]> {
  throw new Error("not built: workflow.listWorkflows");
}

/** Every workflow of each item, oldest first. */
export async function loadWorkflowHistory(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, ItemWorkflow[]>> {
  throw new Error("not built: workflow.loadWorkflowHistory");
}

/** Events oldest first. */
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o?: { lastPerRef?: number; kinds?: WorkflowEventKind[] }): Promise<Map<RefKey, StoredEvent[]>> {
  throw new Error("not built: workflow.loadEvents");
}

/** Latest event kind per item. */
export async function loadLastEventKinds(db: Db, keys: KeySource): Promise<Map<RefKey, WorkflowEventKind>> {
  throw new Error("not built: workflow.loadLastEventKinds");
}

/** Latest `answered` event per workflow. */
export async function loadAnswers(db: Db, workflowIds: number[]): Promise<Map<number, { login: string; at: string }>> {
  throw new Error("not built: workflow.loadAnswers");
}

/** Latest `started` or `answered` event time, else the start. */
export async function loadGoOnAt(db: Db, workflows: { id: number; startedAt: string }[]): Promise<Map<number, string>> {
  throw new Error("not built: workflow.loadGoOnAt");
}

/** Command rate limit count. */
export async function countEventsSince(db: Db, q: { login: string; via: Surface; since: string }): Promise<number> {
  throw new Error("not built: workflow.countEventsSince");
}

/** `INSERT ... ON CONFLICT DO NOTHING RETURNING id` against the live-workflow index; a ref missing from the result already has a live workflow. Joins the caller's `db.write`. */
export async function startWorkflows(db: Db, rows: NewWorkflow[]): Promise<Map<RefKey, number>> {
  throw new Error("not built: workflow.startWorkflows");
}

/** Batched update, one `updateFrom` per distinct patch column set; always sets `updated_at`. */
export async function saveWorkflows(db: Db, rows: { id: number; patch: WorkflowPatch; at?: string }[]): Promise<number> {
  throw new Error("not built: workflow.saveWorkflows");
}

/** Batched insert. */
export async function recordEvents(db: Db, rows: WorkflowEvent[]): Promise<void> {
  throw new Error("not built: workflow.recordEvents");
}

/** `1e15 + weight * 1e12 - workflow.id` for every item with a live workflow and for the implementation PR of a live implement workflow (the maximum when both apply). */
export async function loadWorkScores(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  throw new Error("not built: workflow.loadWorkScores");
}

/** Open items with a live workflow ordered by weight then id, with `row_number()` and `count(*) OVER ()`. */
export async function loadQueuePositions(db: Db, f?: { repos?: string[] }): Promise<Map<RefKey, QueuePosition>> {
  throw new Error("not built: workflow.loadQueuePositions");
}

/** Items a person started or approved (case-insensitive login). */
export async function loadStartedRefs(db: Db, f: StartedFilter): Promise<Set<RefKey>> {
  throw new Error("not built: workflow.loadStartedRefs");
}

/** The Task Runner snapshot's input; two result sets in one wave. */
export async function loadStartedWork(db: Db): Promise<StartedWork> {
  throw new Error("not built: workflow.loadStartedWork");
}

/** Repos with a live workflow. */
export async function loadLiveRepos(db: Db): Promise<Set<string>> {
  throw new Error("not built: workflow.loadLiveRepos");
}

/** Distinct logins the pipeline acts for: active leg owners, queued fix-up requesters, and `approved_by` or `started_by` of live workflows; one `UNION`. */
export async function loadActingPairs(db: Db): Promise<{ login: string; repo: string }[]> {
  throw new Error("not built: workflow.loadActingPairs");
}

/** How each workflow's path ended after the approval. */
export async function loadPathEnds(db: Db, rows: { workflowId: number; approvedAt: string }[]): Promise<Map<number, "merged" | "closed" | "stopped" | null>> {
  throw new Error("not built: workflow.loadPathEnds");
}

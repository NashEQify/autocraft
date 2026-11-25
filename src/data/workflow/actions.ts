// Person actions: `workflow_actions` (M11 workflow-b).
import type { Db } from "../../db/index.ts";
import type { ActionKind, ActionState, DueAction, NewAction, RefKey, WorkflowAction } from "./types.ts";

/** Batched upsert; an existing `failed` or `stopped` row goes back to `pending` with attempts 0. */
export async function queueActions(db: Db, rows: NewAction[]): Promise<Map<string, number>> {
  throw new Error("not built: workflow.queueActions");
}

/** `pending` rows with the workflow's weight and the item's open state and head, by weight then `created_at`. */
export async function loadActionsDue(db: Db, f?: { repos?: string[]; kinds?: ActionKind[]; refs?: { repo: string; number: number }[] }): Promise<DueAction[]> {
  throw new Error("not built: workflow.loadActionsDue");
}

/** Batched update that writes only when state or reason differ. */
export async function saveActions(db: Db, rows: { id: number; state: ActionState; reason?: string | null; commentUrl?: string | null; attempts?: number; at: string }[]): Promise<void> {
  throw new Error("not built: workflow.saveActions");
}

/** Actions per item. */
export async function loadActions(db: Db, f: { refs?: { repo: string; number: number }[]; workflowIds?: number[]; waitingFor?: string }): Promise<Map<RefKey, WorkflowAction[]>> {
  throw new Error("not built: workflow.loadActions");
}

/** Returns `waiting-token` and `waiting-permission` (and `failed` for `ids`) rows to `pending` with attempts 0. */
export async function retryActions(db: Db, f: { login?: string; ids?: number[] }): Promise<number> {
  throw new Error("not built: workflow.retryActions");
}

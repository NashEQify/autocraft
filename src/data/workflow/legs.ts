// The merge leg: `preapprovals` and `operator_fixups` (M10 workflow-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { FixupRequest, LegMove, LegMoved, LegPass, MergeApproval, NewFixupRequest, NewLeg, Preapproval, RefKey } from "./types.ts";

/** Legs oldest first. */
export async function loadLegs(db: Db, keys: KeySource, o?: { activeOnly?: boolean; latestOnly?: boolean; ids?: number[] }): Promise<Map<RefKey, Preapproval[]>> {
  throw new Error("not built: workflow.loadLegs");
}

/** Active legs joined to their workflow and `goOnAt`, plus queued requests of those legs; two statements. */
export async function loadLegPass(db: Db, f?: { repos?: string[] }): Promise<LegPass> {
  throw new Error("not built: workflow.loadLegPass");
}

/** Batched update where `workflow_id IS NULL`. */
export async function adoptLegs(db: Db, rows: { id: number; workflowId: number }[]): Promise<number> {
  throw new Error("not built: workflow.adoptLegs");
}

/** Batched insert guarded by the partial unique index on active legs; keyed "repo#number"; `"active"` when refused. Audit rows through `control.addAudit`. */
export async function addLegs(db: Db, rows: NewLeg[]): Promise<Map<string, number | "active">> {
  throw new Error("not built: workflow.addLegs");
}

/** Batched compare-and-set update that ends linked requests and audits each move as `preapproval`; returns the legs that moved. The caller posts the thread lines. */
export async function moveLegs(db: Db, moves: LegMove[]): Promise<LegMoved[]> {
  throw new Error("not built: workflow.moveLegs");
}

/** Inserts requests and, for `merge: true`, legs, then links them; one `db.write`. */
export async function addFixupRequests(db: Db, rows: NewFixupRequest[]): Promise<Map<string, { requestId: number; legId: number | null }>> {
  throw new Error("not built: workflow.addFixupRequests");
}

/** Compare-and-set update where `state = 'queued'`; returns the ids ended. */
export async function endFixupRequests(db: Db, rows: { id: number; reason: string }[]): Promise<number[]> {
  throw new Error("not built: workflow.endFixupRequests");
}

/** Open and started requests. */
export async function loadFixupRequests(db: Db, f: { open?: true; refs?: { repo: string; number: number }[]; nowMs?: number }): Promise<FixupRequest[]> {
  throw new Error("not built: workflow.loadFixupRequests");
}

/** The merge queue's operator path: an open PR whose live workflow is approved (or entry `merge`) and whose leg is queued. */
export async function loadMergeApprovals(db: Db, f: { repo?: string; refs?: { repo: string; number: number }[] }): Promise<Map<RefKey, MergeApproval>> {
  throw new Error("not built: workflow.loadMergeApprovals");
}

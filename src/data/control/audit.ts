// The audit table: writers, the GitHub write log and typed readers (M06 control-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { AuditFilter, AuditPageFilter, AuditRow, AuditWhere, Details, NewAudit, PaceKey, WriteLogRow, WritePace } from "./types.ts";

/** Batched insert chunked at 500; an empty array does nothing. Module writers call it inside their own transaction. */
export async function addAudit(db: Db, rows: NewAudit[]): Promise<void> {
  throw new Error("not built: control.addAudit");
}

/** At most one row per login per hour; later refusals raise `details.refused`. */
export async function recordRefusedSignIn(db: Db, login: string, details: Details): Promise<void> {
  throw new Error("not built: control.recordRefusedSignIn");
}

/** The `deadline-ack` rows (`target = step:<step>`). */
export async function ackDeadlines(db: Db, steps: string[], by: string): Promise<void> {
  throw new Error("not built: control.ackDeadlines");
}

/** Inserts the `started` row after checking the pacing window under the writer lock; `pace: null` inserts without the check. The caller sleeps for `wait` and retries. */
export async function beginWrite(db: Db, o: { at: string; login: string; action: string; target: string; details: Details; pace: WritePace | null }): Promise<{ id: number; paceOwner: string | null } | { wait: number }> {
  throw new Error("not built: control.beginWrite");
}

/** Writes the final `done` or `failed` details. */
export async function finishWrite(db: Db, id: number, details: Details): Promise<void> {
  throw new Error("not built: control.finishWrite");
}

/** Deletes `started` rows of writes parked at a stop. */
export async function abandonWrites(db: Db, ids: number[]): Promise<void> {
  throw new Error("not built: control.abandonWrites");
}

/** How long each key waits for the budget now. */
export async function loadPaceWaits(db: Db, keys: PaceKey[], now: number): Promise<Map<string, number>> {
  throw new Error("not built: control.loadPaceWaits");
}

/** A resumed job's earlier successful and unfinished write rows by `action\ttarget`. */
export async function loadMadeBefore(db: Db, jobId: number, before: string): Promise<Map<string, { id: number; details: Details }[]>> {
  throw new Error("not built: control.loadMadeBefore");
}

/** Keyed reader; `where` is a closed set of JSON detail fields. */
export async function listAudit(db: Db, f: AuditFilter): Promise<AuditRow[]> {
  throw new Error("not built: control.listAudit");
}

/** The same read for many targets at once. */
export async function loadAuditActions(db: Db, targets: string[], actions: string[]): Promise<Map<string, AuditRow[]>> {
  throw new Error("not built: control.loadAuditActions");
}

/** Latest `at`, keyed by target when `targets` is given, else by action. */
export async function loadAuditMax(db: Db, action: string | readonly string[], targets?: readonly string[]): Promise<Map<string, string>> {
  throw new Error("not built: control.loadAuditMax");
}

/** Counts audit rows. */
export async function countAudit(db: Db, f: { action: string | string[]; since: string; where?: AuditWhere; not?: { state?: string } }): Promise<number> {
  throw new Error("not built: control.countAudit");
}

/** Last successful `assign` or `unassign` per item. */
export async function loadAssignments(db: Db, scope: { repo?: string } | { refs: string[] }): Promise<Map<string, { assignee: string | null; run: string | null }>> {
  throw new Error("not built: control.loadAssignments");
}

/** Filing outcomes of held follow-ups. */
export async function loadHeldIssueAudits(db: Db, heldIds: number[] | KeySource): Promise<Map<number, { number: number; url: string }>> {
  throw new Error("not built: control.loadHeldIssueAudits");
}

/** Ids of comments AutoCraft posted. */
export async function loadPostedCommentIds(db: Db, o: { since?: string }): Promise<{ numbers: Set<string>; nodes: Set<string> }> {
  throw new Error("not built: control.loadPostedCommentIds");
}

/** AutoCraft's GitHub writes per item. */
export async function loadWriteLog(db: Db, refs: string[]): Promise<Map<string, WriteLogRow[]>> {
  throw new Error("not built: control.loadWriteLog");
}

/** The admin audit log; two statements in one wave. */
export async function listAuditPage(db: Db, f: AuditPageFilter): Promise<{ total: number; rows: AuditRow[] }> {
  throw new Error("not built: control.listAuditPage");
}

/** Item-trace fingerprint. */
export async function loadAuditCounts(db: Db, ref: string): Promise<{ n: number; newest: number; length: number }> {
  throw new Error("not built: control.loadAuditCounts");
}

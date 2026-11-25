// Workspace tool calls (`workspace_calls`) (package build-b).
import type { Db } from "../../db/index.ts";
import type { NewWorkspaceCall, ToolCallQuery, WorkspaceCallRow } from "./types.ts";

/** When the bound call's work started and its tool stats; `since` is `runners.fragments.callSince` embedded. 2 statements in one wave. */
export async function loadWorkspaceCallSince(db: Db, workspaceId: number, callId: number, ownTools: string[]): Promise<{ firstWorkAt: string | null; stats: { tool: string; result: string | null }[] }> { throw new Error("not built: build.loadWorkspaceCallSince"); }
/** Batched insert returning ids. */
export async function addWorkspaceCalls(db: Db, rows: NewWorkspaceCall[]): Promise<number[]> { throw new Error("not built: build.addWorkspaceCalls"); }
/** Batched settle, start or refuse by id with compare-and-set on state; returns the ids changed. */
export async function markCalls(db: Db, rows: { id: number; where?: string[]; set: Partial<Omit<WorkspaceCallRow, "id">> }[]): Promise<Set<number>> { throw new Error("not built: build.markCalls"); }
/** One `UPDATE ... SET state = 'running' WHERE workspace_id AND state = 'queued' AND run_id = <leased run of callId> RETURNING`. */
export async function claimQueuedCalls(db: Db, workspaceId: number, callId: number): Promise<{ id: number; tool: string; args: string }[]> { throw new Error("not built: build.claimQueuedCalls"); }
/** Refuses the queued calls of a workspace with a result; returns their ids. */
export async function refuseQueuedCalls(db: Db, workspaceId: number, callId: number, result: string): Promise<number[]> { throw new Error("not built: build.refuseQueuedCalls"); }
/** Calls a dead process left running, for takeover. */
export async function loadRunningCalls(db: Db, workspaceId: number, callId: number): Promise<WorkspaceCallRow[]> { throw new Error("not built: build.loadRunningCalls"); }
/** Fails calls running past their deadline. */
export async function failStuckCalls(db: Db, nowIso: string): Promise<number> { throw new Error("not built: build.failStuckCalls"); }
/** The state and result of one call; callers wrap it in `db.fresh`. */
export async function loadCallResult(db: Db, id: number, workspaceId?: number): Promise<{ state: string; result: string | null } | null> { throw new Error("not built: build.loadCallResult"); }
/** Calls for the tool session: prior call, number lookups, `app_start` by `n`. */
export async function loadToolCalls(db: Db, workspaceId: number, q: ToolCallQuery): Promise<WorkspaceCallRow[]> { throw new Error("not built: build.loadToolCalls"); }
/** Kept images of a run before a call id. */
export async function countKeptImages(db: Db, workspaceId: number, runId: number | null, beforeId: number): Promise<number> { throw new Error("not built: build.countKeptImages"); }
/** Replaces stored images with stubs in one `updateFrom` with compare-and-set on `result`. */
export async function stubImages(db: Db, rows: { id: number; stored: string; stubbed: string }[]): Promise<number> { throw new Error("not built: build.stubImages"); }
/** One batch of 200 rows, then `stubImages`. */
export async function pruneWorkspaceImageBatch(db: Db, nowMs: number, after: number): Promise<{ rows: number; last: number }> { throw new Error("not built: build.pruneWorkspaceImageBatch"); }

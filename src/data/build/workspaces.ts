// Workspaces (`workspaces`) (package build-b).
import type { Db } from "../../db/index.ts";
import type { WarmNote, WorkspacePass, WorkspaceMove, WorkspaceRequest, WorkspaceRow, WorkspaceSource, WorkspaceStateName } from "./types.ts";

/** Workspace rows by ids, environment and states, remote call ids or a fragment; `checkpoint` adds the checkpoint blob. */
export async function loadWorkspaces(db: Db, src: WorkspaceSource, opt?: { checkpoint?: boolean }): Promise<Map<number, WorkspaceRow>> { throw new Error("not built: build.loadWorkspaces"); }
/** One pass of the workspace launcher: live rows, running calls with deadlines and background shell calls, bound call states. Wave 1: 4 statements. */
export async function loadWorkspacePass(db: Db, envId: string, nowMs: number): Promise<WorkspacePass> { throw new Error("not built: build.loadWorkspacePass"); }
/** Validates (environment kind, warm writer flag, warm target) in one wave, then one insert. Returns the ids. */
export async function requestWorkspaces(db: Db, rows: WorkspaceRequest[], now: string): Promise<number[]> { throw new Error("not built: build.requestWorkspaces"); }
/** Compare-and-set moves; returns the ids that moved. One statement per distinct patch shape. */
export async function moveWorkspaces(db: Db, moves: WorkspaceMove[], now: string): Promise<Set<number>> { throw new Error("not built: build.moveWorkspaces"); }
/** Patches rows with `kx.updateFrom`. */
export async function patchWorkspaces(db: Db, rows: { id: number; whereState?: WorkspaceStateName[]; set: Partial<Omit<WorkspaceRow, "id">> }[]): Promise<number> { throw new Error("not built: build.patchWorkspaces"); }
/** Binds a remote call to a live workspace; throws 409 when a different bound call is queued or leased. */
export async function bindWorkspaceCall(db: Db, workspaceId: number, callId: number, o: { parentId?: number }): Promise<void> { throw new Error("not built: build.bindWorkspaceCall"); }
/** `update ... returning next_call`. */
export async function takeCallNumber(db: Db, id: number): Promise<number> { throw new Error("not built: build.takeCallNumber"); }
/** The checkpoint blob; `alone`. */
export async function loadCheckpoint(db: Db, id: number): Promise<Uint8Array | null> { throw new Error("not built: build.loadCheckpoint"); }
/** Warm source and checkpoint note per workspace. */
export async function loadWorkspaceWarm(db: Db, workspaceIds: number[]): Promise<Map<number, WarmNote>> { throw new Error("not built: build.loadWorkspaceWarm"); }

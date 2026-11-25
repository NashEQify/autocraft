// Workspace sessions (`workspace_sessions`) (package build-b).
import type { Db } from "../../db/index.ts";
import type { NewSession, SessionRow, SessionSource, SweptSession } from "./types.ts";

/** Insert returning the id. */
export async function addSession(db: Db, row: NewSession): Promise<number> { throw new Error("not built: build.addSession"); }
/** Sessions by ids, workspace ids or remote call id. */
export async function loadSessions(db: Db, src: SessionSource): Promise<Map<number, SessionRow[]>> { throw new Error("not built: build.loadSessions"); }
/** Compare-and-set claim of a session by a job. */
export async function claimSession(db: Db, id: number, jobId: number): Promise<{ state: string } | null> { throw new Error("not built: build.claimSession"); }
/** Patches sessions with `updateFrom`. */
export async function patchSessions(db: Db, rows: { id: number; whereState?: string[]; set: Partial<Omit<SessionRow, "id">> }[]): Promise<number> { throw new Error("not built: build.patchSessions"); }
/** Fails open sessions whose job ended (found with `jobs.fragments.jobEnded`) in one update; the caller ends the unkept workspaces. */
export async function sweepSessions(db: Db, nowIso: string): Promise<SweptSession[]> { throw new Error("not built: build.sweepSessions"); }

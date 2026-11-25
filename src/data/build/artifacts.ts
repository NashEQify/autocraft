// Artifacts and logs (`build_artifacts`, `build_task_logs`) (package build-a).
import type { Db } from "../../db/index.ts";
import type { ArtifactRow, IdSource, LogTail } from "./types.ts";

/** Artifact rows per task, optionally by name or content type. */
export async function loadArtifacts(db: Db, taskIds: IdSource, opt?: { names?: string[]; contentType?: string }): Promise<Map<number, ArtifactRow[]>> { throw new Error("not built: build.loadArtifacts"); }
/** Stored file names per `taskId/name` key. */
export async function loadArtifactFiles(db: Db, keys: { taskId: number; name: string }[]): Promise<Map<string, string>> { throw new Error("not built: build.loadArtifactFiles"); }
/** One transaction: limits checked against the task's `artifact_bytes` and the count, upsert the row, update `artifact_bytes`. */
export async function addArtifact(db: Db, a: { taskId: number; name: string; bytes: number; contentType: string; file: string }, limits: { maxCount: number; maxBytes: number }): Promise<{ ok: true } | { refused: "count" | "size" | "missing" }> { throw new Error("not built: build.addArtifact"); }
/** Deletes artifact rows and zeroes `artifact_bytes`; returns the ids so the caller deletes the directories after commit. */
export async function removeArtifactRows(db: Db, taskIds: number[]): Promise<number[]> { throw new Error("not built: build.removeArtifactRows"); }
/** The newest chunks until the byte budget is reached (windowed running sum), and `log_bytes`, in one wave. */
export async function loadLogTails(db: Db, tasks: { id: number; step?: string }[], o: { maxBytes: number; maxChunks?: number }): Promise<Map<number, LogTail>> { throw new Error("not built: build.loadLogTails"); }
/** The step each task's newest chunk is on. */
export async function loadLogSteps(db: Db, taskIds: number[]): Promise<Map<number, string>> { throw new Error("not built: build.loadLogSteps"); }

// Patch checks (`patch_checks`), model checks (`model_checks`) and stored-patch sessions.
import type { Db } from "../../db/index.ts";
import type { ModelCheckRow, ModelCheckStart, PatchCheckInput, SessionRow } from "./types.ts";

/** One multi-row insert per call. */
export async function recordPatchChecks(db: Db, rows: PatchCheckInput[]): Promise<void> { throw new Error("not built: changes.recordPatchChecks"); }
/** Opens a model check row; the launched build task runs between start and end, so they are two statements. */
export async function startModelCheck(db: Db, r: ModelCheckStart): Promise<number> { throw new Error("not built: changes.startModelCheck"); }
/** Closes a model check row. */
export async function endModelCheck(db: Db, id: number, o: { outcome: string; taskId: number | null; endedAt: string }): Promise<void> { throw new Error("not built: changes.endModelCheck"); }
/** The highest model check id (dry-run tool). */
export async function maxModelCheckId(db: Db): Promise<number> { throw new Error("not built: changes.maxModelCheckId"); }
/** Model checks after `id` (dry-run tool). */
export async function loadModelChecksAfter(db: Db, id: number): Promise<ModelCheckRow[]> { throw new Error("not built: changes.loadModelChecksAfter"); }
/** `{ kind, id, state, session }` of every row with a session in the three patch tables and `main_fixes`, ordered by id. */
export async function loadSessionRows(db: Db): Promise<SessionRow[]> { throw new Error("not built: changes.loadSessionRows"); }

// Writers of patch rows (fixups, ci_fixes, conflict_merges). Each opens `db.write`, or joins an outer one, and records its own
// stage event and job note through the owners' batch writers in the same transaction.
import type { Db } from "../../db/index.ts";
import type { StageEventRow } from "../planner/types.ts";
import type { CifixRerunRow, FixupSource, PatchKind, SessionClear } from "./types.ts";

type Key = { repo: string; number: number };

/** Marks a patch as pushing: updates the stored row or the newest open row at the key and source (compare-and-set), else inserts. */
export async function recordPushing(db: Db, p: { kind: PatchKind; repo: string; number: number; head: string; commit: string; files: string[]; attempt: number; source?: FixupSource; operatorFix?: number | null; storedId?: number; ciKind?: string }): Promise<void> { throw new Error("not built: changes.recordPushing"); }
/** Stores the model's patch in a `linting` row (update by id, or insert). */
export async function storePatch(db: Db, p: { kind: PatchKind; storedId?: number; repo: string; number: number; head: string; patch: string; files: string[]; lintTask: number | null; lintRound: number; lintState: string; session: string | null; changes?: string[]; source?: FixupSource; operatorFix?: number | null; baseSha?: string; attempt: number }): Promise<void> { throw new Error("not built: changes.storePatch"); }
/** Records a patch outcome: the row, its stage event and the job note in one transaction. */
export async function finishPatch(db: Db, o: Key & { kind: PatchKind; head: string; state: string; reason: string | null; files: string[]; toHead?: string | null; storedId?: number; task?: number | null; runs?: number[] | null; attempt?: number; source?: FixupSource; note: StageEventRow | null; jobNote: string | null }): Promise<void> { throw new Error("not built: changes.finishPatch"); }
/** Sets rows to `superseded` and clears their patch. Returns the rows changed. */
export async function supersedePatches(db: Db, rows: { kind: PatchKind; id: number }[], reason: string): Promise<number> { throw new Error("not built: changes.supersedePatches"); }
/** Records whether a conflict merge kept the diff; one `updateFrom`. */
export async function setOwnDiff(db: Db, rows: { repo: string; number: number; toHead: string; ownDiff: string; ownDelta: string }[]): Promise<void> { throw new Error("not built: changes.setOwnDiff"); }
/** Marks CI-fix rows as rerunning infrastructure checks. */
export async function startInfraRerun(db: Db, rows: CifixRerunRow[]): Promise<void> { throw new Error("not built: changes.startInfraRerun"); }
/** Closes the infrastructure rerun rows. */
export async function finishInfraRerun(db: Db, rows: (CifixRerunRow & { state: string; reason: string | null })[]): Promise<void> { throw new Error("not built: changes.finishInfraRerun"); }
/** Clears the stored session text of rows whose session directory was removed. Returns the rows changed. */
export async function clearSessions(db: Db, rows: SessionClear[]): Promise<number> { throw new Error("not built: changes.clearSessions"); }

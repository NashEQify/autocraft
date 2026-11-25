// Set loaders for the planner pass and the steps.
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { LintingRow, PatchCheckRow, PatchFacts, PatchKind, PushEdge, RefKey, StoredPatch } from "./types.ts";

/** Patch rows of the three tables and the derived push edges for each PR of `keys`. 3 statements, no blobs. */
export async function loadPatchFacts(db: Db, keys: KeySource): Promise<Map<RefKey, PatchFacts>> { throw new Error("not built: changes.loadPatchFacts"); }
/** Push edges (`to_head` set, state pushing, pushed or merged) per PR. 3 statements. */
export async function loadPushEdges(db: Db, keys: KeySource): Promise<Map<RefKey, PushEdge[]>> { throw new Error("not built: changes.loadPushEdges"); }
/** Rows in state `linting` with their patch, for the step's lint actions. */
export async function loadStoredPatches(db: Db, keys: KeySource, kinds?: PatchKind[]): Promise<StoredPatch[]> { throw new Error("not built: changes.loadStoredPatches"); }
/** Linting rows with the count of `comment-unsent` siblings at the same head (CI fixes), for `dropUnlisted`. */
export async function loadLintingRows(db: Db, keys: KeySource): Promise<LintingRow[]> { throw new Error("not built: changes.loadLintingRows"); }
/** The newest operator fix-up row of each request id. */
export async function loadOperatorFixResults(db: Db, fixIds: number[]): Promise<Map<number, { state: string; toHead: string | null; reason: string | null }>> { throw new Error("not built: changes.loadOperatorFixResults"); }
/** The newest pushed fix-up row with source review or operator per PR; `lines` is computed from the patch, which is not returned. */
export async function loadLatestFixPushes(db: Db, keys: KeySource): Promise<Map<RefKey, { fromHead: string; createdAt: string; source: string | null; lines: number; files: string[] }>> { throw new Error("not built: changes.loadLatestFixPushes"); }
/** The newest non-superseded fix-up row at each (PR, head); key is `repo#number@head`. */
export async function loadLatestFixupAt(db: Db, pairs: { ref: RefKey; head: string }[]): Promise<Map<string, { state: string; reason: string | null }>> { throw new Error("not built: changes.loadLatestFixupAt"); }
/** Patch checks per PR, oldest first. */
export async function loadPatchChecks(db: Db, keys: KeySource): Promise<Map<RefKey, PatchCheckRow[]>> { throw new Error("not built: changes.loadPatchChecks"); }
/** The newest `patch_checks` verdict of kind `fixup` at each subject; key is `repo#number@subject`. */
export async function loadFixupVerdicts(db: Db, pairs: { ref: RefKey; subject: string }[]): Promise<Map<string, "approve" | "reject">> { throw new Error("not built: changes.loadFixupVerdicts"); }

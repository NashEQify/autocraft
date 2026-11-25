// Merge attempts (`merges`) (package merge-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { AttemptInput, MergeRow, MergedInfo, RefKey } from "./types.ts";

/** The merged half of `loadMergeFacts` for callers outside the planner. 1 statement. */
export async function loadMergedInfo(db: Db, keys: KeySource): Promise<Map<RefKey, MergedInfo>> { throw new Error("not built: merge.loadMergedInfo"); }
/** Attempt rows with `rowid`, newest first, for the activity feed, trace and item browser. 1 statement. */
export async function listMerges(db: Db, f: { refs?: KeySource; repo?: string; since?: string; outcome?: "merged" | "refused"; after?: number; limit?: number }): Promise<MergeRow[]> { throw new Error("not built: merge.listMerges"); }
/** Distinct merged refs and the number of attempts since `f.since`, in one grouped statement. */
export async function countMerges(db: Db, f: { since: string; repos?: string[] }): Promise<{ mergedRefs: RefKey[]; tries: number }> { throw new Error("not built: merge.countMerges"); }
/**
 * Records attempts in one `db.write`: one multi-row insert into `merges`; for merged rows the mirror write-through, the `merged`
 * stage event and the audit row; for refused rows whose reason is `action_required`, the reread mark. At most 5 statements.
 */
export async function recordAttempts(db: Db, rows: AttemptInput[]): Promise<void> { throw new Error("not built: merge.recordAttempts"); }

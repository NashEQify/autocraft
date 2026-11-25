// Verifications (`verifications`) (package merge-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { HeadRef, PendingVerification, RefKey, SavedVerification, VerificationSettle, VerificationState, VerificationView, VerifyDue } from "./types.ts";

/** Verification rows per head with their tasks: rows, then `build.loadTasks` in a second wave. */
export async function loadVerifications(db: Db, keys: KeySource, o?: { heads?: boolean }): Promise<Map<HeadRef, VerificationView>> { throw new Error("not built: merge.loadVerifications"); }
/** One-key wrapper for the merge-time read. */
export async function verificationOf(db: Db, repo: string, number: number, head: string): Promise<VerificationView | undefined> { throw new Error("not built: merge.verificationOf"); }
/** Verification rows by state and repo, with tasks. */
export async function listVerifications(db: Db, f: { states?: VerificationState[]; repo?: string; limit?: number }): Promise<VerificationView[]> { throw new Error("not built: merge.listVerifications"); }
/** The newest verification of each ref with its head. */
export async function loadLatestVerification(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, { head: string; view: VerificationView }>> { throw new Error("not built: merge.loadLatestVerification"); }
/** Whether verifications or screenshots are due, in one fused statement. */
export async function loadVerifyDue(db: Db): Promise<VerifyDue> { throw new Error("not built: merge.loadVerifyDue"); }
/** Rows `planned` or `running` with item state, current head and scope; task states from `build.loadTaskStates`. */
export async function loadPendingVerifications(db: Db): Promise<PendingVerification[]> { throw new Error("not built: merge.loadPendingVerifications"); }
/** Multi-row upsert of verifications with their stage events, in one `db.write`. */
export async function saveVerifications(db: Db, rows: SavedVerification[]): Promise<void> { throw new Error("not built: merge.saveVerifications"); }
/** Compare-and-set settle of verification rows with stage events; returns the keys changed. */
export async function settleVerifications(db: Db, rows: VerificationSettle[]): Promise<Set<HeadRef>> { throw new Error("not built: merge.settleVerifications"); }
/** Retry path: points rows at their cloned tasks and plans them again. */
export async function restartVerifications(db: Db, rows: { key: HeadRef; headTask: number | null; baseTask: number | null }[]): Promise<void> { throw new Error("not built: merge.restartVerifications"); }
/** Marks verifications stale. Returns the rows changed. */
export async function markVerificationsStale(db: Db, keys: HeadRef[], by?: string): Promise<number> { throw new Error("not built: merge.markVerificationsStale"); }

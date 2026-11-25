// PR builds (`pr_builds`) (package merge-b).
import type { Db } from "../../db/index.ts";
import type { HeadRef, LateDisagreement, NewPrBuild, PendingBuild, PrBuildSettle, PrBuildView, RefKey } from "./types.ts";

/** PR build rows per ref (at its head, when given) with task states in a second wave. */
export async function loadPrBuildViews(db: Db, items: { ref: RefKey; head: string | null }[]): Promise<Map<RefKey, PrBuildView>> { throw new Error("not built: merge.loadPrBuildViews"); }
/** Builds created since the cutoff and the `number@head` set the repo already has. 2 statements in one wave. */
export async function loadPrBuildState(db: Db, repo: string, sinceMs: number): Promise<{ usedSince: number; have: Set<string> }> { throw new Error("not built: merge.loadPrBuildState"); }
/** Queued builds with item state and current head; task states from `build.loadTaskStates`. */
export async function loadPendingPrBuilds(db: Db, repo?: string): Promise<PendingBuild[]> { throw new Error("not built: merge.loadPendingPrBuilds"); }
/** Builds whose CI answer came late and disagrees. */
export async function loadLateDisagreements(db: Db, repo?: string): Promise<LateDisagreement[]> { throw new Error("not built: merge.loadLateDisagreements"); }
/** Repos with a queued build. */
export async function listReposWithQueuedBuilds(db: Db): Promise<string[]> { throw new Error("not built: merge.listReposWithQueuedBuilds"); }
/** Inserts rows, creates their build tasks and links them, in one `db.write`; returns the task id per head newly queued. */
export async function queuePrBuilds(db: Db, rows: NewPrBuild[]): Promise<Map<HeadRef, number>> { throw new Error("not built: merge.queuePrBuilds"); }
/** Records builds that could not be queued. */
export async function savePrBuildErrors(db: Db, rows: { repo: string; number: number; head: string; scope: string; summary: string }[]): Promise<void> { throw new Error("not built: merge.savePrBuildErrors"); }
/** Compare-and-set settle of builds; returns the keys changed. */
export async function settlePrBuilds(db: Db, rows: PrBuildSettle[]): Promise<Set<HeadRef>> { throw new Error("not built: merge.settlePrBuilds"); }
/** Retry: new task id and `retried + 1`. */
export async function restartPrBuilds(db: Db, rows: { key: HeadRef; taskId: number }[]): Promise<void> { throw new Error("not built: merge.restartPrBuilds"); }

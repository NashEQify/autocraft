// Writers of attempts and rounds. Atomic on their own (`db.write`, joining an outer transaction) and take sets.
import type { Db } from "../../db/index.ts";
import type { AttemptGuidance, AttemptStep, Implementation, RefKey, StartAttempt } from "./types.ts";

/** Starts attempts in state `planning` with `attempt = max + 1`, refusing an issue that has a current attempt. 1 statement. */
export async function startAttempts(db: Db, rows: StartAttempt[], at?: string): Promise<{ started: Implementation[]; refused: { ref: RefKey; current: { id: number; state: string } }[] }> { throw new Error("not built: implement.startAttempts"); }
/** One-row wrapper over `startAttempts`. */
export async function startAttempt(db: Db, row: StartAttempt, at?: string): Promise<Implementation | null> { throw new Error("not built: implement.startAttempt"); }
/** Applies moves, round inserts and round-result updates in one transaction with compare-and-set guards; a guarded step that did not match adds nothing. */
export async function recordSteps(db: Db, steps: AttemptStep[], at?: string): Promise<{ applied: Map<number, boolean>; roundIds: Map<number, number[]> }> { throw new Error("not built: implement.recordSteps"); }
/** "Try again" on an attempt without a PR: moves the old attempt to `failed` and starts the next, with the guidance round on the new id. */
export async function restartAttempt(db: Db, o: { id: number; reason: string; queuedBy: string; textHash: string; guidance?: AttemptGuidance; at?: string }): Promise<Implementation> { throw new Error("not built: implement.restartAttempt"); }
/** "Try again" on a stuck revision: copies the newest `revise` round with the guidance appended and moves `stuck` to `revising`. */
export async function retryRevision(db: Db, o: { id: number; guidance?: AttemptGuidance; at?: string }): Promise<boolean> { throw new Error("not built: implement.retryRevision"); }
/** Cancels attempts without a PR and records `implement-cancel` audit rows; the caller ends the returned workspaces. */
export async function cancelUnopened(db: Db, rows: { repo: string; number: number; reason: string }[], by: string, at?: string): Promise<{ id: number; repo: string; number: number; workspaceId: number | null }[]> { throw new Error("not built: implement.cancelUnopened"); }
/** One multi-row insert of `answer` rounds when a person answers an `asked` or `stuck` recommendation; writes no state change. */
export async function recordAnswers(db: Db, rows: { id: number; question: number; by: string; via: string; option?: string; text?: string }[], at?: string): Promise<number> { throw new Error("not built: implement.recordAnswers"); }

// Call reads (package runners-a).
import type { Db } from "../../db/index.ts";
import type { CallPoll, CallSummary, LowerLogin, QueueSnapshot } from "./types.ts";

/** Summaries of calls by id. 1 statement. */
export async function loadCalls(db: Db, ids: number[]): Promise<Map<number, CallSummary>> { throw new Error("not built: runners.loadCalls"); }
/** The reply and its call; `alone` because the reply is up to 4 MB. */
export async function loadCallReply(db: Db, id: number): Promise<{ promptId: string; items: { repo: string; number: number }[]; reply: string | null; state: string; runId: number | null } | null> { throw new Error("not built: runners.loadCallReply"); }
/** The call row, liveness stamp, lost-lease and gone-caller reads in one wave. */
export async function loadCallPoll(db: Db, id: number, now: number): Promise<CallPoll> { throw new Error("not built: runners.loadCallPoll"); }
/** Set form of `loadCallPoll`: one poller per process reads every call it waits on in one wave every 3 s. */
export async function loadCallPolls(db: Db, ids: number[], nowMs: number): Promise<Map<number, CallPoll>> { throw new Error("not built: runners.loadCallPolls"); }
/** `GROUP BY job_id`: whether each job has queued calls and when the last lease was taken. */
export async function loadRemoteQueueStates(db: Db, jobIds: number[], now: number): Promise<Map<number, { queued: boolean; lastLeaseAt: number | null }>> { throw new Error("not built: runners.loadRemoteQueueStates"); }
/** The agent run id of each call. */
export async function loadRunIdsOfCalls(db: Db, callIds: number[]): Promise<Map<number, number>> { throw new Error("not built: runners.loadRunIdsOfCalls"); }
/** Run id to leasing token for leased calls and calls ended after `since`. */
export async function loadLeaseTokenByRun(db: Db, since: number): Promise<Map<number, number>> { throw new Error("not built: runners.loadLeaseTokenByRun"); }
/** Lease turnover per login (`GROUP BY lower(user_login)`). */
export async function loadLeaseTurnover(db: Db, logins: string[]): Promise<Map<LowerLogin, string>> { throw new Error("not built: runners.loadLeaseTurnover"); }
/**
 * Every queued call in claim order (follow-ups first). Cached per `Db` for 2 s and keyed by the (count, newest id) signature; every
 * writer that changes the queue drops the cache. A miss is one wave of 5 statements, a hit one.
 */
export async function loadQueue(db: Db, now: number): Promise<QueueSnapshot> { throw new Error("not built: runners.loadQueue"); }

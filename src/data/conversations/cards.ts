// Action cards and the Act queue (M12 conversations).
import type { Db } from "../../db/index.ts";
import type { ActRoom, CardPatch, CardRow, CardState, Queue } from "./types.ts";

/** Cards by id. */
export async function loadCards(db: Db, ids: number[]): Promise<Map<number, CardRow>> {
  throw new Error("not built: conversations.loadCards");
}

/** Queued cards ordered by rank level (`triage.fragments.rankLevel`), `queued_at`, id; unless `all`, rows of repos Act cannot run for are left out through `control.loadActBlocked` in the same wave. */
export async function loadQueue(db: Db, o?: { all?: boolean }): Promise<Queue> {
  throw new Error("not built: conversations.loadQueue");
}

/** Cards running since `sinceIso` (the reserve). */
export async function loadRunningCards(db: Db, sinceIso: string): Promise<CardRow[]> {
  throw new Error("not built: conversations.loadRunningCards");
}

/** Composes `control.loadActLimit`, `control.loadActUsage` and `control.countCardWrites` in one wave. */
export async function loadActRoom(db: Db, now: Date): Promise<ActRoom> {
  throw new Error("not built: conversations.loadActRoom");
}

/** Compare-and-set on `state IN from`; the writer behind edit, dismiss, claim and finish. */
export async function markCard(db: Db, id: number, from: CardState[], set: CardPatch): Promise<boolean> {
  throw new Error("not built: conversations.markCard");
}

/** Queued cards that cannot run; drain failures. */
export async function failCards(db: Db, ids: number[], error: string, at: string, from: CardState): Promise<number> {
  throw new Error("not built: conversations.failCards");
}

/** Marks running cards older than the cutoff failed. */
export async function sweepRunningCards(db: Db, cutoffIso: string): Promise<number> {
  throw new Error("not built: conversations.sweepRunningCards");
}

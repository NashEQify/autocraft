// Held follow-up issues (M12 conversations).
import type { Db } from "../../db/index.ts";
import type { DueHeld, HeldPatch, HeldState, NewHeld, RefKey, HeldRow } from "./types.ts";

/** Multi-row insert `returning id`; written inside the press transaction. */
export async function addHeld(db: Db, rows: NewHeld[]): Promise<number[]> {
  throw new Error("not built: conversations.addHeld");
}

/** The item page's follow-ups. */
export async function loadHeld(db: Db, refs: RefKey[]): Promise<Map<RefKey, HeldRow[]>> {
  throw new Error("not built: conversations.loadHeld");
}

/** Open rows with item state, `workflow.loadPathEnds` and the filing audit in one wave; the verdict stays pure code. */
export async function loadDueHeld(db: Db, o: { repo?: string; now: Date }): Promise<DueHeld> {
  throw new Error("not built: conversations.loadDueHeld");
}

/** One `updateFrom` per chunk joined on `id AND state = from`; returns the ids that moved. */
export async function markHeld(db: Db, moves: { id: number; from: HeldState; set: HeldPatch }[]): Promise<Set<number>> {
  throw new Error("not built: conversations.markHeld");
}

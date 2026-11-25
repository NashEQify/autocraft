// Jev answers that were unsure (`jev_unsure`).
import type { Db } from "../../db/index.ts";

/** Stored unsure answers per ref. */
export async function loadUnsure(db: Db, promptId: string, refs: string[]): Promise<Map<string, { hash: string; answer: string }>> { throw new Error("not built: inference.loadUnsure"); }
/** Upserts `keep` and deletes `drop` in one `db.write`. */
export async function saveUnsure(db: Db, o: { promptId: string; keep: { ref: string; hash: string; answer: string; at: string }[]; drop: string[] }): Promise<void> { throw new Error("not built: inference.saveUnsure"); }
/** Deletes rows whose item is not open and tracked; `openOf` is the mirror loader the caller supplies. */
export async function pruneUnsure(db: Db, nowMs: number, openOf: (refs: string[]) => Promise<Set<string>>): Promise<number> { throw new Error("not built: inference.pruneUnsure"); }

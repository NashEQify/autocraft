// Write-through after a GitHub write and the sync item writer (M01 mirror-a).
import type { Db } from "../../db/index.ts";
import type { ItemEntry, LocalPatch, RefKey, SaveItemsOptions, ItemRowInput } from "./types.ts";

/** The one writer for local state after a GitHub write: one `db.write`, one statement per patch kind present, audit rows through `control.addAudit`, and a `diff_facts` delete for a `base` patch. */
export async function applyLocal(db: Db, patches: LocalPatch[]): Promise<{ changed: RefKey[] }> {
  throw new Error("not built: mirror.applyLocal");
}

/** The sync writer: one `db.write`, per chunk of 500 entries a read of the stored rows, an upsert of changed items, text refs, author ids, comments and `item_reads`; the org high water is advanced last, in the same transaction. */
export async function saveItems(db: Db, entries: ItemEntry[], o: SaveItemsOptions): Promise<{ stored: number }> {
  throw new Error("not built: mirror.saveItems");
}

/** Marks items GitHub no longer returns as closed and writes `item-gone` audit rows. */
export async function closeGoneItems(db: Db, refs: RefKey[], now: string): Promise<number> {
  throw new Error("not built: mirror.closeGoneItems");
}

/** Fills missing embed and class hashes in batches of 2,000; the hash function is passed in so the module imports no classifier code. */
export async function fillItemHashes(db: Db, hash: (row: ItemRowInput) => { embed_hash: string | null; class_hash: string | null; class_scheme: string | null }): Promise<number> {
  throw new Error("not built: mirror.fillItemHashes");
}

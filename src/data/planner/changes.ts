// The change log that drives incremental passes (`item_changes`, `plan_full`, `plan_full_causes`, `plan_bulk`).
import type { Db } from "../../db/index.ts";
import type { ChangeCursor, Changes } from "./types.ts";

/** The change log's generation and the seqs already read. 2 statements in one wave; rides in the pass's wave. */
export async function loadChangeCursor(db: Db): Promise<ChangeCursor> { throw new Error("not built: planner.loadChangeCursor"); }
/** Refs logged since the cursor, or `full` with its cause. 2 statements in one wave. */
export async function readChanges(db: Db, cursor: ChangeCursor): Promise<Changes> { throw new Error("not built: planner.readChanges"); }
/** Deletes exactly the seqs the cursor read, as ranges of consecutive seqs; joins the caller's transaction. Does not mutate the cursor. */
export async function pruneChanges(db: Db, cursor: ChangeCursor): Promise<number> { throw new Error("not built: planner.pruneChanges"); }
/** Logs refs as changed; 1 statement. */
export async function logChanged(db: Db, refs: { repo: string; number: number }[]): Promise<void> { throw new Error("not built: planner.logChanged"); }
/** Starts a bulk write (SQLite: `plan_bulk` row; Postgres: transaction-local `ac.bulk`). Throws outside `db.write`. */
export async function beginBulk(db: Db): Promise<void> { throw new Error("not built: planner.beginBulk"); }
/** Ends a bulk write and takes one full-pass mark named `bulk:<source>`. Throws outside `db.write`. */
export async function endBulk(db: Db, source: string): Promise<void> { throw new Error("not built: planner.endBulk"); }

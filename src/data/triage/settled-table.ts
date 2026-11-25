// The settled table `item_settled*`, kept lazily from triggers on `classifications` (M08 triage-a).
import type { Db } from "../../db/index.ts";

/** Reads the current run with its built and dirty state; when stale, rebuilds or refreshes in one `db.write` (a no-op inside `db.read`). */
export async function currentRunReady(db: Db): Promise<string | null> {
  throw new Error("not built: triage.currentRunReady");
}

/** The same for a caller that already has a run (the Items page's `?run=`). */
export async function ensureSettled(db: Db, run: string | null): Promise<void> {
  throw new Error("not built: triage.ensureSettled");
}

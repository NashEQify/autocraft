// Fix attempts that were still moving (retry, testing or passed) when Implement replaced the Fix stage's text-only patches
// end as failed; their rows are kept. Runs with every schema migration, on SQLite in backfill() (src/db.ts) and on Postgres
// inside migratePg's transaction (src/db/pg-triggers.ts); no step writes those states any more, so a second run changes nothing.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-triggers.ts";

export const FIX_RETIRED_REASON = "retired: replaced by Implement";

const SQL = (main: string, p: (n: number) => string) =>
  `UPDATE ${main}fix_attempts SET state = 'failed', reason = ${p(1)}, updated_at = ${p(2)} WHERE state IN ('retry', 'testing', 'passed')`;

export function retireFixAttemptsSqlite(db: DatabaseSync, at = new Date().toISOString()): void {
  db.prepare(SQL("main.", () => "?")).run(FIX_RETIRED_REASON, at);
}

export async function retireFixAttemptsPg(client: PgClient, at = new Date().toISOString()): Promise<void> {
  await client.query(SQL("", (n) => `$${n}`), [FIX_RETIRED_REASON, at]);
}

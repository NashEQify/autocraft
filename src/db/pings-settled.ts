// Once: status comments that repos with the PR status switch on showed before their questions were pinged count those questions as
// pinged (pr_status_comments.pinged, src/prstatus/ping.ts), so the first run pings no question those repos' maintainers already saw. The
// comments of started items in other repos, which nobody was told about, are left to ping once. Runs on SQLite with backfill() (src/db.ts)
// and on Postgres inside migratePg's transaction (src/db/pg-triggers.ts); the PINGS_SETTLED_DONE marker makes a second run change nothing.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-triggers.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the migration; the marker decides whether it runs. */
export const PINGS_SETTLED_VERSION = 1;
export const PINGS_SETTLED_DONE = "status_pings_settled";

// The question key is `<workflow id>:<rec_at>` of the item's latest workflow while it asks (workflow ASKING_STATES).
const QUESTION = (main: string) => `SELECT CAST(w.id AS TEXT) || ':' || COALESCE(w.rec_at, '') FROM ${main}item_workflows w
  WHERE w.repo = pr_status_comments.repo AND w.number = pr_status_comments.number AND w.state IN ('recommending', 'blocked') AND w.rec IS NOT NULL
    AND w.id = (SELECT MAX(m.id) FROM ${main}item_workflows m WHERE m.repo = w.repo AND m.number = w.number)`;

const STATEMENTS = (main: string): string[] => {
  const undone = `NOT EXISTS (SELECT 1 FROM ${main}settings m WHERE m.key = '${PINGS_SETTLED_DONE}')`;
  return [
    `UPDATE ${main}pr_status_comments SET pinged = (${QUESTION(main)})
      WHERE ${undone} AND comment_id IS NOT NULL AND pinged IS NULL AND final = 0 AND EXISTS (${QUESTION(main)})
        AND repo IN (SELECT a.repo FROM ${main}repo_step_approvals a WHERE a.step = 'prstatus')`,
    `INSERT INTO ${main}settings (key, value) VALUES ('${PINGS_SETTLED_DONE}', '1') ON CONFLICT (key) DO NOTHING`,
  ];
};

export function pingsSettledSqlite(db: DatabaseSync): void {
  for (const q of STATEMENTS("main.")) db.exec(q);
}

export async function pingsSettledPg(client: PgClient): Promise<void> {
  for (const q of STATEMENTS("")) await client.query(q);
}

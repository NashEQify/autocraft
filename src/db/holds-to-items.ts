// Once: every merge hold (`merge_holds`) of an open pull request becomes a held item, as the command `hold` leaves one (src/workflow/apply.ts):
// its live workflow, or the one of the issue it implements, is held with what a resume goes back to; a pull request nobody started gets
// a held row. One that a person already took out of the pipeline stays as it is. The rows go. Merge legs and queued steps of the held
// workflows end with the pre-approval pass. Runs on SQLite with the value migrations of connect() (src/db.ts) and on Postgres inside
// migratePg's transaction (src/db/pg-triggers.ts).
import type { DatabaseSync } from "node:sqlite";
import type { HeldWork } from "../workflow/types.ts";
import type { PgClient } from "./pg-triggers.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the migration; the marker decides whether it runs. */
export const HOLDS_TO_ITEMS_VERSION = 1;
export const HOLDS_TO_ITEMS_DONE = "merge_holds_to_items";

const LIVE = "('running', 'waiting', 'blocked', 'recommending')";
type HoldRow = {
  repo: string; number: number | string; held_by: string; held_at: string; head: string | null;
  id: number | string | null; state: string | null; rec: string | null; blocker: string | null; blocker_params: string | null; last: string | null;
};
type Mark = (n: number) => string;
type Write = { sql: (main: string, p: Mark) => string; args: (string | number | null)[] };

const DONE_READ = (main: string): string => `SELECT 1 FROM ${main}settings WHERE key = '${HOLDS_TO_ITEMS_DONE}'`;
// The live workflow of the pull request itself comes before the one of its issue.
const ROWS_SQL = (main: string): string => `SELECT h.repo, h.number, h.held_by, h.held_at, i.head_oid AS head, w.id, w.state, w.rec, w.blocker, w.blocker_params,
    (SELECT l.state FROM ${main}item_workflows l WHERE l.repo = h.repo AND l.number = h.number ORDER BY l.id DESC LIMIT 1) AS last
  FROM ${main}merge_holds h JOIN ${main}items i ON i.repo = h.repo AND i.number = h.number AND i.kind = 'pr' AND i.state = 'OPEN'
  LEFT JOIN ${main}item_workflows w ON w.id = (SELECT x.id FROM ${main}item_workflows x WHERE x.repo = h.repo AND x.state IN ${LIVE}
    AND (x.number = h.number OR (x.entry = 'implement' AND x.pr_number = h.number)) ORDER BY CASE WHEN x.number = h.number THEN 0 ELSE 1 END, x.id DESC LIMIT 1)
  ORDER BY h.repo, h.number`;

function json(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** The held work of a live row, as holdPatch (src/workflow/apply.ts) makes it. */
function heldWork(r: HoldRow): HeldWork {
  const rec = r.state === "recommending" || r.state === "blocked" ? json(r.rec) : null;
  if (!rec) return {};
  const params = r.blocker === null ? null : json(r.blocker_params);
  return { rec, ...(r.blocker === null ? {} : { blocker: r.blocker }), ...(params ? { params } : {}) } as HeldWork;
}

function writesOf(rows: HoldRow[], at: string): Write[] {
  const done = new Set<number>();
  return rows.flatMap((r): Write[] => {
    if (r.id !== null) {
      // Two held pull requests of one workflow hold it once.
      if (done.has(Number(r.id))) return [];
      done.add(Number(r.id));
      return [{
        sql: (main, p) => `UPDATE ${main}item_workflows SET state = 'stopped', stopped_by = ${p(1)}, stopped_at = ${p(2)}, rec = NULL, blocker = NULL, blocker_params = ${p(3)}, updated_at = ${p(4)}, version = version + 1 WHERE id = ${p(5)}`,
        args: [r.held_by, r.held_at, JSON.stringify({ held: heldWork(r) }), at, Number(r.id)],
      }];
    }
    if (r.last !== null && ["stopped", "backlog", "closed"].includes(r.last)) return [];
    const unstarted: HeldWork = { unstarted: true };
    return [{
      sql: (main, p) => `INSERT INTO ${main}item_workflows (repo, number, kind, entry, weight, state, started_by, started_at, started_via, base_head, accepted_head, stopped_by, stopped_at, blocker_params, plan, updated_at)
        VALUES (${[1, 2].map(p).join(", ")}, 'pr', 'review', 5, 'stopped', ${[3, 4].map(p).join(", ")}, 'cli', ${[5, 6, 7, 8, 9].map(p).join(", ")}, '[]', ${p(10)})`,
      args: [r.repo, Number(r.number), r.held_by, r.held_at, r.head, r.head, r.held_by, r.held_at, JSON.stringify({ held: unstarted }), at],
    }];
  });
}

const CLEAR_SQL = (main: string): string => `DELETE FROM ${main}merge_holds`;
const DONE_SQL = (main: string, p: Mark): string => `INSERT INTO ${main}settings (key, value) VALUES ('${HOLDS_TO_ITEMS_DONE}', ${p(1)}) ON CONFLICT (key) DO NOTHING`;

export function holdsToItemsSqlite(db: DatabaseSync, at = new Date().toISOString()): void {
  if (db.prepare(DONE_READ("main.")).get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare(DONE_READ("main.")).get()) {
      for (const w of writesOf(db.prepare(ROWS_SQL("main.")).all() as unknown as HoldRow[], at)) db.prepare(w.sql("main.", () => "?")).run(...w.args);
      db.exec(CLEAR_SQL("main."));
      db.prepare(DONE_SQL("main.", () => "?")).run(at);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The Postgres form, on the migration connection inside its transaction. */
export async function holdsToItemsPg(client: PgClient, at = new Date().toISOString()): Promise<void> {
  if ((await client.query(DONE_READ(""))).rows.length) return;
  for (const w of writesOf((await client.query(ROWS_SQL(""))).rows as HoldRow[], at)) await client.query(w.sql("", (n) => `$${n}`), w.args);
  await client.query(CLEAR_SQL(""));
  await client.query(DONE_SQL("", (n) => `$${n}`), [at]);
}

// Breaker rows of a whole push stage (`fixup`, `cifix`, `fixissue`, `merge` in stage_trips, from before every push stage tripped
// per repo) become per-repo rows (`<stage>:<repo>`, splitStageTrips in core/push-outcome.ts) and are then deleted; the audit log
// keeps their trips and resumes. Runs on SQLite with the value migrations of connect() (src/db.ts) and on Postgres inside
// migratePg's transaction (src/db/pg-triggers.ts).
import type { DatabaseSync } from "node:sqlite";
import { splitStageTrips, TRIP_STAGES, type StageTripRow, type TripStage } from "../core/push-outcome.ts";
import type { PgClient } from "./pg-triggers.ts";

/** Bump when splitStageTripsPg changes what it does: it is part of the Postgres stamp, so a database migrated before runs it again. */
export const TRIP_SPLIT_VERSION = 1;

const STAGE_ROWS = `stage IN (${TRIP_STAGES.map((s) => `'${s}'`).join(", ")})`;
const COLS = "stage, active, reason, evidence, tripped_at, cleared_at, cleared_by";
const ROWS_SQL = (main: string) => `SELECT ${COLS} FROM ${main}stage_trips WHERE ${STAGE_ROWS}`;
const KEYS_SQL = (main: string) => `SELECT stage FROM ${main}stage_trips`;
// Repos whose earlier pushes or merges count for a stage's breaker: those the last resume of a stage row carries to.
const REPOS_SQL = (main: string) => `SELECT DISTINCT stage, repo FROM ${main}push_outcomes UNION SELECT DISTINCT 'merge', repo FROM ${main}merges WHERE outcome = 'merged'`;
const INSERT_SQL = (main: string, p: (n: number) => string) => `INSERT INTO ${main}stage_trips (${COLS}) VALUES (${[1, 2, 3, 4, 5, 6, 7].map(p).join(", ")})`;
const DELETE_SQL = (main: string) => `DELETE FROM ${main}stage_trips WHERE ${STAGE_ROWS}`;

const reposBy = (rows: { stage: string; repo: string }[]) => (stage: TripStage): string[] => [...new Set(rows.filter((r) => r.stage === stage).map((r) => r.repo))].sort();
const values = (r: StageTripRow) => [r.stage, r.active, r.reason, r.evidence, r.tripped_at, r.cleared_at, r.cleared_by];

export function splitStageTripsSqlite(db: DatabaseSync): void {
  if (!db.prepare(`SELECT 1 FROM main.stage_trips WHERE ${STAGE_ROWS} LIMIT 1`).get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(ROWS_SQL("main.")).all() as StageTripRow[];
    if (rows.length) {
      const existing = new Set((db.prepare(KEYS_SQL("main.")).all() as { stage: string }[]).map((r) => r.stage));
      const insert = db.prepare(INSERT_SQL("main.", () => "?"));
      for (const r of splitStageTrips(rows, reposBy(db.prepare(REPOS_SQL("main.")).all() as { stage: string; repo: string }[]), existing)) insert.run(...values(r));
      db.exec(DELETE_SQL("main."));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The Postgres form, on the migration connection inside its transaction. */
export async function splitStageTripsPg(client: PgClient): Promise<void> {
  // bigint columns come back as text from pg.
  const rows = ((await client.query(ROWS_SQL(""))).rows as StageTripRow[]).map((r) => ({ ...r, active: Number(r.active) }));
  if (!rows.length) return;
  const existing = new Set(((await client.query(KEYS_SQL(""))).rows as { stage: string }[]).map((r) => r.stage));
  const repos = (await client.query(REPOS_SQL(""))).rows as { stage: string; repo: string }[];
  for (const r of splitStageTrips(rows, reposBy(repos), existing)) await client.query(INSERT_SQL("", (n) => `$${n}`), values(r));
  await client.query(DELETE_SQL(""));
}

// premerge_followups is keyed by source as well as head (src/schema.sql): a table made before it had no source column, and
// every row it holds is a pre-merge review's. The migration moves those rows aside, drops the table so the schema creates
// it in its current shape, and copies them back as source 'premerge' (both dialects, so an upgraded database ends with the
// same table as a new one). Each half is idempotent: a migration stopped between them finishes on its next run.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-migrate.ts";

/** Where the rows wait while the table is made again. */
const ASIDE = "premerge_followups_unsourced";
const COLS = "repo, number, head_oid, issue_number, url, state, at, note";

// `WHERE true`: SQLite reads ON CONFLICT right after a FROM as a join constraint.
const copyBack = (prefix: string) =>
  `INSERT INTO ${prefix}premerge_followups (repo, number, source, head_oid, issue_number, url, state, at, note)
     SELECT repo, number, 'premerge', head_oid, issue_number, url, state, at, note FROM ${prefix}${ASIDE} WHERE true
     ON CONFLICT (repo, number, source, head_oid) DO NOTHING`;

/** Before the schema: moves an unsourced table's rows aside and drops it. */
export function followupsAsideSqlite(db: DatabaseSync): void {
  const cols = db.prepare("SELECT name FROM pragma_table_info('premerge_followups', 'main')").all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === "source")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS main.${ASIDE} AS SELECT ${COLS} FROM main.premerge_followups WHERE 0`);
    db.exec(`INSERT INTO main.${ASIDE} SELECT ${COLS} FROM main.premerge_followups; DROP TABLE main.premerge_followups`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** After the schema: copies the rows moved aside back as the pre-merge review's. */
export function followupsBackSqlite(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(ASIDE)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${copyBack("main.")}; DROP TABLE main.${ASIDE}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Before the schema step, inside a migration step: as followupsAsideSqlite. */
export async function followupsAsidePg(client: PgClient): Promise<void> {
  const r = (await client.query(`SELECT to_regclass('premerge_followups') IS NOT NULL AS t,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'premerge_followups' AND column_name = 'source') AS s`)).rows[0];
  if (!r?.t || r.s) return;
  await client.query(`CREATE TABLE IF NOT EXISTS ${ASIDE} AS SELECT ${COLS} FROM premerge_followups WHERE false`);
  await client.query(`INSERT INTO ${ASIDE} SELECT ${COLS} FROM premerge_followups`);
  await client.query("DROP TABLE premerge_followups");
}

/** After the schema step, inside a migration step: as followupsBackSqlite. */
export async function followupsBackPg(client: PgClient): Promise<void> {
  if (!(await client.query(`SELECT to_regclass('${ASIDE}') IS NOT NULL AS t`)).rows[0]?.t) return;
  await client.query(copyBack(""));
  await client.query(`DROP TABLE ${ASIDE}`);
}

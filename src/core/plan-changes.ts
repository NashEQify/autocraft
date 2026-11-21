// The change log of the planner's inputs: triggers on every table of PLAN_INPUTS log the items a write re-decides in
// `item_changes`, or move the full-pass marker when the write changes facts of items the trigger cannot name. A planner
// reads what changed since the seq it consumed (changesSince) and deletes what it consumed (pruneChanges).
//
// Seqs come from one AUTOINCREMENT sequence, so they never repeat after a prune. A full-pass mark takes the next seq of that
// sequence without adding a row: `plan_full` holds the seq of the latest one, and changesSince compares it with the caller's.
import type { DatabaseSync } from "node:sqlite";
import { BOOKKEEPING_COLUMNS, columnsOf } from "../live.ts";
import { PLAN_INPUTS, type PlanInput } from "./plan-inputs.ts";
import type { Db } from "../db/index.ts";

/** More logged rows than this since the caller's seq: a full pass costs less than re-deciding them one by one. */
export const CHANGES_CAP = 50_000;

export type Changes = {
  /** Items whose facts may have changed, as "repo#number". Empty when `full`. */
  refs: string[];
  /** Every item must be decided again: a global or cross-item input changed, or the log passed CHANGES_CAP. */
  full: boolean;
  /** Why `full`: a full-pass mark, or more rows than CHANGES_CAP. */
  cause?: "marker" | "cap";
  /** The seq this answer covers: pass it to the next changesSince and to pruneChanges. */
  seq: number;
};

const OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/**
 * Body of a full-pass mark: the next seq (no row), and a count for `source`, which names the input that forced it. It
 * recreates a missing sequence or marker row, so a write to a global input never fails on them. No OR IGNORE: in a trigger the
 * outer statement's conflict policy replaces it.
 */
const markFull = (source: string): string => `INSERT INTO sqlite_sequence (name, seq) SELECT 'item_changes', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'item_changes');
          UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'item_changes';
          INSERT INTO plan_full (id, seq) SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM plan_full WHERE id = 1);
          UPDATE plan_full SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'item_changes'), 0) WHERE id = 1;
          INSERT INTO plan_full_causes (source, n, last_seq) VALUES ('${source.replace(/'/g, "''")}', 1, COALESCE((SELECT seq FROM plan_full WHERE id = 1), 0))
            ON CONFLICT (source) DO UPDATE SET n = n + 1, last_seq = excluded.last_seq;`;

/** Every logging trigger is off while a bulk write holds the marker (bulkWrites). */
const NOT_BULK = "NOT EXISTS (SELECT 1 FROM plan_bulk)";

/** The blocker refs of a stored blocked_by value of review row `o` (a JSON array of "repo#number") that review_blockers does not hold yet. */
const blockerRows = (o: string, from = ""): string => `SELECT b_repo, b_number, repo, number, head_oid FROM (
            SELECT DISTINCT substr(j.value, 1, instr(j.value, '#') - 1) AS b_repo, CAST(substr(j.value, instr(j.value, '#') + 1) AS INTEGER) AS b_number,
              ${o}.repo AS repo, ${o}.number AS number, ${o}.head_oid AS head_oid
            FROM ${from}json_each(CASE WHEN json_valid(${o}.blocked_by) THEN CASE WHEN json_type(${o}.blocked_by) = 'array' THEN ${o}.blocked_by ELSE '[]' END ELSE '[]' END) j
            WHERE j.type = 'text' AND instr(j.value, '#') > 1) nb
          WHERE NOT EXISTS (SELECT 1 FROM review_blockers x WHERE x.b_repo = nb.b_repo AND x.b_number = nb.b_number AND x.repo = nb.repo AND x.number = nb.number AND x.head_oid = nb.head_oid)`;

const on = (sql: string, alias: "new" | "old"): string => sql.replace(/\br\./g, `${alias}.`);

/** UPDATE condition of an input: its own, or a change to a watched column. Null: every UPDATE counts. */
function updateCondition(input: PlanInput, columns: Map<string, string[]> | undefined): string | null {
  if (input.updateWhen) return input.updateWhen;
  const skip = new Set(BOOKKEEPING_COLUMNS[input.table] ?? []);
  const watched = input.columns ?? columns?.get(input.table)?.filter((c) => !skip.has(c));
  return watched?.length ? watched.map((c) => `old."${c}" IS NOT new."${c}"`).join(" OR ") : null;
}

const and = (...parts: (string | null | undefined)[]): string => parts.filter((p): p is string => !!p).map((p) => `(${p})`).join(" AND ");

/**
 * DDL for the log, the marker and the triggers. Idempotent: every `plan_` trigger is rebuilt. With `db`, an UPDATE trigger
 * fires only when a watched column changed, as the live triggers do (src/live.ts).
 */
export function planChangesSql(db?: DatabaseSync): string {
  const columns = db ? columnsOf(db) : undefined;
  const out = [
    "CREATE TABLE IF NOT EXISTS main.item_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS main.plan_full (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);",
    "INSERT OR IGNORE INTO main.plan_full (id, seq) VALUES (1, 0);",
    // Full-pass marks per trigger: which inputs force full passes.
    "CREATE TABLE IF NOT EXISTS main.plan_full_causes (source TEXT PRIMARY KEY, n INTEGER NOT NULL, last_seq INTEGER NOT NULL);",
    // The incremental planner's own records (src/core/plan-engine.ts); no trigger reads them.
    "CREATE TABLE IF NOT EXISTS main.plan_shadow_diffs (at TEXT NOT NULL, ref TEXT NOT NULL, side TEXT NOT NULL, fields TEXT NOT NULL, detail TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS main.plan_pass_stats (kind TEXT PRIMARY KEY, passes INTEGER NOT NULL, refs INTEGER NOT NULL, last_at TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, max_ms INTEGER NOT NULL DEFAULT 0);",
    // Present only inside a bulk write's transaction (bulkWrites).
    "CREATE TABLE IF NOT EXISTS main.plan_bulk (id INTEGER PRIMARY KEY CHECK (id = 1));",
    "DELETE FROM main.plan_bulk;",
    // The blocker refs of every stored review, so a write to a blocking item finds the PRs held for it with an index lookup.
    "CREATE TABLE IF NOT EXISTS main.review_blockers (b_repo TEXT NOT NULL, b_number INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, head_oid TEXT NOT NULL, PRIMARY KEY (b_repo, b_number, repo, number, head_oid)) WITHOUT ROWID;",
    "CREATE INDEX IF NOT EXISTS main.review_blockers_review ON review_blockers(repo, number, head_oid);",
    "DELETE FROM main.review_blockers;",
    `INSERT INTO main.review_blockers (b_repo, b_number, repo, number, head_oid) ${blockerRows("o", "main.opus_reviews o, ")};`,
    // The pairs of an item as either item, with the verdict: covering, so SQLite looks them up instead of scanning a repo's range
    // of the primary key (it has no statistics to tell the two apart).
    "CREATE INDEX IF NOT EXISTS main.duplicate_pairs_a ON duplicate_pairs(repo, a, b, verdict);",
    "CREATE INDEX IF NOT EXISTS main.duplicate_pairs_b ON duplicate_pairs(repo, b, a, verdict);",
    // The sequence row exists before the first logged item, so a full-pass mark can take a seq from it.
    "INSERT INTO main.sqlite_sequence (name, seq) SELECT 'item_changes', 0 WHERE NOT EXISTS (SELECT 1 FROM main.sqlite_sequence WHERE name = 'item_changes');",
  ];
  if (db) {
    for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 'plan\\_%' ESCAPE '\\'").all() as { name: string }[]) out.push(`DROP TRIGGER IF EXISTS main.${name};`);
  }
  // review_blockers follows opus_reviews, also during a bulk write.
  out.push("DROP TRIGGER IF EXISTS main.plan_blockers_i;");
  out.push(`CREATE TRIGGER main.plan_blockers_i AFTER INSERT ON opus_reviews WHEN new.blocked_by IS NOT NULL BEGIN
          INSERT INTO review_blockers (b_repo, b_number, repo, number, head_oid) ${blockerRows("new")};
        END;`);
  out.push("DROP TRIGGER IF EXISTS main.plan_blockers_d;");
  out.push(`CREATE TRIGGER main.plan_blockers_d AFTER DELETE ON opus_reviews WHEN old.blocked_by IS NOT NULL BEGIN
          DELETE FROM review_blockers WHERE repo = old.repo AND number = old.number AND head_oid = old.head_oid;
        END;`);
  out.push("DROP TRIGGER IF EXISTS main.plan_blockers_u;");
  out.push(`CREATE TRIGGER main.plan_blockers_u AFTER UPDATE OF repo, number, head_oid, blocked_by ON opus_reviews
        WHEN old.blocked_by IS NOT new.blocked_by OR old.repo IS NOT new.repo OR old.number IS NOT new.number OR old.head_oid IS NOT new.head_oid BEGIN
          DELETE FROM review_blockers WHERE repo = old.repo AND number = old.number AND head_oid = old.head_oid;
          INSERT INTO review_blockers (b_repo, b_number, repo, number, head_oid) ${blockerRows("new")};
        END;`);
  const seen = new Map<string, number>();
  for (const input of PLAN_INPUTS) {
    if (input.class === "none") continue;
    const n = seen.get(input.table) ?? 0;
    seen.set(input.table, n + 1);
    const base = `plan_${input.table}${n ? `_${n}` : ""}`;
    const fullRow = input.class === "global" ? "1" : input.full;
    for (const op of OPS) {
      const rows: ("new" | "old")[] = op === "INSERT" ? ["new"] : op === "DELETE" ? ["old"] : ["old", "new"];
      const when = input.when ? rows.map((a) => `(${on(input.when!, a)})`).join(" OR ") : null;
      const upd = op === "UPDATE" ? updateCondition(input, columns) : null;
      const trigger = (name: string, cond: string, body: string): void => {
        out.push(`DROP TRIGGER IF EXISTS main.${name};`);
        out.push(`CREATE TRIGGER main.${name} AFTER ${op} ON ${input.table} WHEN ${and(cond, NOT_BULK)} BEGIN
          ${body}
        END;`);
      };
      // Full pass.
      if (fullRow || (op === "UPDATE" && input.fullUpdate)) {
        const cond = op === "UPDATE" && input.fullUpdate ? and(input.fullUpdate, when)
          : and(upd, rows.map((a) => `(${on(fullRow!, a)})`).join(" OR "), when);
        const name = `${base}_full_${op[0]!.toLowerCase()}`;
        trigger(name, cond, markFull(name));
      }
      // Affected items.
      if (input.class === "global" || (input.class === "cross" && !input.refs)) continue;
      const refs = input.refs ?? "SELECT r.repo AS repo, r.number AS number";
      const select = rows.map((a) => `SELECT repo, number FROM (${on(refs, a)})${input.when ? ` WHERE ${on(input.when, a)}` : ""}`).join(" UNION ");
      trigger(`${base}_${op[0]!.toLowerCase()}`, and(upd, when), `INSERT INTO item_changes (repo, number) SELECT repo, number FROM (${select}) WHERE repo IS NOT NULL AND number IS NOT NULL;`);
    }
  }
  return out.join("\n");
}

/** The newest seq taken (logged item or full-pass mark): what a full pass that starts now covers. */
export async function changeSeq(db: Db): Promise<number> {
  return (await db.prepare("SELECT seq FROM main.sqlite_sequence WHERE name = 'item_changes'").get() as { seq: number } | undefined)?.seq ?? 0;
}

/** What changed after `seq`: the items to decide again, or `full`. */
export async function changesSince(db: Db, seq: number): Promise<Changes> {
  // Read the bound first: rows and marks up to it were committed with it, later ones are the next call's.
  const top = await changeSeq(db);
  const full = (await db.prepare("SELECT seq FROM main.plan_full WHERE id = 1").get() as { seq: number } | undefined)?.seq ?? 0;
  if (full > seq && full <= top) return { refs: [], full: true, cause: "marker", seq: top };
  const n = (await db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM main.item_changes WHERE seq > ? AND seq <= ? LIMIT ?)").get(seq, top, CHANGES_CAP + 1) as { n: number }).n;
  if (n > CHANGES_CAP) return { refs: [], full: true, cause: "cap", seq: top };
  const refs = (await db.prepare("SELECT DISTINCT repo || '#' || number AS ref FROM main.item_changes WHERE seq > ? AND seq <= ?").all(seq, top) as { ref: string }[]).map((r) => r.ref);
  return { refs, full: false, seq: top };
}

/**
 * Deletes the log rows at or below `seq`. The log has one consumer: the runner's planner (src/core/plan-engine.ts). A second
 * consumer would lose the rows the first one pruned; other readers take full passes.
 */
export async function pruneChanges(db: Db, seq: number): Promise<void> {
  await db.prepare("DELETE FROM main.item_changes WHERE seq <= ?").run(seq);
}

/** Logs the PRs with a review at `head` of `repo`: for a write the triggers cannot see (a file the fact loaders read beside the database). */
export async function logReviewedAt(db: Db, repo: string, head: string): Promise<void> {
  await db.prepare("INSERT INTO main.item_changes (repo, number) SELECT DISTINCT repo, number FROM main.opus_reviews WHERE repo = ? AND head_oid = ?").run(repo, head);
}

/** A write of more rows than this goes through bulkWrites: one full-pass mark costs less than logging every row. */
export const BULK_ROWS = 500;

/**
 * Runs `fn` with the logging triggers off and takes one full-pass mark for `source`, in the caller's transaction or one of its
 * own. The marker row exists only inside that transaction, so other connections never see the triggers off.
 */
export async function bulkWrites<T>(db: Db, source: string, fn: () => Promise<T>): Promise<T> {
  const own = !db.inTransaction();
  return await db.write(async () => {
    const nested = !!await db.prepare("SELECT 1 FROM main.plan_bulk").get();
    try {
      if (!nested) await db.script("INSERT INTO main.plan_bulk (id) VALUES (1)");
      const out = await fn();
      if (!nested) { await db.script("DELETE FROM main.plan_bulk"); await db.script(markFull(`bulk:${source}`)); }
      return out;
    } catch (e) {
      // A transaction of its own rolls the marker back; the caller's goes on, so the marker goes now.
      if (!own && !nested) { await db.script("DELETE FROM main.plan_bulk"); await db.script(markFull(`bulk:${source}`)); }
      throw e;
    }
  });
}

/** bulkWrites() inside the caller's transaction, for connect()'s migrations, which stay synchronous. */
export function bulkWritesSync(db: DatabaseSync, source: string, fn: () => void): void {
  if (db.prepare("SELECT 1 FROM main.plan_bulk").get()) return fn();
  db.exec("INSERT INTO main.plan_bulk (id) VALUES (1)");
  try {
    fn();
  } finally {
    db.exec("DELETE FROM main.plan_bulk");
    db.exec(markFull(`bulk:${source}`));
  }
}

/**
 * Removes the change log, its triggers and the incremental planner's tables, and clears the schema stamp so the next connect
 * migrates. For a rollback to a release without the incremental planner, whose migration would leave the triggers logging.
 */
export async function dropPlanChanges(db: Db): Promise<number> {
  const triggers = await db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 'plan\\_%' ESCAPE '\\'").all() as { name: string }[];
  await db.write(async () => {
    for (const { name } of triggers) await db.script(`DROP TRIGGER IF EXISTS main.${name}`);
    for (const t of ["item_changes", "plan_full", "plan_full_causes", "plan_bulk", "plan_shadow_diffs", "plan_pass_stats", "review_blockers"]) await db.script(`DROP TABLE IF EXISTS main.${t}`);
    await db.script("DELETE FROM main.sqlite_sequence WHERE name = 'item_changes'");
    await db.script("DELETE FROM main.settings WHERE key = 'schema_stamp'");
  });
  return triggers.length;
}

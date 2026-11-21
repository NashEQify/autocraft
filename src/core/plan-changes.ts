// The change log of the planner's inputs: triggers on every table of PLAN_INPUTS log the items a write re-decides in
// `item_changes`, or move the full-pass marker when the write changes facts of items the trigger cannot name. A planner
// reads what changed since the seq it consumed (changesSince) and deletes what it consumed (pruneChanges).
//
// Seqs come from one AUTOINCREMENT sequence, so they never repeat after a prune. A full-pass mark takes the next seq of that
// sequence without adding a row: `plan_full` holds the seq of the latest one, and changesSince compares it with the caller's.
import type { DatabaseSync } from "node:sqlite";
import { BOOKKEEPING_COLUMNS, columnsOf } from "../live.ts";
import { PLAN_INPUTS, type PlanInput } from "./plan-inputs.ts";

/** More logged rows than this since the caller's seq: a full pass costs less than re-deciding them one by one. */
export const CHANGES_CAP = 50_000;

export type Changes = {
  /** Items whose facts may have changed, as "repo#number". Empty when `full`. */
  refs: string[];
  /** Every item must be decided again: a global or cross-item input changed, or the log passed CHANGES_CAP. */
  full: boolean;
  /** The seq this answer covers: pass it to the next changesSince and to pruneChanges. */
  seq: number;
};

const OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/** Bodies of the triggers: the next seq for a full pass (no row), or one row per affected item. */
const MARK_FULL = `UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'item_changes';
          UPDATE plan_full SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'item_changes') WHERE id = 1;`;

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
    // The sequence row exists before the first logged item, so a full-pass mark can take a seq from it.
    "INSERT INTO main.sqlite_sequence (name, seq) SELECT 'item_changes', 0 WHERE NOT EXISTS (SELECT 1 FROM main.sqlite_sequence WHERE name = 'item_changes');",
  ];
  if (db) {
    for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 'plan\\_%' ESCAPE '\\'").all() as { name: string }[]) out.push(`DROP TRIGGER IF EXISTS main.${name};`);
  }
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
        out.push(`CREATE TRIGGER main.${name} AFTER ${op} ON ${input.table} ${cond ? `WHEN ${cond}` : ""} BEGIN
          ${body}
        END;`);
      };
      // Full pass.
      if (fullRow || (op === "UPDATE" && input.fullUpdate)) {
        const cond = op === "UPDATE" && input.fullUpdate ? and(input.fullUpdate, when)
          : and(upd, rows.map((a) => `(${on(fullRow!, a)})`).join(" OR "), when);
        trigger(`${base}_full_${op[0]!.toLowerCase()}`, cond, MARK_FULL);
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
export function changeSeq(db: DatabaseSync): number {
  return (db.prepare("SELECT seq FROM main.sqlite_sequence WHERE name = 'item_changes'").get() as { seq: number } | undefined)?.seq ?? 0;
}

/** What changed after `seq`: the items to decide again, or `full`. */
export function changesSince(db: DatabaseSync, seq: number): Changes {
  // Read the bound first: rows and marks up to it were committed with it, later ones are the next call's.
  const top = changeSeq(db);
  const full = (db.prepare("SELECT seq FROM main.plan_full WHERE id = 1").get() as { seq: number } | undefined)?.seq ?? 0;
  if (full > seq && full <= top) return { refs: [], full: true, seq: top };
  const n = (db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM main.item_changes WHERE seq > ? AND seq <= ? LIMIT ?)").get(seq, top, CHANGES_CAP + 1) as { n: number }).n;
  if (n > CHANGES_CAP) return { refs: [], full: true, seq: top };
  const refs = (db.prepare("SELECT DISTINCT repo || '#' || number AS ref FROM main.item_changes WHERE seq > ? AND seq <= ?").all(seq, top) as { ref: string }[]).map((r) => r.ref);
  return { refs, full: false, seq: top };
}

/** Deletes the log rows at or below `seq`. */
export function pruneChanges(db: DatabaseSync, seq: number): void {
  db.prepare("DELETE FROM main.item_changes WHERE seq <= ?").run(seq);
}

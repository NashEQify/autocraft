// Prepared statements kept per connection, for the per-row lookups of list endpoints: preparing the same text again for every row costs more than running it.
import type { Db, Statement } from "./db/index.ts";

const cache = new WeakMap<Db, Map<string, Statement>>();

/** The prepared statement for `sql` on `db`. Only for fixed text: every distinct text stays in memory. */
export function prep(db: Db, sql: string): Statement {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
}

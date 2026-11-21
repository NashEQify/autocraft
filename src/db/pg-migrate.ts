// Applies src/schema.pg.sql to a Postgres database under a transaction-scoped advisory lock, so two processes opening
// the database at once cannot migrate it at the same time: the second waits for the first to commit, then applies the
// (idempotent) schema again, which changes nothing.
import { readFileSync } from "node:fs";

/** One connection (a pg Client or a pool's checked-out client): the lock and the statements must share it. */
export interface PgQueryable {
  query(text: string): Promise<unknown>;
}

/** The advisory lock key every AutoCraft schema migration takes: "autocraf" in ASCII as a 64-bit integer. */
export const MIGRATION_LOCK_KEY = 0x6175746f63726166n;

export const pgSchemaSql = (): string => readFileSync(new URL("../schema.pg.sql", import.meta.url), "utf8");

/** The stamp in the schema file's header (it covers the dialect and the whole file body). */
export function pgSchemaStamp(sql: string = pgSchemaSql()): string {
  const m = /^-- dialect: postgres; stamp: ([0-9a-f]{16})$/m.exec(sql);
  if (!m) throw new Error("src/schema.pg.sql has no stamp line");
  return m[1]!;
}

/** Runs `fn` in one transaction that holds the migration lock; rolls back if it throws. */
export async function withMigrationLock<T>(client: PgQueryable, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/**
 * Applies the schema under the migration lock. `then` runs in the same transaction after it (triggers generated at
 * runtime, value migrations, writing the stored stamp), so a concurrent opener sees all of it or none.
 */
export async function applyPgSchema(client: PgQueryable, then?: () => Promise<void>): Promise<void> {
  await withMigrationLock(client, async () => {
    // ADD COLUMN IF NOT EXISTS and friends report every skipped object as a notice.
    await client.query("SET LOCAL client_min_messages = warning");
    await client.query(pgSchemaSql());
    await then?.();
  });
}

// Database errors that callers handle the same way on both backends.

const pgCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

/**
 * Whether `e` is a lock wait that ran out: SQLite's "database is locked" (SQLITE_BUSY, any extended code) after the busy
 * timeout, or Postgres's lock_not_available (55P03) after lock_timeout, from the writer lock or any row or table lock.
 */
export function isLockTimeout(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return (typeof errcode === "number" && (errcode & 0xff) === 5) || pgCode(e) === "55P03";
}

/** Whether `e` is a Postgres serialization failure (40001) or deadlock (40P01): the transaction may succeed if run again. */
export function isConflict(e: unknown): boolean {
  const c = pgCode(e);
  return c === "40001" || c === "40P01";
}

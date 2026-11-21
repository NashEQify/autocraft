// Kysely's `sql` tag, bound when the first handle opens: kysely is loaded with a dynamic import (src/db/open.ts), so the
// value is not there when modules load. Using it before any handle is open throws.
import type { sql as KyselySql } from "kysely";

let bound: typeof KyselySql | undefined;

export function bindSql(s: typeof KyselySql): void {
  bound = s;
}

const need = (): typeof KyselySql => {
  if (!bound) throw new Error("sql used before a database handle was opened");
  return bound;
};

export const sql: typeof KyselySql = new Proxy(function () {} as unknown as typeof KyselySql, {
  apply: (_t, _this, args: unknown[]) => (need() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, p) => Reflect.get(need(), p),
});

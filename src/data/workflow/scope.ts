// Which items of a key source the pipeline works on (the scope rule of fragments.ts `inScopeExpr`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { inScopeExpr } from "./fragments.ts";
import type { RefKey } from "./types.ts";

/** The refs of `keys` that are in scope, whatever their kind or state. 1 statement. */
export async function loadInScope(db: Db, keys: KeySource): Promise<Set<RefKey>> {
  if (Array.isArray(keys) && keys.length === 0) return new Set();
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom(resolveKeys(db, keys, "sk")).select(["sk.repo", "sk.number"])
    .where((eb: any) => inScopeExpr(db, eb, "sk.repo", "sk.number")), { label: "workflow.loadInScope" }) as { repo: string; number: number }[];
  return new Set(rows.map((r) => `${r.repo}#${Number(r.number)}`));
}

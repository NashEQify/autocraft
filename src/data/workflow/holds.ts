// Merge holds (M10 workflow-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/audit.ts";
import type { RefKey } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;

/** Batched insert `ON CONFLICT DO NOTHING RETURNING`; returns the refs newly held and audits each as `merge-hold`. */
export async function holdMerges(db: Db, rows: { repo: string; number: number; by: string; details?: Record<string, unknown> }[]): Promise<RefKey[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const now = new Date().toISOString();
  return await db.write(async () => {
    const held: RefKey[] = [];
    const rowOf = new Map(rows.map((r) => [refKey(r.repo, r.number), r]));
    for (const batch of kx.batches(rows)) {
      const got = await q.all((q.k as any).insertInto("main.merge_holds").values(batch.map((r) => ({ repo: r.repo, number: r.number, held_by: r.by, held_at: now })))
        .onConflict((oc: any) => oc.doNothing()).returning(["repo", "number"])) as { repo: string; number: number }[];
      for (const g of got) held.push(refKey(g.repo, Number(g.number)));
    }
    if (held.length) await addAudit(db, held.map((key) => ({ login: rowOf.get(key)!.by, action: "merge-hold", target: key, at: now, details: rowOf.get(key)!.details ?? {} })));
    return held;
  });
}

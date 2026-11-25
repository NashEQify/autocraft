// Merge holds (M10 workflow-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/audit.ts";
import type { MergeHold, RefKey } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;

/** Held PRs, of one repo or of the given refs. */
export async function loadHolds(db: Db, f: { repo?: string; refs?: { repo: string; number: number }[] } = {}): Promise<Map<RefKey, MergeHold>> {
  const out = new Map<RefKey, MergeHold>();
  if (f.refs?.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.merge_holds as h").select(["h.repo", "h.number", "h.held_by", "h.held_at"])
    .$if(f.repo !== undefined, (b: any) => b.where("h.repo", "=", f.repo!))
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "h", f.refs!.map((r) => [r.repo, r.number] as const))))
    .orderBy("h.repo").orderBy("h.number")) as { repo: string; number: number; held_by: string; held_at: string }[];
  for (const r of rows) out.set(refKey(r.repo, Number(r.number)), { heldBy: r.held_by, heldAt: r.held_at });
  return out;
}

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

/** Batched delete `RETURNING`; returns the refs released and audits each as `merge-release`. */
export async function releaseMerges(db: Db, refs: { repo: string; number: number }[], by: string): Promise<RefKey[]> {
  if (refs.length === 0) return [];
  const q = queryDb(db);
  const now = new Date().toISOString();
  return await db.write(async () => {
    const released: RefKey[] = [];
    for (const chunk of kx.chunks(refs)) {
      const got = await q.all((q.k as any).deleteFrom("main.merge_holds").where(kx.tupleIn(db, ["repo", "number"], chunk.map((r) => [r.repo, r.number]), ["text", "bigint"])).returning(["repo", "number"])) as { repo: string; number: number }[];
      for (const g of got) released.push(refKey(g.repo, Number(g.number)));
    }
    if (released.length) await addAudit(db, released.map((key) => ({ login: by, action: "merge-release", target: key, at: now })));
    return released;
  });
}

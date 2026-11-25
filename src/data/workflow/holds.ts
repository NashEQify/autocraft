// Merge holds (M10 workflow-a).
import type { Db } from "../../db/index.ts";
import type { MergeHold, RefKey } from "./types.ts";

/** Held PRs. */
export async function loadHolds(db: Db, f?: { repo?: string; refs?: { repo: string; number: number }[] }): Promise<Map<RefKey, MergeHold>> {
  throw new Error("not built: workflow.loadHolds");
}

/** Batched insert `ON CONFLICT DO NOTHING RETURNING`; returns the refs newly held and audits `merge-hold`. */
export async function holdMerges(db: Db, rows: { repo: string; number: number; by: string; details?: Record<string, unknown> }[]): Promise<RefKey[]> {
  throw new Error("not built: workflow.holdMerges");
}

/** Batched delete `RETURNING`; audits `merge-release`. */
export async function releaseMerges(db: Db, refs: { repo: string; number: number }[], by: string): Promise<RefKey[]> {
  throw new Error("not built: workflow.releaseMerges");
}

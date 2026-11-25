// Read models for the dashboard, MCP and status (M09 triage-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ClassifierReport, ClassifierReportFilter, DisagreementList, ItemTriage } from "./types.ts";

/** Run and classifier counts, pair agreement and confusion in one wave. */
export async function loadClassifierReport(db: Db, f: ClassifierReportFilter): Promise<ClassifierReport> {
  throw new Error("not built: triage.loadClassifierReport");
}

/** Total and page in one wave. */
export async function listDisagreements(db: Db, f: ClassifierReportFilter & { limit: number; offset: number }): Promise<DisagreementList> {
  throw new Error("not built: triage.listDisagreements");
}

/** `itemsClassified` for the cost view. */
export async function loadClassifiedCount(db: Db, f: { run?: string; since?: string; hidden?: string[] }): Promise<number> {
  throw new Error("not built: triage.loadClassifiedCount");
}

/** The item page's classification, priority, area, settled, rank and duplicate reads in one wave. */
export async function loadItemTriage(db: Db, ref: { repo: string; number: number }, run: string | null): Promise<ItemTriage> {
  throw new Error("not built: triage.loadItemTriage");
}

/** Count and newest time of the item's verdicts, for the page fingerprint. */
export async function loadVerdictStamp(db: Db, ref: { repo: string; number: number }): Promise<{ n: number; newest: string | null }> {
  throw new Error("not built: triage.loadVerdictStamp");
}

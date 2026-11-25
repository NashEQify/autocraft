// Token usage (`token_usage`).
import type { Db } from "../../db/index.ts";
import type { HiddenRepos, JobUsage, UsageModelRow, UsageReport, UsageRow, RunVisibility } from "./types.ts";

/** Upserts usage rows, expanding subagent rows (`u.extra`); 1 statement per 500 rows. */
export async function recordUsage(db: Db, rows: UsageRow[]): Promise<void> { throw new Error("not built: inference.recordUsage"); }
/** Renames rows of an earlier pass (`agent || '@' || started_at`) so a later upsert does not overwrite their cost. 1 statement for any number of agents. */
export async function keepEarlierUsage(db: Db, runId: string, agents: string[]): Promise<number> { throw new Error("not built: inference.keepEarlierUsage"); }
/** Calls, tokens and cost of the runs since `sinceIso`. */
export async function loadJobUsage(db: Db, runIds: string[], sinceIso: string): Promise<JobUsage | null> { throw new Error("not built: inference.loadJobUsage"); }
/** Cost since a UTC day, calls without a repo included. */
export async function loadUsageSpend(db: Db, o: { fromDay: string; hidden: HiddenRepos }): Promise<number> { throw new Error("not built: inference.loadUsageSpend"); }
/** Usage per model of one classify run; wall seconds computed in the loader. */
export async function loadUsageByModel(db: Db, runId: string): Promise<UsageModelRow[]> { throw new Error("not built: inference.loadUsageByModel"); }
/** The Cost page without `itemsClassified`; 5 statements in one wave. The caller adds `triage.countVerdicts`. */
export async function loadUsageReport(db: Db, f: { run?: string; vis: RunVisibility }): Promise<UsageReport> { throw new Error("not built: inference.loadUsageReport"); }

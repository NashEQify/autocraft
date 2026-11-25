// The GitHub commands inbox and link nudges (M11 workflow-b).
import type { Db } from "../../db/index.ts";
import type { CommandProgress, CommandRow, CommandSettle, NewCommand } from "./types.ts";

/** Batched insert `ON CONFLICT DO NOTHING`; returns the rows added. */
export async function queueCommands(db: Db, rows: NewCommand[]): Promise<number> {
  throw new Error("not built: workflow.queueCommands");
}

/** Queued commands, or settled ones with `reply` null, oldest first. */
export async function loadCommandWork(db: Db, o: { limit: number }): Promise<CommandRow[]> {
  throw new Error("not built: workflow.loadCommandWork");
}

/** Existence probe for the runner tick. */
export async function hasCommandWork(db: Db): Promise<boolean> {
  throw new Error("not built: workflow.hasCommandWork");
}

/** Batched update that audits `github-command` per row. */
export async function settleCommands(db: Db, rows: CommandSettle[]): Promise<void> {
  throw new Error("not built: workflow.settleCommands");
}

/** Batched update, at most three statements (one per column set). */
export async function saveCommandProgress(db: Db, rows: CommandProgress[]): Promise<void> {
  throw new Error("not built: workflow.saveCommandProgress");
}

/** Batched delete. */
export async function pruneCommands(db: Db, nowMs: number): Promise<number> {
  throw new Error("not built: workflow.pruneCommands");
}

/** Last nudge time per login (case-insensitive). */
export async function loadNudges(db: Db, logins: string[]): Promise<Map<string, string>> {
  throw new Error("not built: workflow.loadNudges");
}

/** Batched upsert. */
export async function recordNudges(db: Db, rows: { login: string; at: string }[]): Promise<void> {
  throw new Error("not built: workflow.recordNudges");
}

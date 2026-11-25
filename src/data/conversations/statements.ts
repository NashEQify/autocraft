// Owner statements (memory) (M12 conversations).
import type { Db } from "../../db/index.ts";
import type { StatementVec, StatementView, StatementWork, Statement } from "./types.ts";

/** Selects uncollected sources, drops AutoCraft's own posts via `control.loadPostedCommentIds`, inserts new statements in one multi-row `on conflict do nothing`, and stores the own posts as `ignored = 1` rows. */
export async function collectStatements(db: Db, o?: { now: Date }): Promise<number> {
  throw new Error("not built: conversations.collectStatements");
}

/** Rows that need an embedding; with `limit = 1` it answers "due". Marked `alone`. */
export async function loadStatementWork(db: Db, modelId: string, limit: number): Promise<StatementWork[]> {
  throw new Error("not built: conversations.loadStatementWork");
}

/** One multi-row upsert on `id` per batch of 32. */
export async function setStatementVectors(db: Db, rows: { id: number; vec: Uint8Array; model: string }[]): Promise<void> {
  throw new Error("not built: conversations.setStatementVectors");
}

/** Statements with a vector of the given model per repo, excluding quiet security PRs. Marked `alone`. */
export async function loadStatementPools(db: Db, repos: string[], models: string[]): Promise<Map<string, StatementVec[]>> {
  throw new Error("not built: conversations.loadStatementPools");
}

/** For the planner facts. */
export async function loadStatements(db: Db, ids: number[]): Promise<Map<number, Statement>> {
  throw new Error("not built: conversations.loadStatements");
}

/** The item page's conflicts: each statement with its item's kind, state and title. */
export async function loadStatementViews(db: Db, ids: number[]): Promise<Map<number, StatementView>> {
  throw new Error("not built: conversations.loadStatementViews");
}

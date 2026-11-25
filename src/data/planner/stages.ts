// The stage log (`stages`; `item_stage` is kept by a trigger).
import type { Db } from "../../db/index.ts";
import type { ItemKeys, RefKey, StageEvent, StageEventRow, StageFacts } from "./types.ts";

/** The only writer of `stages`; joins the caller's transaction; 1 statement per 500 rows. Never writes `item_stage`. */
export async function addStageEvents(db: Db, rows: StageEventRow[]): Promise<void> { throw new Error("not built: planner.addStageEvents"); }
/** Inserts a row unless a row of that (repo, number, stage) has a note starting with `notePrefix`. Returns the rows inserted. */
export async function addStageEventsOnce(db: Db, rows: (StageEventRow & { notePrefix: string })[]): Promise<number> { throw new Error("not built: planner.addStageEventsOnce"); }
/** The latest stage per item and the latest `labeled` note by (at, rowid). 2 statements in one wave. */
export async function loadStageFacts(db: Db, keys: ItemKeys): Promise<Map<RefKey, StageFacts>> { throw new Error("not built: planner.loadStageFacts"); }
/** The stage log per ref ordered by (at, rowid). */
export async function loadStageLog(db: Db, keys: RefKey[]): Promise<Map<RefKey, StageEvent[]>> { throw new Error("not built: planner.loadStageLog"); }
/** Row count and newest rowid per ref. */
export async function loadStageVersions(db: Db, keys: RefKey[]): Promise<Map<RefKey, { count: number; newestRowid: number | null }>> { throw new Error("not built: planner.loadStageVersions"); }
/** Row count and max rowid of the whole log (the Progress cache signature). */
export async function loadStageVersion(db: Db): Promise<{ count: number; maxRowid: number | null }> { throw new Error("not built: planner.loadStageVersion"); }
/** Stage events for the activity feed. */
export async function listStageEvents(db: Db, opts: { sinceRowid?: number; since?: string; limit: number }): Promise<(StageEvent & { repo: string; number: number })[]> { throw new Error("not built: planner.listStageEvents"); }

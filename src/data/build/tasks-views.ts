// Task read models for the dashboard, live board and trace (package build-a).
import type { Db } from "../../db/index.ts";
import type { BuildSummary, BuildTaskDetail, EnvTasks, IdSource, MemRow, Ref, RefSource, TaskCard, TaskEvent, TaskFilter, TaskHistoryStat, TaskPage, ViewScope } from "./types.ts";

/** The task list page: wave 1 the page plus one row, wave 2 artifacts, batches, shown items and the confidential clock. */
export async function loadTaskPage(db: Db, filter: TaskFilter, scope: ViewScope): Promise<TaskPage> { throw new Error("not built: build.loadTaskPage"); }
/** One task with artifacts, batch, shown items, log tail and patch (staff only). */
export async function loadTaskDetail(db: Db, id: number, scope: ViewScope): Promise<BuildTaskDetail | null> { throw new Error("not built: build.loadTaskDetail"); }
/** Counts, online environments and running per environment in one wave. */
export async function loadTaskSummary(db: Db, scope: ViewScope): Promise<BuildSummary> { throw new Error("not built: build.loadTaskSummary"); }
/** An environment's pod runs joined to their tasks. */
export async function loadEnvTasks(db: Db, envId: string): Promise<EnvTasks> { throw new Error("not built: build.loadEnvTasks"); }
/** Task rows per job with the step each log is on, for the live board. */
export async function loadTaskCards(db: Db, jobIds: IdSource, scope: ViewScope): Promise<Map<number, TaskCard[]>> { throw new Error("not built: build.loadTaskCards"); }
/** The newest `samples` done durations per (repo, step) key `repo|step`, with a window function. */
export async function loadTaskDurations(db: Db, pairs: { repo: string; step: string }[], samples: number): Promise<Map<string, number[]>> { throw new Error("not built: build.loadTaskDurations"); }
/** An item's task history for the trace and activity pages. */
export async function loadItemTaskEvents(db: Db, ref: Ref, scope: ViewScope): Promise<TaskEvent[]> { throw new Error("not built: build.loadItemTaskEvents"); }
/** The trace's "has anything changed" signature per item. */
export async function loadTaskHistoryStats(db: Db, refs: RefSource): Promise<Map<Ref, TaskHistoryStat>> { throw new Error("not built: build.loadTaskHistoryStats"); }
/** Memory use of ended tasks in the window, aggregated in memory. */
export async function loadMemorySummary(db: Db, days: number): Promise<MemRow[]> { throw new Error("not built: build.loadMemorySummary"); }

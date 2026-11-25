// Screenshot configs and runs (`screenshot_config`, `screenshot_runs`) (package merge-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { HeadRef, NewScreenshotRun, PendingShotRun, ScreenshotConfig, ScreenshotRun, ScreenshotSettle } from "./types.ts";

/** Configs by repo. 1 statement. */
export async function loadScreenshotConfigs(db: Db, repos?: string[]): Promise<Map<string, ScreenshotConfig>> { throw new Error("not built: merge.loadScreenshotConfigs"); }
/** One-key wrapper over `loadScreenshotConfigs`. */
export async function getConfig(db: Db, repo: string): Promise<ScreenshotConfig | undefined> { throw new Error("not built: merge.getConfig"); }
/** Validates nothing (the caller parses `raw`), upserts the config and records the audit row. */
export async function saveScreenshotConfig(db: Db, by: string, repo: string, raw: unknown): Promise<ScreenshotConfig> { throw new Error("not built: merge.saveScreenshotConfig"); }
/** Deletes the config and records the audit row. */
export async function removeScreenshotConfig(db: Db, by: string, repo: string): Promise<boolean> { throw new Error("not built: merge.removeScreenshotConfig"); }
/** Screenshot runs per head. 1 statement. */
export async function loadScreenshotRuns(db: Db, keys: KeySource): Promise<Map<HeadRef, ScreenshotRun>> { throw new Error("not built: merge.loadScreenshotRuns"); }
/** Inserts runs, ignoring existing rows. */
export async function addScreenshotRuns(db: Db, rows: NewScreenshotRun[]): Promise<void> { throw new Error("not built: merge.addScreenshotRuns"); }
/** Pending runs with item state, head, title and body; task states and artifacts in a second wave. */
export async function loadPendingScreenshotRuns(db: Db): Promise<PendingShotRun[]> { throw new Error("not built: merge.loadPendingScreenshotRuns"); }
/** Compare-and-set settle of runs; returns the keys changed. */
export async function settleScreenshotRuns(db: Db, rows: ScreenshotSettle[]): Promise<Set<HeadRef>> { throw new Error("not built: merge.settleScreenshotRuns"); }
/** Skips queued screenshot runs or marks queued PR builds stale. The task cancel stays with the caller. */
export async function skipQueuedFeatureRuns(db: Db, f: "screenshots" | "pr-builds", repo?: string): Promise<{ taskSteps: string[] }> { throw new Error("not built: merge.skipQueuedFeatureRuns"); }

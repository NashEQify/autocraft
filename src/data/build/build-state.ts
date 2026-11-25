// The `build_state` row: stored warm report, warm bytes, warm gc lock, trimmed publish, worker update and endpoint status (package build-b).
import type { Db } from "../../db/index.ts";
import type { EndpointStatus, StoredCaches, UpdateSpec, WorkerUpdate } from "./types.ts";

/** Stores the Caches page's report JSON. */
export async function saveWarmReport(db: Db, json: string): Promise<void> { throw new Error("not built: build.saveWarmReport"); }
/** The stored report; `alone` because it is large. */
export async function loadWarmReport(db: Db): Promise<StoredCaches | null> { throw new Error("not built: build.loadWarmReport"); }
/** Published warm sizes per key. */
export async function loadWarmBytes(db: Db, keys: string[]): Promise<Map<string, number>> { throw new Error("not built: build.loadWarmBytes"); }
/** Stores published warm sizes. */
export async function saveWarmBytes(db: Db, rows: { key: string; bytes: number }[]): Promise<void> { throw new Error("not built: build.saveWarmBytes"); }
/** Takes the warm gc lock with one upsert `ON CONFLICT DO UPDATE ... WHERE value <= cutoff` and its changed-row count. */
export async function takeWarmGc(db: Db, nowMs: number): Promise<boolean> { throw new Error("not built: build.takeWarmGc"); }
/** Releases the warm gc lock. */
export async function releaseWarmGc(db: Db, nowMs: number): Promise<void> { throw new Error("not built: build.releaseWarmGc"); }
/** Records that a repo's first trimmed publish happened (insert do nothing). */
export async function recordTrimmedPublish(db: Db, repo: string, nowMs: number): Promise<void> { throw new Error("not built: build.recordTrimmedPublish"); }
/** The first trimmed publish's repo, if any. */
export async function loadTrimmedPublish(db: Db): Promise<string | null> { throw new Error("not built: build.loadTrimmedPublish"); }
/** The pending worker update and its failures. */
export async function loadWorkerUpdate(db: Db): Promise<WorkerUpdate> { throw new Error("not built: build.loadWorkerUpdate"); }
/** One upsert or delete for both keys. */
export async function saveWorkerUpdate(db: Db, patch: { pending?: UpdateSpec | null; failures?: { count: number; error: string } | null }): Promise<void> { throw new Error("not built: build.saveWorkerUpdate"); }
/** Clears the pending update and failures. */
export async function clearWorkerUpdate(db: Db): Promise<void> { throw new Error("not built: build.clearWorkerUpdate"); }
/** Running tasks on local-sandbox environments. */
export async function loadBusyLocalTasks(db: Db): Promise<number> { throw new Error("not built: build.loadBusyLocalTasks"); }
/** The runner's EndpointSlice record, for the health check. */
export async function loadEndpointStatus(db: Db): Promise<EndpointStatus | null> { throw new Error("not built: build.loadEndpointStatus"); }
/** Stores the runner's EndpointSlice record. */
export async function saveEndpointStatus(db: Db, status: EndpointStatus): Promise<void> { throw new Error("not built: build.saveEndpointStatus"); }

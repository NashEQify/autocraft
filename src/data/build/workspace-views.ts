// Workspace read models (package build-b).
import type { Db } from "../../db/index.ts";
import type { CallPage, ViewScope, WorkspacePage, WorkspaceQuery, CacheReport } from "./types.ts";

/** The Workspaces list page; sessions come from the views module. */
export async function loadWorkspacePage(db: Db, q: WorkspaceQuery, scope: ViewScope): Promise<WorkspacePage> { throw new Error("not built: build.loadWorkspacePage"); }
/** A workspace's calls, paged; JSON fields through `kx.json*`. */
export async function loadWorkspaceCalls(db: Db, w: number, q: { before?: number; after?: number; running?: boolean; limit: number }): Promise<CallPage> { throw new Error("not built: build.loadWorkspaceCalls"); }
/** One call's output text; `alone`. */
export async function loadCallOutput(db: Db, w: number, id: number): Promise<string | null> { throw new Error("not built: build.loadCallOutput"); }
/** One call's image; `alone`. */
export async function loadCallImage(db: Db, w: number, id: number): Promise<Uint8Array | null> { throw new Error("not built: build.loadCallImage"); }
/** The Caches page: stored report, coverage, tracked names, newest and newest-done warm task per repo, `warm_bytes`, sizes, main heads, kubernetes environments. Wave 1: 8 statements. */
export async function loadCacheReport(db: Db, scope: ViewScope): Promise<CacheReport> { throw new Error("not built: build.loadCacheReport"); }

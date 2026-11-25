// Branch and closure reads other modules ask the mirror for (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { RefKey } from "./types.ts";

/** Default branch, every open PR base and shared same-repo heads per repo; three statements in one wave. */
export async function loadLongLivedBranches(db: Db, repos?: string[]): Promise<Map<string, Set<string>>> {
  throw new Error("not built: mirror.loadLongLivedBranches");
}

/** Issue to the merged PR that closed it. */
export async function loadMergedClosures(db: Db, repos: string[]): Promise<Map<RefKey, RefKey>> {
  throw new Error("not built: mirror.loadMergedClosures");
}

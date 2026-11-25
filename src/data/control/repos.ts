// Tracked repos (M05 control-a).
import type { Db } from "../../db/index.ts";
import type { TrackedRepo } from "./types.ts";

/** All rows, or the named ones. Names, owners and pipeline flags are fields (the owner join is `mirror.loadRepos` in a `together`). */
export async function loadTrackedRepos(db: Db, names?: string[]): Promise<Map<string, TrackedRepo>> {
  throw new Error("not built: control.loadTrackedRepos");
}

/** Names the dashboard hides from non-operators. */
export async function loadEverTracked(db: Db): Promise<Set<string>> {
  throw new Error("not built: control.loadEverTracked");
}

/** Insert on conflict do nothing plus the `repo-track` audit row when inserted. */
export async function addTrackedRepo(db: Db, o: { name: string; by: string; at?: string }): Promise<boolean> {
  throw new Error("not built: control.addTrackedRepo");
}

/** Delete plus the `repo-untrack` audit row; approval rows stay. */
export async function removeTrackedRepo(db: Db, name: string, by: string): Promise<boolean> {
  throw new Error("not built: control.removeTrackedRepo");
}

/** Compare-and-set (`WHERE pipeline <> :on`), one `repo-pipeline` audit row per changed repo; throws `PilotError("<repo> is not tracked")` for an untracked name. */
export async function setPipelineFlags(db: Db, rows: { repo: string; on: boolean }[], by: string): Promise<{ changed: string[] }> {
  throw new Error("not built: control.setPipelineFlags");
}

/** Validates a repo name. */
export function parseRepoName(s: string): string | null {
  throw new Error("not built: control.parseRepoName");
}

/** Splits `owner/repo`. */
export function splitSlug(slug: string): { owner: string; repo: string } | null {
  throw new Error("not built: control.splitSlug");
}

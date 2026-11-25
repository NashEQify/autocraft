// The repos whose build tasks the pipeline runs: those with the pipeline flag on.
import type { Db } from "../db/index.ts";
import { config, freshConfig, loadTrackedRepos } from "../data/control/index.ts";
import type { TrackedRepo } from "../data/control/index.ts";

/** The repos with the pipeline flag on. */
export const baseScope = (tracked: Iterable<TrackedRepo>): Set<string> => new Set([...tracked].filter((t) => t.pipeline).map((t) => t.name));

/** Instance settings from the unit of work's snapshot, or from the table when the caller runs outside one. */
export async function settingsConfig(db: Db, keys: readonly string[]) {
  try {
    return config(db);
  } catch {
    return await freshConfig(db, keys);
  }
}

export const loadBaseScope = async (db: Db): Promise<Set<string>> => baseScope((await loadTrackedRepos(db)).values());

// The repos whose build tasks the pipeline runs: those with the pipeline flag on, narrowed by the pilot list when one is set.
import type { Db } from "../db/index.ts";
import { config, freshConfig, loadTrackedRepos } from "../data/control/index.ts";
import type { TrackedRepo } from "../data/control/index.ts";

/** The repos with the pipeline flag on and, when a pilot list is set, named by one of its items. */
export function baseScope(tracked: Iterable<TrackedRepo>, pilotItems: readonly string[]): Set<string> {
  const on = [...tracked].filter((t) => t.pipeline).map((t) => t.name);
  if (!pilotItems.length) return new Set(on);
  const pilot = new Set(pilotItems.map((i) => i.split("#")[0]!));
  return new Set(on.filter((r) => pilot.has(r)));
}

/** Instance settings from the unit of work's snapshot, or from the table when the caller runs outside one. */
export async function settingsConfig(db: Db, keys: readonly string[]) {
  try {
    return config(db);
  } catch {
    return await freshConfig(db, keys);
  }
}

export async function loadBaseScope(db: Db): Promise<Set<string>> {
  const [tracked, c] = await Promise.all([loadTrackedRepos(db), settingsConfig(db, ["pilot_items"])]);
  return baseScope(tracked.values(), c.pilotItems);
}

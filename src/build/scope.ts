// The repos whose build tasks the pipeline runs: those with the pipeline flag on.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import type { TrackedRepo } from "../data/control/index.ts";

/** The repos with the pipeline flag on. */
export const baseScope = (tracked: Iterable<TrackedRepo>): Set<string> => new Set([...tracked].filter((t) => t.pipeline).map((t) => t.name));

export const loadBaseScope = async (db: Db): Promise<Set<string>> => baseScope((await loadTrackedRepos(db)).values());

// The repos the pipeline works: those with the Pipeline switch on and those with a live workflow.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadLiveRepos } from "../data/workflow/index.ts";

export async function scopeRepos(db: Db): Promise<Set<string>> {
  const [tracked, live] = await db.together(() => Promise.all([loadTrackedRepos(db), loadLiveRepos(db)]));
  const out = new Set([...tracked.values()].filter((r) => r.pipeline).map((r) => r.name));
  for (const repo of live) if (tracked.has(repo)) out.add(repo);
  return out;
}

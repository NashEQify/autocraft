// The repos the pipeline works: those with the Pipeline switch on, those with a live workflow, and those with a close a person asked for.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadActionsDue, loadLiveRepos } from "../data/workflow/index.ts";

export async function scopeRepos(db: Db): Promise<Set<string>> {
  const [tracked, live, closes] = await db.together(() => Promise.all([loadTrackedRepos(db), loadLiveRepos(db), loadActionsDue(db, { kinds: ["close", "comment-close"] })]));
  const out = new Set([...tracked.values()].filter((r) => r.pipeline).map((r) => r.name));
  for (const repo of [...live, ...closes.map((a) => a.repo)]) if (tracked.has(repo)) out.add(repo);
  return out;
}

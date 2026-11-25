// The repos the pipeline works, one rule per kind of work.
import type { Db } from "../db/index.ts";
import { loadBaseScope } from "../build/scope.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadActionsDue, loadLiveRepos } from "../data/workflow/index.ts";
import { mergeScope } from "../merge/approval.ts";

/**
 * What a repo is in scope for:
 * - `work` (the default): the steps on items; its Pipeline switch is on, a workflow is live in it, or a close a person asked for is due;
 * - `merge`: the merge steps; the switch, or a live workflow;
 * - `cards`: the action cards of conversations; the switch, or a live workflow, tracked or not;
 * - `cleanup`: taking back what the pipeline left in a repo; every tracked repo;
 * - `builds`: build tasks nobody started; the switch.
 */
export type ScopeFor = "work" | "merge" | "cards" | "cleanup" | "builds";

export async function scopeRepos(db: Db, o: { for?: ScopeFor } = {}): Promise<Set<string>> {
  switch (o.for ?? "work") {
    case "merge": return (await mergeScope(db)).any;
    case "builds": return await loadBaseScope(db);
    case "cleanup": return new Set((await loadTrackedRepos(db)).keys());
    case "cards": {
      const [on, live] = await db.together(() => Promise.all([loadBaseScope(db), loadLiveRepos(db)]));
      return new Set([...on, ...live]);
    }
    case "work": {
      const [tracked, live, closes] = await db.together(() => Promise.all([loadTrackedRepos(db), loadLiveRepos(db), loadActionsDue(db, { kinds: ["close", "comment-close"] })]));
      const out = new Set([...tracked.values()].filter((r) => r.pipeline).map((r) => r.name));
      for (const repo of [...live, ...closes.map((a) => a.repo)]) if (tracked.has(repo)) out.add(repo);
      return out;
    }
  }
}

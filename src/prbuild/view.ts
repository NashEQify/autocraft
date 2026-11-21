// What the dashboard shows of our build of a PR head. Null while the repo's switch is off or no build exists, so the section stays hidden.
import type { ItemPrBuild } from "../../web/src/api/types.ts";
import { featureOn } from "../build/features.ts";
import type { Db } from "../db/index.ts";

type Row = { head_sha: string; task_id: number | null; state: string; summary: string | null; ci_overall: string | null; disagree: number; created_at: string; finished_at: string | null };

/** The build of the PR's current head, else the newest one. `internals` false: states only, no failure text. */
export async function prBuildView(db: Db, repo: string, number: number, head: string | null, internals: boolean): Promise<ItemPrBuild | null> {
  if (!await featureOn(db, "pr-builds", repo)) return null;
  const r = await db.prepare("SELECT head_sha, task_id, state, summary, ci_overall, disagree, created_at, finished_at FROM main.pr_builds WHERE repo = ? AND number = ? ORDER BY (head_sha = ?) DESC, created_at DESC LIMIT 1")
    .get(repo, number, head) as Row | undefined;
  if (!r) return null;
  let state: ItemPrBuild["state"] = r.state as ItemPrBuild["state"];
  if (state === "queued" as string) {
    const t = r.task_id === null ? undefined : (await db.prepare("SELECT state FROM build_tasks WHERE id = ?").get(r.task_id) as { state: string } | undefined);
    state = t?.state === "claimed" || t?.state === "running" ? "running" : "queued";
  }
  return {
    headSha: r.head_sha, current: r.head_sha === head, state, summary: internals ? r.summary : null,
    disagree: r.disagree === 1, ci: r.ci_overall, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

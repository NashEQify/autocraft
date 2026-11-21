// What the dashboard shows of our build of a PR head. Null while the repo's switch is off or no build exists, so the section stays hidden.
import type { ItemPrBuild } from "../../web/src/api/types.ts";
import { featureOn } from "../build/features.ts";
import type { Db } from "../db/index.ts";

/** The build of the PR's current head, else the newest one. `internals` false: states only, no failure text. */
export async function prBuildView(db: Db, repo: string, number: number, head: string | null, internals: boolean): Promise<ItemPrBuild | null> {
  if (!await featureOn(db, "pr-builds", repo)) return null;
  const r = await db.get(db.k.selectFrom("main.pr_builds").select(["head_sha", "task_id", "state", "summary", "ci_overall", "disagree", "created_at", "finished_at"])
    .where("repo", "=", repo).where("number", "=", number).orderBy((eb) => eb("head_sha", "=", eb.val(head)), (o) => o.desc()).orderBy("created_at", "desc").limit(1));
  if (!r) return null;
  let state: ItemPrBuild["state"] = r.state as ItemPrBuild["state"];
  if (state === "queued" as string) {
    const t = r.task_id === null ? undefined : await db.get(db.k.selectFrom("build_tasks").select("state").where("id", "=", r.task_id));
    state = t?.state === "claimed" || t?.state === "running" ? "running" : "queued";
  }
  return {
    headSha: r.head_sha, current: r.head_sha === head, state, summary: internals ? r.summary : null,
    disagree: r.disagree === 1, ci: r.ci_overall, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

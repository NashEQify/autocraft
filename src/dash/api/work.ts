// The work queue for the dashboard: every open item in work-score order with the parts of its score and its
// next pipeline step. Read-only, anyone signed in, limited to the repos the requester may see.
import type { TypeLabel, WorkList, WorkRow } from "../../../web/src/api/types.ts";
import { classifyListOf, NOT_PLANNED } from "../../rank/next.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { visibleRepos } from "./visible.ts";
import { readerOf, veiledFor } from "./reader.ts";
import type { Db } from "../../db/index.ts";
import { loadWorkList } from "../../data/views/work.ts";

export async function work(db: Db, req: Req): Promise<WorkList> {
  const repo = req.query.get("repo") || undefined;
  const kind = req.query.get("kind") || undefined;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const visible = await visibleRepos(db, req);
  if (repo && !visible.includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  if (kind && kind !== "pr" && kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
  const repos = repo ? [repo] : visible;
  if (!repos.length) return { rows: [], total: 0, next: null };
  const { rows, total } = await loadWorkList(db, { repos, kind: kind as "pr" | "issue" | undefined, limit, offset });
  const reader = await readerOf(db, req);
  const out: WorkRow[] = rows.map((r) => {
    const bd = r.breakdown;
    return {
      repo: r.repo, number: r.number, kind: r.kind, title: r.title, score: r.score, level: bd.level, size: bd.size,
      breakdown: bd, label: r.label as TypeLabel | null,
      // A viewer of a quiet pull request gets no next step: it can quote the planner's reasons.
      next: veiledFor(reader, r.repo, r.number) ? "" : r.next ?? NOT_PLANNED, nextHref: r.itemState === "referee-due" ? classifyListOf(r.repo) : null,
    };
  });
  return { rows: out, total, next: offset + rows.length < total ? offset + rows.length : null };
}

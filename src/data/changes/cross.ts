// reads: build.build_tasks
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { rowsOf } from "./rows.ts";
import type { CheckShape } from "./types.ts";

/**
 * The run times in ms of the repo's last `limit` successful checks of `shape`, newest check first. Joins `model_checks` to the task's
 * start and end times and applies `state = 'done'` before the limit, so it cannot be two loads. Run time counts from when a worker
 * took the task. A successful `check` or `test` is outcome `exit 0`; `fmt` and `clippy` count whenever they gave a result.
 */
export async function loadCheckDurations(db: Db, repo: string, shape: CheckShape, limit: number): Promise<number[]> {
  const k = queryDb(db).k as any;
  const rows = await rowsOf<{ ms: number | string }>(db, k.selectFrom("main.model_checks as m").innerJoin("main.build_tasks as t", "t.id", "m.task_id")
    .select((eb: any) => eb(eb(eb.fn("julianday", ["t.ended_at"]), "-", eb.fn("julianday", [eb.fn("coalesce", ["t.started_at", "t.claimed_at"])])), "*", 86400000).as("ms"))
    .where("m.repo", "=", repo).where("m.command", "=", shape.command)
    .where("m.crate", shape.crate === undefined ? "is" : "is not", null)
    .where("m.test_name", shape.testName === undefined ? "is" : "is not", null)
    .where((eb: any) => shape.command === "check" || shape.command === "test" ? eb("m.outcome", "=", "exit 0") : eb.and([
      eb.not(kx.like(db, "m.outcome", eb.val("failed%"))), eb.not(kx.like(db, "m.outcome", eb.val("refused%"))),
      eb.not(kx.like(db, "m.outcome", eb.val("cancelled%"))), eb.not(kx.like(db, "m.outcome", eb.val("stopped%"))),
      eb("m.outcome", "<>", "out of time"),
    ]))
    .where("t.state", "=", "done").where("t.ended_at", "is not", null)
    .where((eb: any) => eb.or([eb("t.started_at", "is not", null), eb("t.claimed_at", "is not", null)]))
    .orderBy("m.id", "desc").limit(limit));
  return rows.map((r) => Number(r.ms));
}

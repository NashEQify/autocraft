// reads: runners.remote_calls, control.stage_limits
// loadRunnerTick reads each running job's remote-queue state from remote_calls in the same statement as the running rows;
// loadLaneInputs joins the stage limits' reset times into the daily item counts. Everything else goes through loaders and `together`.
import { sql, type RawBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import type { AnyEb } from "../../db/kx.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb } from "../../db/kx.ts";

/** Scalar: 1 when a call of the job waits in the queue for a caller that polls it (seen within `staleMs`), else 0. */
export function remoteQueuedOf(eb: AnyEb, jobIdRef: kx.Ex, nowMs: number, staleMs: number): RawBuilder<number> {
  const t = schemaEb(eb);
  return sql<number>`${eb.fn.coalesce(t.selectFrom("main.remote_calls as rq").select((e) =>
    e.fn.max<number>(e.case().when(e.and([e("rq.state", "=", "queued"), e("rq.seen_at", ">=", nowMs - staleMs)])).then(e.lit(1)).else(e.lit(0)).end()).as("q"))
    .where("rq.job_id", "=", kx.exprOf(eb, jobIdRef)), eb.lit(0))}`;
}

/** Scalar: when the job's latest remote call was leased (ms), or null. */
export function lastLeaseOf(eb: AnyEb, jobIdRef: kx.Ex): RawBuilder<number | null> {
  return sql<number | null>`${schemaEb(eb).selectFrom("main.remote_calls as rl").select((e) => e.fn.max<number | null>("rl.leased_at").as("l"))
    .where("rl.job_id", "=", kx.exprOf(eb, jobIdRef))}`;
}

/** Items of jobs started since `max(day, the step's reset)`, per step; `day` is the UTC day start. */
export function itemsStartedSince(db: Db, day: string) {
  const k = queryDb(db).k;
  return k.selectFrom("main.jobs as j").leftJoin("main.stage_limits as sl", "sl.step", "j.step")
    .select((e) => ["j.step", e.fn.coalesce(e.fn.sum<number>("j.items"), e.lit(0)).as("n")])
    .where("j.started_at", ">=", day)
    .where((e) => e("j.started_at", ">=", e.case().when(e.and([e("sl.reset_at", "is not", null), e("sl.reset_at", ">", day)])).then(e.ref("sl.reset_at")).else(e.val(day)).end()))
    .groupBy("j.step");
}

/** The daily-limit reset time per step. */
export const limitResets = (db: Db) => queryDb(db).k.selectFrom("main.stage_limits as sr").select(["sr.step", "sr.reset_at"]).where("sr.reset_at", "is not", null);

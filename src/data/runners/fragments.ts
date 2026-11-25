// Predicates other modules embed.
import type { Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";

const MANUAL_ONLY_KEY = "manual_only";

/** The run of the call's live lease: only calls queued under it are served. */
export function leasedRunOf(db: Db, callId: number): SelectQueryBuilder<any, any, { run_id: number | null }> {
  return queryDb(db).k.selectFrom("remote_calls").select("run_id").where("id", "=", callId).where("state", "=", "leased");
}

/** A `remote_calls` row (unaliased) that a resumed run may adopt: open, or answered and not yet read. */
export function adoptableCall(eb: Eb): Expression<SqlBool> {
  return eb.and([eb("state", "in", ["queued", "leased", "done"]), eb("consumed_at", "is", null)]);
}

/** A `remote_calls` row (unaliased) of an earlier run of a resumed job that has not ended: it waits for adoption with no caller. */
export function earlierRunCall(db: Db, eb: Eb): Expression<SqlBool> {
  // S1: the job columns come from the jobs module's fragment once it is merged.
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("jobs as j").select(w.lit(1).as("one")).where("j.id", "=", ref<number>("remote_calls.job_id")).where("j.resumes", ">", 0)
    .where((e) => e.or([e("j.state", "=", "queued"), e.and([e("j.state", "=", "running"),
      e(ref<number>("remote_calls.since"), "<", e(e.parens(e.fn<number>("julianday", [e.ref("j.started_at")]), "-", e.lit(2440587.5)), "*", e.lit(86400000)))])])));
}

/** Agent run ids of adoptable calls of resuming jobs: they stay running until the resumed run reads the reply or the job ends. */
export function keptRuns(db: Db): SelectQueryBuilder<any, any, { run_id: number | null }> {
  // S1: replace the jobs subquery by `jobs.fragments.resumingJobs`.
  const k = queryDb(db).k;
  return k.selectFrom("remote_calls").select("run_id").where("run_id", "is not", null)
    .where((eb) => adoptableCall(eb))
    .where("job_id", "in", k.selectFrom("jobs").select("id").where("state", "=", "queued").where("resumes", ">", 0));
}

/** Scalar subquery: when the call was queued (`since`, ms). */
export function callSince(eb: Eb, callId: Ex): Expression<number | null> {
  const w = schemaEb(eb);
  return w.selectFrom("remote_calls as cs").select("cs.since").where("cs.id", "=", ref<number>(callId)) as unknown as Expression<number | null>;
}

/** The login in `loginCol` has `manual_only = '1'`. */
export function manualOnlyExpr(eb: Eb, loginCol: Ex): Expression<SqlBool> {
  return userSettingExpr(eb, loginCol, MANUAL_ONLY_KEY, "1");
}

/** The login in `loginCol` has setting `key` (with `value` when given). */
export function userSettingExpr(eb: Eb, loginCol: Ex, key: string, value?: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("user_settings as us").select(w.lit(1).as("one")).where("us.login", "=", ref<string>(loginCol)).where("us.key", "=", key)
    .$if(value !== undefined, (q) => q.where("us.value", "=", value!)));
}

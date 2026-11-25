// Lane lists, lane state and the planner's gate inputs (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { itemsStartedSince, limitResets } from "./cross.ts";
import { loadHeldLeaseKeys } from "./leases.ts";
import { RUNNER_STOPPED } from "./fragments.ts";
import { loadLiveJobs } from "./queue.ts";
import { nowIso } from "./sql.ts";
import type { EndedJob, FpRecord, JobState, LaneInputs, LaneStateKind, LaneStatePut, LaneStateRow, StoredLane, StoredLaneItems, StreakRow } from "./types.ts";

const PIPELINE_USER = "pipeline";
/** Pipeline jobs of the last this-many ids are looked at for failure streaks; older failures no longer delay anything. */
const STREAK_WINDOW = 20_000;
/** Failed jobs of a streak the backoff looks at. */
const STREAK_ROWS = 12;

/** The start of the UTC day that `ms` falls in, as job times are stored. */
export const dayStart = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * One load per planner pass: eight statements in one `together`, joined into the pass's wave. `marks` holds the
 * planner marks and the round-robin cursors, keyed by name. `streaks` keeps, per step and repo, the newest pipeline
 * jobs back to and including the last success, at most 12.
 */
export async function loadLaneInputs(db: Db, nowMs: number): Promise<LaneInputs> {
  const q = queryDb(db);
  const day = dayStart(nowMs);
  const notStopped = (eb: kx.AnyEb) => eb(eb.fn.coalesce("error", eb.val("")), "<>", RUNNER_STOPPED);
  const ranked = q.k.selectFrom("jobs").select((eb) => ["step", "repo", "id", "state", "error", "ended_at",
    eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["step", "repo"]).orderBy("id", "desc")).as("rn"),
    eb.fn.max<number | null>(eb.case().when("state", "=", "done").then(eb.ref("id")).end()).over((o) => o.partitionBy(["step", "repo"])).as("last_ok")])
    .where("id", ">", (eb) => eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", STREAK_WINDOW))
    .where("requested_by", "=", PIPELINE_USER).where("state", "in", ["done", "failed"])
    .where((eb) => eb.and([notStopped(eb), eb.not(kx.like(db, eb.fn.coalesce("error", eb.val("")), eb.val("write paced:%")))]));
  const [live, used, ends, streaks, fps, resets, heldLeaseKeys, marks] = await db.together(() => Promise.all([
    loadLiveJobs(db),
    q.all(itemsStartedSince(db, day)),
    q.all(q.k.selectFrom("jobs").select(["id", "step", "repo", "requested_by", "state", "error", "ended_at", "items", "acted", "lease_skips", "lease_skip_keys"]).$narrowType<{ state: JobState }>()
      .where("id", "in", (eb) => eb.selectFrom("jobs").select((e) => e.fn.max<number>("id").as("m"))
        .where((e) => e.and([e("ended_at", "is not", null), notStopped(e)])).groupBy(["step", "repo", "requested_by"]))),
    q.all(q.k.selectFrom(ranked.as("r")).select(["r.step", "r.repo", "r.id", "r.state", "r.error", "r.ended_at"]).$narrowType<{ state: JobState }>()
      .where("r.rn", "<=", STREAK_ROWS).where((eb) => eb.or([eb("r.last_ok", "is", null), eb("r.id", ">=", eb.ref("r.last_ok"))])).orderBy("r.step").orderBy("r.repo").orderBy("r.id", "desc")),
    q.all(q.k.selectFrom("lane_state").select(["step", "repo", "value", "job_id"]).where("kind", "=", "fp")),
    q.all(limitResets(db)),
    loadHeldLeaseKeys(db),
    q.all(q.k.selectFrom("lane_state").select(["step", "value"]).where("kind", "in", ["mark", "cursor"])),
  ]));
  return {
    live,
    usedToday: new Map(used.map((r) => [r.step, Number(r.n)])),
    ends: ends as EndedJob[],
    streaks: streaks as StreakRow[],
    fps: new Map(fps.map((r): [string, FpRecord] => [`${r.step}|${r.repo}`, { job: r.job_id, fp: r.value }])),
    resets: new Map(resets.map((r) => [r.step, r.reset_at!])),
    heldLeaseKeys,
    marks: new Map(marks.map((r) => [r.step, r.value])),
  };
}

/**
 * Lanes with items are upserted and lanes with none are deleted; with `keepOthers` false every stored lane not named is
 * deleted too. A caller that holds the stored lists passes only the changed lanes with `keepOthers` true. One `db.write`.
 */
export async function saveLanes(db: Db, lanes: { lane: string; total: number; items: unknown[]; at: string }[], keepOthers = false): Promise<void> {
  const q = queryDb(db);
  const full = lanes.filter((l) => l.items.length > 0);
  const empty = lanes.filter((l) => l.items.length === 0).map((l) => l.lane);
  if (keepOthers && !lanes.length) return;
  await db.write(async () => {
    for (const part of kx.batches(full)) {
      await q.run(q.k.insertInto("lane_next").values(part.map((l) => ({ lane: l.lane, total: l.total, items: JSON.stringify(l.items), at: l.at })))
        .onConflict((oc) => oc.column("lane").doUpdateSet(kx.excluded(["total", "items", "at"]))));
    }
    if (!keepOthers) await q.run(q.k.deleteFrom("lane_next").where(kx.inList(db, "lane", full.map((l) => l.lane), "text", true)));
    else if (empty.length) await q.run(q.k.deleteFrom("lane_next").where(kx.inList(db, "lane", empty)));
  });
}

/** The stored lane lists, by lane name. */
export async function loadLanes(db: Db, names?: string[]): Promise<StoredLaneItems> {
  const out: StoredLaneItems = new Map();
  if (names && !names.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("lane_next").select(["lane", "total", "items", "at"]).$if(!!names, (b) => b.where(kx.inList(db, "lane", names!))))) {
    out.set(r.lane, { lane: r.lane, total: Number(r.total), items: JSON.parse(r.items) as unknown[], at: r.at } satisfies StoredLane);
  }
  return out;
}

/** One upsert for everything a pass or an apply writes: fingerprints, resets, cursors, marks. The last row of a key wins. */
export async function saveLaneState(db: Db, rows: LaneStatePut[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const at = nowIso();
  const byKey = new Map<string, LaneStatePut>();
  for (const r of rows) byKey.set(`${r.kind}\0${r.step}\0${r.repo ?? ""}`, r);
  const parts = kx.batches([...byKey.values()]);
  const write = async () => {
    for (const part of parts) {
      await q.run(q.k.insertInto("lane_state").values(part.map((r) => ({ kind: r.kind, step: r.step, repo: r.repo ?? "", value: r.value, job_id: r.job_id ?? null, at })))
        .onConflict((oc) => oc.columns(["kind", "step", "repo"]).doUpdateSet(kx.excluded(["value", "job_id", "at"]))));
    }
  };
  if (parts.length === 1) await write(); else await db.write(write);
}

/** Deletes state rows. */
export async function removeLaneState(db: Db, keys: { kind: LaneStateKind; step: string; repo?: string }[]): Promise<number> {
  if (!keys.length) return 0;
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("lane_state").where(kx.tupleIn(db, ["kind", "step", "repo"], keys.map((k) => [k.kind, k.step, k.repo ?? ""]), ["text", "text", "text"])))).changes;
}

/** State rows of the kinds (all without `kinds`), keyed "kind|step|repo". */
export async function loadLaneState(db: Db, kinds?: LaneStateKind[]): Promise<Map<string, LaneStateRow>> {
  if (kinds && !kinds.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("lane_state").select(["kind", "step", "repo", "value", "job_id", "at"]).$narrowType<{ kind: LaneStateKind }>()
    .$if(!!kinds, (b) => b.where("kind", "in", kinds!)));
  return new Map(rows.map((r) => [`${r.kind}|${r.step}|${r.repo}`, r]));
}

/**
 * Compare-and-set on a `lane_state` row of kind `mark`: sets the time only when the stored one is older than
 * `minGapMs` (or there is none); true when this caller won.
 */
export async function claimMark(db: Db, name: string, nowMs: number, minGapMs: number): Promise<boolean> {
  const q = queryDb(db);
  const at = new Date(nowMs).toISOString(), threshold = new Date(nowMs - minGapMs).toISOString();
  const won = await q.all(q.k.insertInto("lane_state").values({ kind: "mark", step: name, repo: "", value: at, job_id: null, at })
    .onConflict((oc) => oc.columns(["kind", "step", "repo"]).doUpdateSet(kx.excluded(["value", "at"])).where("lane_state.value", "<=", threshold)).returning("step"));
  return won.length > 0;
}

// Claim reads and the orphan return (package runners-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ciEq, indexedBy, inList, literal } from "../../db/kx.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { loadCooloffs } from "./cooloffs.ts";
import { goneCallExpr, loadLiveness } from "./calls-expiry.ts";
import { loadQueueFor, loadQueueSignature } from "./calls-queue-load.ts";
import { INTERACTIVE_PROMPTS, dropQueueCache, lostLeaseExpr } from "./calls-shared.ts";
import { unlease } from "./calls-unlease.ts";
import { loadRunnerRole } from "./cross.ts";
import { loadRunnerSnapshot } from "./runner-snapshot.ts";
import { loadUserSettings } from "./user-settings.ts";
import type { ClaimCaller, ClaimFacts, LeaseSource, QueueSnapshot, RunnerSnapshot, UserSettings } from "./types.ts";

/** A login with no stored settings. */
const NO_SETTINGS: UserSettings = { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false };

/**
 * Wave A of a claim: role and idle flag, cool-off, settings, lease counts, queue signature, and, for the first try (`requestId`), the orphan lease of a
 * repeated claim and the lost and gone calls of the expiry. About 9 statements in one round trip.
 */
export async function loadClaimFacts(db: Db, caller: ClaimCaller, opts: { requestId?: string; now: number }): Promise<ClaimFacts> {
  const { now } = opts;
  const q = queryDb(db);
  const login = caller.login.toLowerCase();
  const first = opts.requestId !== undefined;
  const [role, cooled, settings, counts, signature, orphan, liveness, lost, gone] = await db.together(async () => await Promise.all([
    loadRunnerRole(db, caller.tokenId, now),
    loadCooloffs(db, [login], now),
    loadUserSettings(db, [login]),
    q.get(q.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("c.own_lane", "=", 1).then(0).else(1).end()), eb.lit(0)).as("leased"),
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when(eb.and([eb("c.own_lane", "=", 1), eb.or(INTERACTIVE_PROMPTS.map((p) => eb("c.prompt_id", "like", `${p}%`)))])).then(1).else(0).end()), eb.lit(0)).as("interactive")])
      .where("c.state", "=", literal("leased")).where(ciEq(db, "c.user_login", caller.login))),
    loadQueueSignature(db),
    first ? q.get(q.k.selectFrom("main.remote_calls").select(["id", "run_id", "lease_secret_hash"]).where("token_id", "=", caller.tokenId).where("claim_id", "=", opts.requestId!).where("state", "=", literal("leased"))) : Promise.resolve(undefined),
    loadLiveness(db, now),
    first ? q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => lostLeaseExpr(db, eb, now))) : Promise.resolve([]),
    first ? q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => goneCallExpr(db, eb, now))) : Promise.resolve([]),
  ]));
  const c = cooled.get(login);
  return {
    role: (role?.role as ClaimFacts["role"]) ?? null, idle: role?.idleClaimAt != null, cooled: c ? { until: Number(c.until), reason: c.reason } : null, settings: settings.get(login) ?? NO_SETTINGS,
    leased: Number(counts?.leased ?? 0), interactive: Number(counts?.interactive ?? 0), signature,
    orphan: orphan ? { id: Number(orphan.id), runId: orphan.run_id, leaseSecretHash: orphan.lease_secret_hash } : null, liveness,
    lost: lost.map((r) => Number(r.id)), gone: gone.map((r) => Number(r.id)),
  };
}

/** Wave B, only on a cache miss: the queue and the runner snapshot in one wave. */
export async function loadClaimWave(db: Db, caller: ClaimCaller, facts: ClaimFacts, now: number): Promise<{ queue: QueueSnapshot; snapshot: RunnerSnapshot }> {
  void caller;
  return await db.together(async () => {
    const [queue, snapshot] = await Promise.all([loadQueueFor(db, now, facts.signature), loadRunnerSnapshot(db, now)]);
    return { queue, snapshot };
  });
}

/** The queued call about to be leased, with its bundle (not in the queue read). */
export async function loadLeaseSource(db: Db, id: number): Promise<LeaseSource | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.remote_calls").select(["bundle", "base_stdin", "job_id", "step", "stage", "prompt_id", "prompt_version", "asked_model", "items"]).where("id", "=", id).where("state", "=", "queued"));
  return r ? { bundle: r.bundle, baseStdin: r.base_stdin, jobId: r.job_id, step: r.step, stage: Number(r.stage), promptId: r.prompt_id, promptVersion: r.prompt_version, askedModel: r.asked_model, items: JSON.parse(r.items) as ItemRef[] } : null;
}

/** Records an idle helper's tiers and repos. */
export async function markHelperIdle(db: Db, tokenId: number, a: { now: number; tiers: string[]; repos: string[] | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_helpers").set({ idle_claim_at: a.now, idle_tiers: JSON.stringify(a.tiers), idle_repos: a.repos ? JSON.stringify(a.repos) : null }).where("token_id", "=", tokenId));
  dropQueueCache(db);
}

/** Clears picks of calls, optionally only those of `login`. */
export async function clearPicks(db: Db, ids: number[], login?: string): Promise<number> {
  if (!ids.length) return 0;
  const q = queryDb(db);
  const r = await q.run(q.k.updateTable("main.remote_calls").set({ picked_by: null, picked_at: null, pick_until: null }).where(inList(db, "id", ids, "bigint"))
    .where((eb) => (login === undefined ? eb("picked_by", "is not", null) : eb("picked_by", "=", login))));
  if (Number(r.changes) > 0) dropQueueCache(db);
  return Number(r.changes);
}

/** Returns the lease a repeated claim took before a restart: unlease, tombstone and run failure in one transaction. */
export async function returnOrphanLease(db: Db, orphan: { id: number; runId: number | null; leaseSecretHash: string | null }, now: number): Promise<void> {
  await unlease(db, { id: orphan.id, runId: orphan.runId, hash: orphan.leaseSecretHash }, "returned to the queue: the claim that leased it was repeated after a server restart", now);
}

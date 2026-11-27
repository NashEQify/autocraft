// reads: workflow.item_workflows (and through workflow.worksOnPr implement.implementations and mirror.items), access.mcp_tokens, access.access
// The conditions that must hold at the instant of the lease, under the login's lock, so they cannot be loaded beforehand.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ciEq, indexedBy, literal, ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";
import { setRunProgress } from "../inference/index.ts";
import { LIVE_STATES, worksOnPr } from "../workflow/fragments.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { MAX_CALLS_KEY, MAX_CALLS_MAX, STATUS_FRESH_MS, lostLeaseExpr, sha256hex } from "./calls-shared.ts";
import type { LiveLease, Tier } from "./types.ts";
import { expireLeases } from "./calls-expiry.ts";
import { unlease } from "./calls-unlease.ts";

/**
 * The started-work condition inside the lease update: every item of the call (`remote_call_items`) has a live workflow started or
 * approved by `login`, or is the PR that one works on.
 */
export function startedWorkAllows(db: Db, eb: Eb, login: string, callIdRef: string): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const owns = (e: any, item: string) => e.exists(schemaEb(e).selectFrom("main.item_workflows as ow").select(one)
    .where("ow.state", "in", LIVE_STATES).where("ow.repo", "=", ref<string>(`${item}.repo`))
    .where((x: any) => x.or([ciEq(db, "ow.started_by", x.val(login)), ciEq(db, "ow.approved_by", x.val(login))]))
    .where((x: any) => x.or([x("ow.number", "=", ref<number>(`${item}.number`)), worksOnPr(x, "ow", `${item}.number`)])));
  return w.not(w.exists(schemaEb(w).selectFrom("main.remote_call_items as ci").select(one).where("ci.call_id", "=", ref<number>(callIdRef)).where((e: any) => e.not(owns(e, "ci")))));
}

/** The Task Runner credential is live (a runner token not expired) and its login may run tasks (maintainer or operator). */
export function credentialLive(eb: Eb, tokenIdRef: string, nowIso: string): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  return w.exists(schemaEb(w).selectFrom("main.mcp_tokens as lt").innerJoin("main.access as la", "la.login", "lt.login").select(w.lit(1).as("one"))
    .where("lt.id", "=", ref<number>(tokenIdRef)).where("lt.kind", "=", "runner").where("lt.expires_at", ">", nowIso).where("la.role", "in", ["maintainer", "operator"]));
}

/** The role of a live Task Runner credential's user and whether its helper marked itself idle; null when the credential is gone or expired. */
export async function loadRunnerRole(db: Db, tokenId: number, now: number): Promise<{ role: string; idleClaimAt: number | null } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login").leftJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .select(["a.role", "h.idle_claim_at"]).where("t.id", "=", tokenId).where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(now).toISOString()));
  return r ? { role: r.role, idleClaimAt: r.idle_claim_at } : null;
}

const LEASE_COLS = ["c.id", "c.job_id", "c.run_id", "c.user_login", "c.prompt_id", "c.items", "c.repo", "c.root", "c.lease_secret_hash", "c.token_id", "c.tier", "c.model", "c.asked_model", "c.step", "c.attempt", "c.max_attempts", "c.leased_at", "c.parent_id", "c.for_login", "c.refusals", "c.setup_retries", "c.lease_timeout_ms", "c.started_at"] as const;

type Found = { lease: LiveLease; bundle: string | null; harness: string | null; harnessVersion: string | null; referenceRepo: string | null };

/**
 * The lease of `secret` with its credential check and lost flag, in one statement; the slow paths (lost lease, credential gone) run here and
 * answer null. `bundle` reads what the harness runs too (up to megabytes, so the lease checks leave it out).
 */
async function findLease(db: Db, secret: string, now: number, o: { bundle?: boolean } = {}): Promise<Found | null> {
  const q = queryDb(db);
  const hash = sha256hex(secret);
  const r = await q.get(q.k.selectFrom("main.remote_calls as c")
    .leftJoin("main.mcp_tokens as t", (j) => j.onRef("t.id", "=", "c.token_id").on("t.kind", "=", "runner").on("t.expires_at", ">", new Date(now).toISOString()))
    .leftJoin("main.access as a", (j) => j.onRef("a.login", "=", "t.login").on("a.role", "in", ["maintainer", "operator"]))
    .select([...LEASE_COLS, "a.login as ok", (eb) => eb.case().when(lostLeaseExpr(db, eb, now, "c")).then(1).else(0).end().as("lost")])
    .$if(!!o.bundle, (b) => b.select(["c.bundle", "c.harness", "c.harness_version", "c.reference_repo"]))
    .where("c.lease_secret_hash", "=", hash).where("c.state", "=", "leased"));
  if (!r) return null;
  if (Number(r.lost) === 1) {
    await expireLeases(db, { now, ids: [Number(r.id)] });
    return null;
  }
  if (r.ok === null) {
    await unlease(db, { id: Number(r.id), runId: r.run_id, hash }, "returned to the queue: the Task Runner that claimed it was removed or may no longer run tasks", now);
    return null;
  }
  // A claim always records its login; a leased row without one has no one to act for.
  if (r.user_login === null) return null;
  const lease: LiveLease = {
    id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo, root: r.root,
    secretHash: hash, tokenId: r.token_id === null ? null : Number(r.token_id), tier: r.tier as Tier, model: r.model, askedModel: r.asked_model, step: r.step,
    attempt: Number(r.attempt), maxAttempts: Number(r.max_attempts), leasedAt: r.leased_at === null ? null : Number(r.leased_at), parentId: r.parent_id, forLogin: r.for_login, refusals: Number(r.refusals), setupRetries: Number(r.setup_retries),
    leaseTimeoutMs: r.lease_timeout_ms === null ? null : Number(r.lease_timeout_ms), startedAt: r.started_at === null ? null : Number(r.started_at),
  };
  return { lease, bundle: r.bundle ?? null, harness: r.harness ?? null, harnessVersion: r.harness_version ?? null, referenceRepo: r.reference_repo ?? null };
}

const validSecret = (secret: string | undefined): secret is string => !!secret && secret.length <= 200 && secret.startsWith("aclease_");

/** The call by lease secret joined to the runner credential (`mcp_tokens`, `access`), with a `lost` flag. 1 statement; the slow path runs `expireLeases` or `unlease`. */
export async function loadLiveLease(db: Db, secret: string, now: number): Promise<LiveLease | null> {
  return validSecret(secret) ? (await findLease(db, secret, now))?.lease ?? null : null;
}

/** The live lease with its bundle, harness and reference repo in one statement. */
export async function loadLeaseBundle(db: Db, secret: string, now: number): Promise<{ lease: LiveLease; bundle: string; harness: string | null; harnessVersion: string | null; referenceRepo: string | null } | null> {
  const f = validSecret(secret) ? await findLease(db, secret, now, { bundle: true }) : null;
  return f ? { lease: f.lease, bundle: f.bundle!, harness: f.harness, harnessVersion: f.harnessVersion, referenceRepo: f.referenceRepo } : null;
}

/** Fast path of a heartbeat: one compare-and-set update guarded by the lease, the lost test and a valid credential. */
export async function heartbeatLease(db: Db, secret: string, h: { progress: string | null; phase: string | null }, now: number): Promise<{ runId: number | null } | null> {
  if (!validSecret(secret)) return null;
  const q = queryDb(db);
  const r = await q.get(q.k.updateTable("main.remote_calls").set((eb) => ({
    heartbeat_at: now, ...(h.progress !== null && { progress: h.progress }),
    ...(h.phase === "running" && { started_at: eb.case().when("started_at", "is", null).then(now).else(eb.ref("started_at")).end() }),
  })).where("lease_secret_hash", "=", sha256hex(secret)).where("state", "=", "leased")
    .where((eb) => eb.not(lostLeaseExpr(db, eb, now))).where((eb) => credentialLive(eb, "remote_calls.token_id", new Date(now).toISOString()))
    .returning(["id", "run_id"]));
  if (!r) {
    // No row: the lease is lost, ended or its credential gone; the slow path ends it as needed and the route answers 410.
    await findLease(db, secret, now);
    return null;
  }
  if (h.progress !== null && r.run_id !== null) await setRunProgress(db, [{ id: r.run_id, line: h.progress }]);
  return { runId: r.run_id };
}

/** Deletes the last status of tokens that no longer exist (the backstop of `removeHelpers`). */
export async function deleteOrphanHelpers(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.run(q.k.deleteFrom("main.remote_helpers").where((eb) => eb.not(eb.exists(q.k.selectFrom("main.mcp_tokens as t").select(eb.lit(1).as("one")).where("t.id", "=", ref<number>("remote_helpers.token_id"))))));
  return Number(r.changes);
}

/** The leases `loginExpr` holds outside the own lane, as a scalar subquery (the count `Max calls at once` limits). */
export function leasedCountExpr(db: Db, eb: Eb, loginExpr: Ex): Expression<number> {
  const w = schemaEb(eb) as any;
  return w.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "pl")).select((e: any) => e.fn.coalesce(e.fn.sum(e.case().when("pl.own_lane", "=", 1).then(0).else(1).end()), e.lit(0)).as("n"))
    .where("pl.state", "=", literal("leased")).where(ciEq(db, "pl.user_login", loginExpr));
}

/**
 * On a `remote_calls` row that has a pick: the pick no longer counts at `now`, as its time is up or its picker cannot take it now: no fresh Task Runner
 * credential, cooling off, or already at its Max calls at once.
 */
export function pickLapsedExpr(db: Db, eb: Eb, now: number): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const login = ref<string>("remote_calls.picked_by");
  const max = w.cast(w.case().when("ps.key", "=", MAX_CALLS_KEY).then(w.ref("ps.value")).end(), "bigint");
  const picker = w.and([
    w.exists(schemaEb(w).selectFrom("main.remote_helpers as ph").innerJoin("main.mcp_tokens as pt", "pt.id", "ph.token_id").select(one)
      .where("ph.login", "=", login).where("pt.kind", "=", "runner").where("pt.expires_at", ">", new Date(now).toISOString()).where("ph.reported_at", ">=", now - STATUS_FRESH_MS)),
    w.not(w.exists(schemaEb(w).selectFrom("main.remote_cooloffs as pc").select(one).where("pc.login", "=", login).where("pc.until", ">", now))),
    w.not(w.exists(schemaEb(w).selectFrom("main.user_settings as ps").select(one).where("ps.login", "=", login).where("ps.key", "=", MAX_CALLS_KEY)
      .where(w.between(max, 1, MAX_CALLS_MAX)).where(w(leasedCountExpr(db, w, login), ">=", max)))),
  ]);
  return w.or([w("pick_until", "<", now), w.not(picker)]);
}

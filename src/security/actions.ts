// The security deep scan's operator actions, shared by the dashboard API and the CLI. Callers check who may act; these
// functions check the state of the scan or finding and throw a SecurityError that carries an HTTP-style status.
import type { FindingAction, FindingState, FindingView, ScanView } from "../../web/src/api/types.ts";
import { filterSeq } from "../async-seq.ts";
import { featureOn } from "../build/features.ts";
import { audit } from "../dash/audit.ts";
import { TERMINAL, cancelTask, confidentialReadyAt, getTask, privateClockStart } from "../build/tasks.ts";
import { enqueue, JobError, requestCancel } from "../runner/jobs.ts";
import { securityRepo, SECURITY_STEP, REASON_MAX, MIN_VERIFY_SCORE } from "./rules.ts";
import { activeScan, ACTIVE_STATES, advance, clearRounds, finishScan, findingKey, findingRow, moveFinding, reconcileFindings, reconcileScans, reopenUnchecked, scanRow, toFinding, toScan, UNCHECKED_RESULT } from "./store.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export class SecurityError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NOT_FOUND = "not found";
/** The most a spend cap may be, in dollars. */
const CAP_MAX = 100_000;
/** Extra audit details, for example where the action came from. */
export type AuditExtra = Record<string, unknown>;
/** The actions that start a step: the states they start from, the state the finding takes at once, and the step. */
const STEPS: Partial<Record<FindingAction, { from: FindingState[]; to: FindingState | null; step: string; busy: string }>> = {
  fix: { from: ["new", "backlog"], to: "fixing", step: "security-fix", busy: "a fix" },
  land: { from: ["ready", "awaiting-admin"], to: "landing", step: "security-land", busy: "a fix that is ready or waiting for an admin" },
  advisory: { from: ["ready", "awaiting-admin"], to: "landing", step: "security-advisory", busy: "a fix that is ready or waiting for an admin" },
  publish: { from: ["landed", "advisory"], to: null, step: "security-publish", busy: "a landed fix" },
};

export async function startScanAs(db: Db, repo: string, login: string, capUsd: unknown, extra: AuditExtra = {}): Promise<ScanView> {
  const cap = capUsd === undefined || capUsd === null ? null : capUsd;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX)) throw new SecurityError(400, `capUsd must be a dollar amount above 0 and up to ${CAP_MAX}, or null for no cap`);
  await reconcileScans(db, repo);
  if (await activeScan(db, repo)) throw new SecurityError(409, `${repo} already has a scan running`);
  const at = new Date().toISOString();
  const id = (await db.get(db.k.insertInto("security_scans").values({ repo, state: "modeling", cap_usd: cap, started_by: login, started_at: at }).returning("id")))!.id;
  try {
    const job = await enqueue(db, SECURITY_STEP, { repo, scan: id }, login);
    // The job is recorded under the scan's pseudo repo, so every job listing that leaves out hidden repos leaves it out for viewers.
    await db.run(db.k.updateTable("jobs").set({ repo: securityRepo(repo) }).where("id", "=", job.id));
    await db.run(db.k.updateTable("security_scans").set({ job_id: job.id }).where("id", "=", id));
  } catch (e) {
    await db.run(db.k.deleteFrom("security_scans").where("id", "=", id));
    if (e instanceof JobError) throw new SecurityError(e.status, e.message);
    throw e;
  }
  await audit(db, login, "security-scan-start", `${repo}:scan:${id}`, { repo, capUsd: cap, ...extra });
  return await toScan(db, (await scanRow(db, id))!);
}

/**
 * Continues a scan that stopped at its spend cap with a new cap (null = none) that is above what it has spent. It takes the
 * repo's one active-scan slot, keeps its pinned commit, threat model, areas and findings, and queues its job again. A
 * stopped scan is not continued: an operator ended it, and it may have no threat model.
 */
export async function continueScanAs(db: Db, id: number, login: string, capUsd: unknown, extra: AuditExtra = {}): Promise<ScanView> {
  const scan = await scanRow(db, id);
  if (!scan) throw new SecurityError(404, NOT_FOUND);
  if (scan.state !== "capped") throw new SecurityError(409, `only a scan that stopped at its cap can be continued (this one is ${scan.state})`);
  const cap = capUsd === undefined || capUsd === null ? null : capUsd;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX)) throw new SecurityError(400, `capUsd must be a dollar amount above 0 and up to ${CAP_MAX}, or null for no cap`);
  if (cap !== null && cap <= scan.cost_usd) throw new SecurityError(400, `the new cap must be above the $${scan.cost_usd.toFixed(2)} the scan has spent`);
  await reconcileScans(db, scan.repo);
  if (await activeScan(db, scan.repo)) throw new SecurityError(409, `${scan.repo} already has a scan running`);
  const state = !scan.threat_model ? "modeling" : await db.get(db.k.selectFrom("security_findings").select((eb) => eb.lit(1).as("one")).where("scan_id", "=", id).where("state", "=", "new")
    .where((eb) => eb(kx.jsonText(db, "verification", "$.result"), "=", UNCHECKED_RESULT)).limit(1)) ? "verifying" : "scanning";
  const moved = (await db.run(db.k.updateTable("security_scans").set({ state, cap_usd: cap, ended_at: null, error: null, job_id: null }).where("id", "=", id).where("state", "=", "capped"))).changes;
  if (!moved) throw new SecurityError(409, "the scan changed; reload and try again");
  await reopenUnchecked(db, id);
  try {
    const job = await enqueue(db, SECURITY_STEP, { repo: scan.repo, scan: id }, login);
    await db.run(db.k.updateTable("jobs").set({ repo: securityRepo(scan.repo) }).where("id", "=", job.id));
    await db.run(db.k.updateTable("security_scans").set({ job_id: job.id }).where("id", "=", id));
  } catch (e) {
    await finishScan(db, id, "capped");
    await db.run(db.k.updateTable("security_scans").set({ cap_usd: scan.cap_usd, job_id: scan.job_id }).where("id", "=", id));
    if (e instanceof JobError) throw new SecurityError(e.status, e.message);
    throw e;
  }
  await audit(db, login, "security-scan-continue", `${scan.repo}:scan:${id}`, { repo: scan.repo, capUsd: cap, spentUsd: scan.cost_usd, ...extra });
  return await toScan(db, (await scanRow(db, id))!);
}

export async function stopScanAs(db: Db, id: number, login: string, extra: AuditExtra = {}): Promise<ScanView> {
  const scan = await scanRow(db, id);
  if (!scan) throw new SecurityError(404, NOT_FOUND);
  if (!ACTIVE_STATES.includes(scan.state)) throw new SecurityError(409, `the scan already ended (${scan.state})`);
  // A running job sees the state or the cancel flag before its next call and ends the scan itself.
  if (scan.job_id !== null) {
    try { await requestCancel(db, scan.job_id, login); } catch (e) { if (!(e instanceof JobError)) throw e; }
  }
  await finishScan(db, id, "stopped");
  await audit(db, login, "security-scan-stop", `${scan.repo}:scan:${id}`, { repo: scan.repo, was: scan.state, ...extra });
  return await toScan(db, (await scanRow(db, id))!);
}

export async function actOnFindingAs(db: Db, repo: string, n: number, login: string, b: Record<string, unknown>, extra: AuditExtra = {}): Promise<FindingView> {
  const action = b.action as FindingAction;
  const start = STEPS[action];
  if (start) return startStep(db, repo, n, login, action, start, b, extra);
  if (action !== "dismiss" && action !== "backlog" && action !== "reopen") throw new SecurityError(400, "unknown action");
  const row = await findingRow(db, repo, n);
  if (!row) throw new SecurityError(404, NOT_FOUND);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, REASON_MAX) : "";
  if (action === "dismiss" && !reason) throw new SecurityError(400, "dismissing needs a reason");
  const to = await moveFinding(db, repo, n, action, login, reason || null);
  if (!to) throw new SecurityError(409, `a finding that is ${row.state} cannot be ${action === "reopen" ? "reopened" : action === "dismiss" ? "dismissed" : "moved to the backlog"}`);
  await audit(db, login, `security-finding-${action}`, findingKey(repo, n), { from: row.state, to, ...(reason && { reason }), ...extra });
  return await toFinding(db, (await findingRow(db, repo, n))!);
}

/**
 * Starts the private fix of each confirmed finding (of `repo`, or finding `n` of it) that has never had a fix job (a cancelled one does not count):
 * verify held it up, so the fix is ready when an operator opens it, and Land stays the operator's. A fix that fails
 * leaves the finding new with its note, for the operator's Fix. With the scan-tests switch on, a finding whose scan test is
 * still building, or passed on the current code, waits for a person. Returns how many fixes it queued.
 */
export async function autoFixConfirmed(db: Db, repo?: string, n?: number): Promise<number> {
  // A fix whose job was cancelled (the pipeline was switched off) left the finding fixing; it goes back to new first.
  const repos = repo ? [repo] : (await db.all(db.k.selectFrom("security_findings").select("repo").distinct().where("state", "=", "fixing"))).map((r) => r.repo);
  for (const r of repos) await reconcileFindings(db, r);
  const scanTests = await featureOn(db, "scan-tests");
  const rows = await db.all(db.k.selectFrom("security_findings as f").select(["f.repo", "f.number"]).where("f.state", "=", "new")
    .where((eb) => eb(kx.jsonNum(db, "f.verification", "$.score"), ">=", MIN_VERIFY_SCORE))
    .$if(repo !== undefined, (q) => q.where("f.repo", "=", repo!))
    .$if(n !== undefined, (q) => q.where("f.number", "=", n!))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("jobs as j").select(eb.lit(1).as("one")).where("j.step", "=", "security-fix").where("j.state", "!=", "cancelled")
      .where((e) => e.and([e(kx.jsonText(db, "j.params", "$.repo"), "=", e.ref("f.repo")), e(kx.jsonNum(db, "j.params", "$.number"), "=", e.ref("f.number"))])))))
    .$if(scanTests, (q) => q.where((eb) => eb.not(eb.exists(eb.selectFrom("security_scan_tests as t").select(eb.lit(1).as("one")).whereRef("t.repo", "=", "f.repo").whereRef("t.number", "=", "f.number").where("t.state", "in", ["building", "not-shown"])))))
    .orderBy("f.repo").orderBy("f.number"));
  let queued = 0;
  for (const r of rows) {
    try {
      await startStep(db, r.repo, r.number, "pipeline", "fix", STEPS.fix!, {}, { auto: true });
      queued++;
    } catch (e) {
      if (!(e instanceof SecurityError)) throw e;
    }
  }
  return queued;
}

/** The longest a round's build tasks may run before the round counts as ended and its tasks are cancelled; the clock waits for a confidential environment (privateClockStart). */
export const ROUND_BUILD_LIMIT_MS = 4 * 3_600_000;

/**
 * Queues a fix job for each fixing finding whose build round has ended (its tasks are done, or it has been building past
 * ROUND_BUILD_LIMIT_MS, when the tasks are cancelled), or that waited for a confidential build environment that is now ready, and that has no fix job queued or running: the job reads the result and
 * writes the next round or the commit. The job is requested by whoever started the fix; fixes the pipeline started continue
 * only while `pipelineOn`. Returns how many jobs it queued.
 */
export async function advanceSecurityFixes(db: Db, pipelineOn = true): Promise<number> {
  const noJob = (eb: kx.AnyEb) => eb.not(eb.exists(eb.selectFrom("jobs as j").select(eb.lit(1).as("one")).where("j.step", "=", "security-fix").where("j.state", "in", ["queued", "running"])
    .where((e) => e.and([e(kx.jsonText(db, "j.params", "$.repo"), "=", e.ref("f.repo")), e(kx.jsonNum(db, "j.params", "$.number"), "=", e.ref("f.number"))]))));
  const rows: { repo: string; number: number; by: string | null; created_at: string | null; head_task: number | null; base_task: number | null }[] = await db.all(db.k.selectFrom("security_findings as f")
    .innerJoin("security_fix_rounds as r", (j) => j.onRef("r.repo", "=", "f.repo").onRef("r.number", "=", "f.number").on("r.state", "=", "building"))
    .select(["f.repo", "f.number", "f.decided_by as by", "r.created_at", "r.head_task", "r.base_task"])
    .where("f.state", "=", "fixing").where(noJob)
    .orderBy("f.repo").orderBy("f.number"));
  // A fix that waits for a confidential build environment continues once one is ready.
  if (await confidentialReadyAt(db) !== null) {
    rows.push(...await db.all(db.k.selectFrom("security_findings as f")
      .select((eb) => ["f.repo", "f.number", "f.decided_by as by", eb.lit(null).as("created_at"), eb.lit(null).as("head_task"), eb.lit(null).as("base_task")])
      .where("f.state", "=", "fixing").where("f.env_wait_at", "is not", null).where(noJob)
      .orderBy("f.repo").orderBy("f.number")));
  }
  let queued = 0;
  for (const r of rows) {
    const by = r.by ?? "pipeline";
    if (by === "pipeline" && !pipelineOn) continue;
    const open = (await filterSeq([r.head_task, r.base_task], async (id) => { const t = id === null ? null : await getTask(db, id); return !!t && !TERMINAL.includes(t.state); })).filter((id) => id !== null);
    if (open.length) {
      const since = await privateClockStart(db, r.created_at!);
      if (since === null || Date.now() - since <= ROUND_BUILD_LIMIT_MS) continue;
      for (const id of open) await cancelTask(db, id, "security-fix");
    }
    try {
      const job = await enqueue(db, STEPS.fix!.step, { repo: r.repo, number: r.number }, by);
      await db.run(db.k.updateTable("jobs").set({ repo: securityRepo(r.repo) }).where("id", "=", job.id));
      queued++;
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
    }
  }
  return queued;
}

/** Moves the finding to the state the step works in, then queues the step; the state goes back when the queue refuses. */
async function startStep(db: Db, repo: string, n: number, login: string, action: FindingAction, s: NonNullable<(typeof STEPS)[FindingAction]>, b: Record<string, unknown>, extra: AuditExtra): Promise<FindingView> {
  const row = await findingRow(db, repo, n);
  if (!row) throw new SecurityError(404, NOT_FOUND);
  if (!s.from.includes(row.state)) throw new SecurityError(409, `a finding that is ${row.state} cannot be ${action === "fix" ? "fixed" : action === "land" ? "landed" : action === "advisory" ? "sent the advisory way" : "published"}; this needs ${s.busy}`);
  if (action === "publish" && await db.get(db.k.selectFrom("jobs").select((eb) => eb.lit(1).as("one")).where("step", "=", s.step).where("state", "in", ["queued", "running"])
    .where((eb) => eb.and([eb(kx.jsonText(db, "params", "$.repo"), "=", repo), eb(kx.jsonNum(db, "params", "$.number"), "=", n)])).limit(1))) {
    throw new SecurityError(409, "this finding is already being published");
  }
  if (action === "fix" && !row.verification) throw new SecurityError(409, "the finding has not been verified");
  // Land after the advisory route starts over on the public fork: the advisory's private fork and its pull request are forgotten (ghsa_id stays).
  const reset: Record<string, null> = action === "land" && row.state === "awaiting-admin" ? { fork: null, fix_pr: null } : {};
  if (action === "fix") await clearRounds(db, repo, n);
  if (s.to && !await advance(db, repo, n, s.from, s.to, { note: null, ...reset }, login)) throw new SecurityError(409, "the finding changed; reload and try again");
  if (action === "fix") await db.run(db.k.updateTable("security_findings").set((eb) => ({ fix_attempts: eb("fix_attempts", "+", 1), last_failure: null })).where("repo", "=", repo).where("number", "=", n));
  try {
    const params: Record<string, string | number> = { repo, number: n, ...(action === "publish" && { cve: b.cve === true ? 1 : 0 }) };
    const job = await enqueue(db, s.step, params, login);
    // The job is recorded under the scan's pseudo repo, like the scan's own jobs, so job listings leave it out for viewers.
    await db.run(db.k.updateTable("jobs").set({ repo: securityRepo(repo) }).where("id", "=", job.id));
  } catch (e) {
    if (s.to) await advance(db, repo, n, [s.to], row.state, { fork: row.fork, fix_pr: row.fix_pr });
    if (action === "fix") await db.run(db.k.updateTable("security_findings").set({ fix_attempts: row.fix_attempts, last_failure: row.last_failure }).where("repo", "=", repo).where("number", "=", n));
    if (e instanceof JobError) throw new SecurityError(e.status, e.message);
    throw e;
  }
  await audit(db, login, `security-finding-${action}`, findingKey(repo, n), { from: row.state, ...(action === "publish" && { cve: b.cve === true }), ...extra });
  return await toFinding(db, (await findingRow(db, repo, n))!);
}

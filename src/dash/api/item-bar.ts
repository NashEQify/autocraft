// The status bar at the top of the item page: one headline for what is happening to the item now, and the item's path through the
// pipeline stages as a stepper. Everything is read from rows the item already has (jobs, model calls, fix-ups, reviews, decisions,
// pre-approvals); no step is shown that no row backs, except the core stages still ahead of an open item.
import type { DatabaseSync } from "node:sqlite";
import type { ItemBar, ItemBarStep, ItemKind, ItemState, ItemStatus } from "../../../web/src/api/types.ts";
import { stagesInOrder, stageOfStep, type StageId } from "../../stages/registry.ts";
import { clip, hiddenExpr, stepTitle, type Ctx } from "./trace.ts";
import { COMMENT_UNSENT_DELAYS_MS } from "../../core/rules.ts";
import type { NotNull } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

/** A step as people read it: its stage's short name ("Fix-up"), else its title. */
const nameOf = (step: string): string => stageOfStep(step)?.title ?? stepTitle(step);

/** core: shown while it is still ahead of an open item. seen: shown only once the item has been through it. */
type Role = "core" | "seen" | null;
const ROLE: Record<StageId, { pr: Role; issue: Role }> = {
  synced: { pr: null, issue: null }, labels: { pr: null, issue: null },
  dupes: { pr: "seen", issue: "seen" }, classify: { pr: "seen", issue: "seen" }, priority: { pr: "seen", issue: "seen" }, decide: { pr: "seen", issue: "seen" },
  review: { pr: "core", issue: null }, fix: { pr: null, issue: "seen" }, fixup: { pr: "seen", issue: null }, verify: { pr: "core", issue: null },
  merge: { pr: "core", issue: null }, act: { pr: null, issue: "seen" }, postmerge: { pr: "core", issue: null },
};

/** The stage an item's phase is in when no job says otherwise. */
const PHASE_STAGE: Partial<Record<ItemStatus["phase"], StageId>> = { Review: "review", Fixing: "fixup", Verifying: "verify", "In queue": "merge", "Waiting for a person": "decide" };
/** Phases in which AutoCraft has nothing ahead for the item. */
const INACTIVE: ItemStatus["phase"][] = ["Pipeline off", "Held", "Out of scope", "Merged", "Closed"];

/** A failure outside the stage the item is in still heads the bar for this long (phases without a stage: always). */
const RECENT_MS = 2 * 3600_000;
const POSTMERGE_MS = 24 * 3600_000;
const FAILED_JOBS_DAYS = 30;

/** Steps whose completion for an item completes their stage. Merge is done only from merged_at; fix-ups, CI fixes and verification come from their own rows. */
const COMPLETES = new Set(["dupes", "dupes-compare", "classify-new", "classify-all", "referee", "prioritize", "rank", "opus-review", "review-post", "fixissue-collect", "act", "postmerge", "postmerge-file"]);
const FAILED_OUTCOME = /^(refused|failed|error|exit \d)/i;
const HELD_OUTCOME = /^(held|skipped)/i;

/** What a finished job's row for one item says: a failure (the job failed or the outcome starts refused/failed), a completed stage, or nothing. */
export function classifyJob(j: { step: string; state: string; outcome: string | null }): "failed" | "done" | "neutral" {
  if (j.state === "failed" || FAILED_OUTCOME.test(j.outcome ?? "")) return "failed";
  return COMPLETES.has(j.step) && !HELD_OUTCOME.test(j.outcome ?? "") ? "done" : "neutral";
}

export interface Evidence { stage: StageId; state: "done" | "failed"; at: string; jobId: number | null; label: string; reason: string | null; step?: string }

/** Steps of the stepper, in pipeline order. Pure: the rows are read by `evidenceOf`. */
export function deriveSteps(i: {
  kind: ItemKind; state: ItemState; current: StageId | null; running: boolean; evidence: Evidence[]; costs: Map<StageId, number>;
  /** Stages ahead show: the repo's pipeline is on and the phase is active. */
  ahead: boolean; /** The post-merge review is still to come: AutoCraft merged it a short while ago in a repo with the pipeline on. */ postmergeNext: boolean;
}): ItemBarStep[] {
  const latest = new Map<StageId, Evidence>();
  for (const e of i.evidence) {
    const had = latest.get(e.stage);
    if (!had || e.at >= had.at) latest.set(e.stage, e);
  }
  const roles = stagesInOrder().flatMap((s) => { const r = ROLE[s.id][i.kind === "pr" ? "pr" : "issue"]; return r ? [{ s, r }] : []; });
  const state = (id: StageId): ItemBarStep["state"] => (id === i.current && !(!i.running && latest.get(id)?.state === "failed") ? "current" : latest.get(id)?.state ?? "next");
  const last = roles.reduce((m, { s }, idx) => (state(s.id) !== "next" ? idx : m), -1);
  const out: ItemBarStep[] = [];
  roles.forEach(({ s, r }, idx) => {
    const st = state(s.id);
    const ev = latest.get(s.id);
    if (st === "next") {
      if (r !== "core" || idx < last) return;
      if (i.state === "open" ? !i.ahead : s.id !== "postmerge" || i.state !== "merged" || !i.postmergeNext) return;
    }
    out.push({ stage: s.id, title: s.title, state: st, running: st === "current" && i.running, at: st === "next" ? null : ev?.at ?? null, costUsd: i.costs.get(s.id) ?? null, jobId: ev?.jobId ?? null });
  });
  // The current step never sits before a step shown done or failed: it goes after the last one.
  const cur = out.findIndex((x) => x.state === "current");
  let lastEv = -1;
  out.forEach((x, k) => { if (x.state === "done" || x.state === "failed") lastEv = k; });
  if (cur >= 0 && cur < lastEv) out.splice(lastEv, 0, out.splice(cur, 1)[0]!);
  return out;
}

const FIX_DONE = /^(pushed|merged)$/;
const FIX_FAILED = /^(failed|refused|rejected|too-large|cannot-push|push-denied|comment-failed)$/;

async function evidenceOf(c: Ctx, mergedAt: string | null, mergedByUs: boolean): Promise<Evidence[]> {
  const { db, repo, n } = c;
  const out: Evidence[] = [];
  const reasonOf = (s: string | null | undefined) => (c.staff && s ? clip(s.replace(/^(refused|failed|error):\s*/i, ""), 160) : null);
  const cleared = new Map<string, string>();
  const seen = new Set<number>();
  for (const j of await db.all(db.k.selectFrom("job_items as ji").innerJoin("jobs as j", "j.id", "ji.job_id")
    .select(["j.id", "j.step", "j.state", "ji.outcome", "ji.at", "j.ended_at", "j.error"])
    .where("ji.repo", "=", repo).where("ji.number", "=", n).where("j.state", "in", ["done", "failed"]).orderBy("ji.id"))) {
    seen.add(j.id);
    const stage = stageOfStep(j.step)?.id;
    const at = j.ended_at ?? j.at;
    const kind = classifyJob(j);
    if (kind === "failed") { if (stage) out.push({ stage, state: "failed", at, jobId: j.id, label: nameOf(j.step), reason: reasonOf(j.outcome || j.error), step: j.step }); continue; }
    if (HELD_OUTCOME.test(j.outcome ?? "")) continue;
    if (!(cleared.get(j.step)! >= at)) cleared.set(j.step, at);
    if (stage && kind === "done") out.push({ stage, state: "done", at, jobId: j.id, label: nameOf(j.step), reason: null, step: j.step });
  }
  // A crashed job has no job_items row: read it by its params.
  const since = new Date(Date.now() - FAILED_JOBS_DAYS * 86400_000).toISOString();
  for (const j of await db.all(db.k.selectFrom("jobs").select(["id", "step", "ended_at", "error"]).$narrowType<{ ended_at: NotNull }>()
    .where("state", "=", "failed").where("repo", "=", repo).where("ended_at", ">", since).where((eb) => eb(kx.jsonNum(db, "params", "$.number"), "=", n)))) {
    const stage = stageOfStep(j.step)?.id;
    if (stage && !seen.has(j.id)) out.push({ stage, state: "failed", at: j.ended_at, jobId: j.id, label: nameOf(j.step), reason: reasonOf(j.error), step: j.step });
  }
  const live = out.filter((e) => !(e.state === "failed" && e.step && (cleared.get(e.step) ?? "") > e.at));
  // A comment that did not reach GitHub fails only when it was the last try (src/core/rules.ts unsentAsk); before that it is posted again.
  const failed = (x: { state: string; unsent: number }) => FIX_FAILED.test(x.state) || (x.state === "comment-unsent" && x.unsent > COMMENT_UNSENT_DELAYS_MS.length);
  // The newest row, past unsent comments that are still retried: a retry may end the older row they left open.
  const rowsOf = (label: string, stage: StageId, rows: { state: string; reason: string | null; at: string; unsent: number }[]) => {
    const top = rows.find((x) => x.state !== "comment-unsent" || failed(x));
    const r = top && (FIX_DONE.test(top.state) || failed(top)) ? top : undefined;
    if (r) live.push({ stage, state: FIX_DONE.test(r.state) ? "done" : "failed", at: r.at, jobId: null, label, reason: FIX_DONE.test(r.state) ? null : reasonOf(r.reason) });
  };
  // The unsent comments at the row's head (and, for fix-ups, of its source and carry-over), as column `unsent`.
  rowsOf("Fix-up", "fixup", await db.all(db.k.selectFrom("fixups as x")
    .select((eb) => ["x.state", "x.reason", "x.created_at as at", eb.selectFrom("fixups as u").select((e) => e.fn.countAll<number>().as("n"))
      .whereRef("u.repo", "=", "x.repo").whereRef("u.number", "=", "x.number").whereRef("u.from_head", "=", "x.from_head")
      .where((e) => e.and([e("u.source", "is not distinct from", e.ref("x.source")), e("u.carry_decision", "is not distinct from", e.ref("x.carry_decision"))]))
      .where("u.state", "=", "comment-unsent").as("unsent")]).$narrowType<{ unsent: number }>()
    .where("x.repo", "=", repo).where("x.number", "=", n).where("x.state", "!=", "superseded").orderBy("x.created_at", "desc").orderBy(kx.rowid("fixups", "x"), "desc")));
  rowsOf("CI fix", "fixup", await db.all(db.k.selectFrom("ci_fixes as x")
    .select((eb) => ["x.state", "x.reason", "x.created_at as at", eb.selectFrom("ci_fixes as u").select((e) => e.fn.countAll<number>().as("n"))
      .whereRef("u.repo", "=", "x.repo").whereRef("u.number", "=", "x.number").whereRef("u.head", "=", "x.head").where("u.state", "=", "comment-unsent").as("unsent")]).$narrowType<{ unsent: number }>()
    .where("x.repo", "=", repo).where("x.number", "=", n).where("x.state", "!=", "superseded").orderBy("x.created_at", "desc").orderBy(kx.rowid("ci_fixes", "x"), "desc")));
  rowsOf("Conflict merge", "fixup", await db.all(db.k.selectFrom("conflict_merges as x")
    .select((eb) => ["x.state", "x.reason", "x.created_at as at", eb.selectFrom("conflict_merges as u").select((e) => e.fn.countAll<number>().as("n"))
      .whereRef("u.repo", "=", "x.repo").whereRef("u.number", "=", "x.number").whereRef("u.from_head", "=", "x.from_head").where("u.state", "=", "comment-unsent").as("unsent")]).$narrowType<{ unsent: number }>()
    .where("x.repo", "=", repo).where("x.number", "=", n).where("x.state", "!=", "superseded").orderBy("x.created_at", "desc").orderBy(kx.rowid("conflict_merges", "x"), "desc")));
  for (const v of await db.all(db.k.selectFrom("verifications").select(["state", "summary", (eb) => eb.fn.coalesce("finished_at", "created_at").as("at")])
    .where("repo", "=", repo).where("number", "=", n).where("state", "!=", "stale").orderBy("created_at", "desc").limit(1))) {
    if (v.state === "passed" || v.state === "ci-enough") live.push({ stage: "verify", state: "done", at: v.at, jobId: null, label: "Verify", reason: null });
    else if (v.state === "failed" || v.state === "error") live.push({ stage: "verify", state: "failed", at: v.at, jobId: null, label: "Verify", reason: reasonOf(v.summary) });
  }
  for (const r of await db.all(db.k.selectFrom("decisions").select((eb) => eb.fn.max<string>("answered_at").as("at"))
    .where("repo", "=", repo).where("number", "=", n).where("answer", "is not", null).having((eb) => eb.fn.max("answered_at"), "is not", null))) live.push({ stage: "decide", state: "done", at: r.at, jobId: null, label: "Decision", reason: null });
  if (mergedAt && mergedByUs) live.push({ stage: "merge", state: "done", at: mergedAt, jobId: null, label: "Merge", reason: null });
  return live;
}

export async function barOf(c: Ctx, it: { kind: ItemKind; state: ItemState; mergedAt: string | null; pipelineOn: boolean }, status: ItemStatus): Promise<ItemBar> {
  const { db, repo, n } = c;
  if (c.veiled) return { headline: { tone: "idle", text: status.phase, next: null, model: null, startedAt: null, jobId: null }, steps: [] };

  // A job_items row of a running job means the item is finished, so running work is matched by the job's params and by the item's own running calls.
  const open = it.state === "open";
  // The bar's reads do not depend on each other, so they run together.
  const [active, runs, mergedByUs, costRows, pre] = await Promise.all([
    db.all(db.k.selectFrom("jobs").select(["id", "step", "state", "started_at"])
      .where("state", "in", ["running", "queued"]).where("repo", "=", repo).where((eb) => eb(kx.jsonNum(db, "params", "$.number"), "=", n)).orderBy("id")),
    db.all(db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id").select(["r.step", "r.model", "r.job_id", "r.started_at"])
      .where("i.repo", "=", repo).where("i.number", "=", n).where("r.state", "=", "running").orderBy("r.id")),
    it.state === "merged" && db.get(db.k.selectFrom("merges").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n).where("outcome", "=", "merged").limit(1)).then((r) => r !== undefined),
    db.all(db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id").select(["r.step", "r.cost_usd as cost"]).$narrowType<{ cost: NotNull }>()
      .where("i.repo", "=", repo).where("i.number", "=", n).where("r.cost_usd", "is not", null).where((eb) => hiddenExpr(db, eb, c.hidden) ?? eb.lit(true)).orderBy("i.run_id")),
    open ? db.get(db.k.selectFrom("preapprovals").select(["state", "reason"]).where("repo", "=", repo).where("number", "=", n).orderBy("id", "desc").limit(1)) : undefined,
  ]);
  const job = active.find((j) => j.state === "running");
  const run = runs.find((r) => job && r.job_id === job.id) ?? runs[0];
  const queued = active.find((j) => j.state === "queued");

  const evidence = await evidenceOf(c, it.mergedAt, mergedByUs);
  const costs = new Map<StageId, number>();
  for (const r of costRows) {
    const id = stageOfStep(r.step)?.id;
    if (id) costs.set(id, (costs.get(id) ?? 0) + r.cost);
  }

  const runningStep = job?.step ?? run?.step ?? null;
  const phaseStage = PHASE_STAGE[status.phase];
  const latestFail = [...evidence].filter((e) => e.state === "failed").sort((a, b) => (a.at < b.at ? 1 : -1))
    .find((f) => !evidence.some((e) => e.stage === f.stage && e.state === "done" && e.at > f.at) && (!phaseStage || f.stage === phaseStage || Date.now() - Date.parse(f.at) < RECENT_MS));
  // A failed pre-approval heads the bar until a newer one replaces it or the PR merges.
  const preFailed = pre?.state === "failed" ? { label: /fix-up/i.test(pre.reason ?? "") ? "Fix-up" : "Pre-approved merge", reason: c.staff && pre.reason ? clip(pre.reason, 160) : null } : null;
  const current: StageId | null = runningStep ? stageOfStep(runningStep)?.id ?? null : queued ? stageOfStep(queued.step)?.id ?? null : open ? phaseStage ?? null : null;

  let headline: ItemBar["headline"];
  const base = { next: status.next, model: null, startedAt: null, jobId: null };
  const failText = (label: string, reason: string | null) => `${label} failed${reason ? `: ${reason}` : ""}`;
  if (open && runningStep) headline = { tone: "running", text: `${nameOf(runningStep)} running`, next: status.next, model: run?.model ?? null, startedAt: job?.started_at ?? run?.started_at ?? null, jobId: job?.id ?? run?.job_id ?? null };
  else if (open && queued) {
    const pos = (await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("k")).where("state", "=", "queued").where("step", "=", queued.step).where("id", "<", queued.id)))!.k + 1;
    headline = { ...base, tone: "queued", text: `Queued for ${nameOf(queued.step)} · #${pos} in line`, jobId: queued.id };
  } else if (open && status.outside) headline = { ...base, tone: "waiting", text: `Waiting: ${status.waiting ?? "an operator's release"}`, outside: status.outside };
  else if (preFailed) headline = { ...base, tone: "failed", text: failText(preFailed.label, preFailed.reason) };
  else if (open && status.phase === "Waiting for a person") headline = { ...base, tone: "waiting", text: status.waiting ? `Waiting for ${status.waiting}` : "Waiting for a person" };
  else if (open && latestFail) headline = { ...base, tone: "failed", text: failText(latestFail.label, latestFail.reason), jobId: latestFail.jobId };
  else if (!open) headline = { ...base, tone: "done", text: it.state === "merged" ? "Merged" : "Closed", next: it.state === "merged" ? status.next : null };
  else headline = { ...base, tone: "idle", text: status.waiting ? `${status.phase} · waiting for ${status.waiting}` : status.phase };

  const ahead = open && it.pipelineOn && !INACTIVE.includes(status.phase);
  const mergedMs = it.mergedAt ? Date.now() - Date.parse(it.mergedAt) : Infinity;
  const postmergeNext = mergedByUs && it.pipelineOn && mergedMs < POSTMERGE_MS;
  const steps = deriveSteps({ kind: it.kind, state: it.state, current, running: headline.tone === "running", evidence, costs, ahead, postmergeNext });
  if (preFailed) {
    // The stage the pre-approval failed in shows failed, whatever else the stepper says.
    const k = steps.findIndex((x) => x.stage === (preFailed.label === "Fix-up" ? "fixup" : "merge"));
    if (k >= 0 && steps[k]!.state !== "current") steps[k] = { ...steps[k]!, state: "failed" };
  }
  return { headline, steps };
}

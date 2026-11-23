// The item trace: every event of one GitHub item, oldest first, from the tables that hold per-item history.
// Each source is a small function that returns events for the item through an index on (repo, number) or a
// key derived from it; the list carries no bodies. A source also keeps the fields its detail view shows.
import { isQuiet } from "../../security/quiet.ts";
import { createHash } from "node:crypto";
import type { ItemTrace, ItemTraceDetail, ItemTraceHeader, TraceActor, TraceEvent, TraceKind } from "../../../web/src/api/types.ts";
import { reposOf } from "../../decisions.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { knownStep } from "../../runner/steps.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { AUDIT_ACTIONS, operatorOnly } from "./admin.ts";
import { detailOf } from "./github-detail.ts";
import { canSeeInternals } from "./staff.ts";
import { blankIfHidden, hiddenRepos, needVisible } from "./visible.ts";
import { reasonsFor, waitFor, type Reader } from "./reader.ts";
import { filtered, hiddenTestExpr, isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { ownLogins } from "../../github/identity.ts";
import { mapSeq } from "../../async-seq.ts";
import type { AliasedExpression, AliasableExpression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { setting } from "../../settings-read.ts";

export type Ev = TraceEvent & { detail?: Record<string, unknown> };
/** `staff`: operators and maintainers; `hidden`: repos the viewer may not see, whose runs are left out like getRun does. */
export type Ctx = { db: Db; repo: string; n: number; ref: string; own: Set<string>; box: string; staff: boolean; /** A quiet pull request seen by a viewer: model output stays out of the trace. */ veiled: boolean; operator: boolean; hidden: HiddenRepos };
type Source = { kinds: TraceKind[]; run: (c: Ctx) => Promise<Ev[]> };

export const TRACE_PAGE_DEFAULT = 100, TRACE_PAGE_MAX = 500;
export const KINDS: TraceKind[] = ["github", "plan", "job", "model-call", "check", "review", "decision", "write", "step", "conversation"];

export const humanize = (id: string): string => { const t = id.replace(/[-_]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** A step's name as the dashboard shows it. */
export const stepTitle = (id: string): string => knownStep(id)?.title ?? humanize(id);
export const step = (name: string): TraceActor => ({ type: "step", name: name === "AutoCraft" ? name : stepTitle(name) });
export const person = (name: string | null | undefined): TraceActor => ({ type: "person", name: name || "unknown" });
export const model = (name: string | null | undefined, fallback: string): TraceActor => ({ type: "model", name: name || fallback });
export const clip = (s: string | null | undefined, n = 140): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
export const arr = <T = unknown>(s: string | null | undefined): T[] => { const v = json<unknown>(s, []); return Array.isArray(v) ? (v as T[]) : []; };
export const obj = (s: string | null | undefined): Record<string, unknown> => { const v = json<unknown>(s, {}); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; };
/** One format for every time, so mixed formats sort right; null when it is not a time. */
export const iso = (at: unknown): string | null => { const t = typeof at === "string" ? Date.parse(at) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : /(s|x|z|ch|sh)$/.test(w) ? "es" : "s"}`;
const count = (xs: unknown[]): string => plural(xs.length, "finding");

export type ItemRow = { kind: string | null; author: string | null; created_at: string | null; closed_at: string | null; merged_at: string | null; merged_by: string | null; head_oid: string | null };
export const openedEvent = (it: ItemRow): Ev => ({ id: "gh:opened", kind: "github", at: it.created_at ?? "", head: null, actor: person(it.author), summary: `Opened ${it.kind === "pr" ? "pull request" : "issue"} on GitHub${it.author ? ` by ${it.author}` : ""}`, ref: {} });
export const mergedEvent = (it: ItemRow): Ev => ({ id: "gh:merged", kind: "github", at: it.merged_at ?? "", head: it.head_oid, actor: person(it.merged_by), summary: `Merged on GitHub${it.merged_by ? ` by ${it.merged_by}` : ""}`, ref: {} });
export const closedEvent = (it: ItemRow): Ev => ({ id: "gh:closed", kind: "github", at: it.closed_at ?? "", head: null, actor: person(null), summary: "Closed on GitHub", ref: {} });
/** Longest comment text a trace event carries. */
export const TRACE_BODY_MAX = 20_000;
/** `body`, when given, is the stored text (the item trace selects it; the activity feed does not, to keep its pages light). */
export const commentEvent = (c: { id: string; kind: string | null; author: string | null; created_at: string; review_state: string | null; commit_oid: string | null; len: number; body?: string | null; cut?: SqlBool | null }, own: Set<string>): Ev => {
  const ours = !!c.author && own.has(c.author);
  const what = c.kind === "review" ? `review (${(c.review_state ?? "commented").toLowerCase().replace("_", " ")})` : "comment";
  return {
    id: `comment:${c.id}`, kind: "github", at: c.created_at, head: c.commit_oid, actor: ours ? step("AutoCraft") : person(c.author),
    summary: `${ours ? "AutoCraft posted a" : "Posted a"} ${what}, ${c.len} characters`, ref: { commentId: c.id },
    ...(c.body && { body: c.body, ...(c.cut && { bodyCut: true }) }),
  };
};
export const activityEvent = (a: { id: string; kind: string; at: string; actor: string | null; label: string | null; after_oid: string | null; before_oid: string | null }, own: Set<string>): Ev => {
  const ours = !!a.actor && own.has(a.actor);
  const summary = a.kind === "force-push" ? `Force-pushed ${(a.before_oid ?? "").slice(0, 7)} → ${(a.after_oid ?? "").slice(0, 7)}` : `${a.kind === "labeled" ? "Added" : "Removed"} label ${a.label ?? ""}`;
  return { id: `activity:${a.id}`, kind: "github", at: a.at, head: a.kind === "force-push" ? a.after_oid : null, actor: ours ? step("AutoCraft") : person(a.actor), summary, ref: a.after_oid ? { head: a.after_oid } : {} };
};

const github: Source = {
  kinds: ["github"],
  async run({ db, repo, n, own }) {
    const out: Ev[] = [];
    const it = await db.get(db.k.selectFrom("items").select(["kind", "author", "created_at", "closed_at", "merged_at", "merged_by", "head_oid"]).where("repo", "=", repo).where("number", "=", n));
    if (it?.created_at) out.push(openedEvent(it));
    // AutoCraft's own merge step records its entry (mergeEvent); a second GitHub entry would count the same merge twice.
    const ours = await db.get(db.k.selectFrom("merges").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n).where("outcome", "=", "merged").limit(1)) !== undefined;
    if (it?.merged_at && !ours) out.push(mergedEvent(it));
    else if (it?.closed_at) out.push(closedEvent(it));
    for (const c of await db.all(db.k.selectFrom("comments")
      .select((eb) => ["id", "kind", "author", "created_at", "review_state", "commit_oid", eb.fn<number>("length", [eb.fn.coalesce("body", eb.val(""))]).as("len"),
        eb.fn<string | null>("substr", ["body", eb.lit(1), eb.lit(TRACE_BODY_MAX)]).as("body"), eb(eb.fn("length", ["body"]), ">", eb.lit(TRACE_BODY_MAX)).as("cut")])
      .where("repo", "=", repo).where("number", "=", n).where("created_at", "is not", null)
      .$narrowType<{ created_at: string }>())) {
      out.push(commentEvent(c, own));
    }
    for (const c of await db.all(db.k.selectFrom("pr_commits")
      .select((eb) => ["oid", kx.least<string>(db, ["committed_at", eb.fn.coalesce("first_seen_at", "committed_at")], "text").as("committed_at"), "author"])
      .where("repo", "=", repo).where("number", "=", n)
      .$narrowType<{ committed_at: string }>())) {
      // Our own commits are shown by their audit rows.
      if (c.author && own.has(c.author)) continue;
      out.push({ id: `commit:${c.oid}`, kind: "github", at: c.committed_at, head: c.oid, actor: person(c.author), summary: `Pushed commit ${c.oid.slice(0, 7)}`, ref: { head: c.oid } });
    }
    for (const a of await db.all(db.k.selectFrom("item_activity").select(["id", "kind", "at", "actor", "label", "after_oid", "before_oid"]).where("repo", "=", repo).where("number", "=", n))) {
      out.push(activityEvent(a, own));
    }
    return out;
  },
};

export const stageEvent = (s: { rowid: number; stage: string; at: string; actor: string | null; note: string | null }): Ev =>
  ({ id: `stage:${s.rowid}`, kind: "plan", at: s.at, head: null, actor: step(s.actor || "pipeline"), summary: `Stage ${s.stage}${s.note ? `: ${clip(s.note)}` : ""}`, ref: {} });

const stages: Source = {
  kinds: ["plan"],
  run: async ({ db, repo, n }) => (await db.all(db.k.selectFrom("stages").select([kx.rowid("stages").as("rowid"), "stage", "at", "actor", "note"]).where("repo", "=", repo).where("number", "=", n))).map(stageEvent),
};

export const planEvent = (p: { id: number; head: string | null; old_state: string | null; new_state: string; wait: string | null; reasons: string; at: string }): Ev => ({
  id: `plan:${p.id}`, kind: "plan", at: p.at, head: p.head, actor: step("planner"),
  summary: `Plan ${p.old_state ? `${p.old_state} → ` : "started as "}${p.new_state}${p.wait ? `, waiting for ${clip(p.wait, 80)}` : ""}`,
  ref: p.head ? { head: p.head } : {}, detail: { from: p.old_state, to: p.new_state, wait: p.wait, reasons: arr<string>(p.reasons) },
});

/** `planEvent` for one reader: the wait and reasons without items of repos hidden from them (src/dash/api/reader.ts). */
export const planEventFor = (r: Pick<Reader, "staff" | "hidden">, p: Parameters<typeof planEvent>[0]): Ev =>
  planEvent({ ...p, wait: waitFor(r, p.wait), reasons: JSON.stringify(reasonsFor(r, arr<string>(p.reasons))) });

const plans: Source = {
  kinds: ["plan"],
  run: async (c) => (await c.db.all(c.db.k.selectFrom("plan_history").select(["id", "head", "old_state", "new_state", "wait", "reasons", "at"]).where("repo", "=", c.repo).where("number", "=", c.n))).map((p) => planEventFor(c, p)),
};

export const jobEvent = (j: { id: number; job_id: number; outcome: string | null; at: string; step: string | null; state: string | null; error: string | null }): Ev => ({
  id: `job:${j.id}`, kind: "job", at: j.at, head: null, actor: step(j.step ?? "job"),
  summary: `${j.step ? stepTitle(j.step) : "Job"}: ${clip(j.outcome) || j.state || "ran"}`, ref: { jobId: j.job_id }, detail: { step: j.step, state: j.state, outcome: j.outcome, error: j.error },
});

const jobs: Source = {
  kinds: ["job"],
  run: async ({ db, repo, n }) => (await db.all(db.k.selectFrom("job_items as ji").leftJoin("jobs as j", "j.id", "ji.job_id")
    .select(["ji.id", "ji.job_id", "ji.outcome", "ji.at", "j.step", "j.state", "j.error"]).where("ji.repo", "=", repo).where("ji.number", "=", n))).map(jobEvent),
};

/** Leaves out runs `r` that also touched a hidden repo; null when nothing is hidden. */
export const hiddenExpr = (db: Db, eb: kx.Eb, hidden: HiddenRepos): AliasableExpression<SqlBool> | null => (filtered(hidden)
  ? eb.not(eb.exists(db.k.selectFrom("agent_run_items as x").select(eb.lit(1).as("one")).where("x.run_id", "=", eb.ref("r.id")).where(hiddenTestExpr(db, "x.repo", hidden))))
  : null);

/** Prompts whose calls are named by what they do, not by the step that makes them. */
const PROMPT_TITLES: Record<string, string> = { "lint.reference.jev": "Reference lint", "lint.reference.haiku": "Reference lint" };

/** The event columns of a run, as selections on `r` (agent_runs) and `a` (claude_accounts, left joined): `.select((eb) => runColumnsExpr(db, eb))`. */
export const runColumnsExpr = (db: Db, eb: kx.Eb) => [
  "r.id", "r.step", "r.prompt_id", "r.model", "r.provider", "r.state", "r.started_at", "r.ended_at", "r.input_tokens", "r.output_tokens", "r.cost_usd",
  "r.summary", "r.job_id", "r.user_login", "r.harness", "r.reported_model",
  eb.fn.coalesce(eb.ref("a.label"), eb.ref("r.account_id")).as("label") as AliasedExpression<string | null, "label">,
  db.k.selectFrom("agent_run_tools as t").select((e) => e.fn.countAll<number>().as("n")).where("t.run_id", "=", eb.ref("r.id")).as("tools"),
] as const;

export const runEvent = (r: { id: number; step: string; prompt_id: string; model: string; provider: string; state: string; started_at: string; ended_at: string | null; input_tokens: number | null; output_tokens: number | null;
  cost_usd: number | null; summary: string | null; label: string | null; tools: number; job_id: number | null; user_login?: string | null; harness?: string | null; reported_model?: string | null }, staff = false): Ev => ({
  id: `run:${r.id}`, kind: "model-call", at: r.started_at, head: null, actor: model(r.model, "model"),
  summary: `${PROMPT_TITLES[r.prompt_id] ?? stepTitle(r.step)}: ${r.state === "running" ? "running" : r.state === "failed" ? "failed" : clip(r.summary, 100) || "done"}`,
  ref: { runId: r.id, ...(r.job_id !== null ? { jobId: r.job_id } : {}) },
  call: { promptId: r.prompt_id, step: stepTitle(r.step), model: r.model, provider: r.provider, account: r.label, state: r.state, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd, toolCalls: r.tools, endedAt: r.ended_at, ...(staff && r.user_login && { via: { login: r.user_login, harness: r.harness ?? "", model: r.reported_model ?? "" } }) },
});

const modelCalls: Source = {
  kinds: ["model-call"],
  run: async ({ db, repo, n, hidden, staff }) => (await db.all(db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id").leftJoin("claude_accounts as a", "a.id", "r.account_id")
    .select((eb) => runColumnsExpr(db, eb)).$narrowType<{ tools: number }>().where("i.repo", "=", repo).where("i.number", "=", n)
    .$if(filtered(hidden), (q) => q.where((eb) => hiddenExpr(db, eb, hidden)!)))).map((r) => runEvent(r, staff)),
};

const CHECK_NAMES: Record<string, string> = { fmt: "Format check", clippy: "Clippy", check: "Build check", test: "Tests" };
const outcomeWords = (o: string | null): string => (o === null ? "running" : /^0 findings?$/.test(o) ? "no findings" : /^exit \d+/.test(o) ? `failed (${o})` : o);

export const checkEvent = (c: { id: number; run_id: number | null; step: string; head: string; command: string; crate: string | null; test_name: string | null; task_id: number | null; outcome: string | null; started_at: string }): Ev => ({
  id: `check:${c.id}`, kind: "check", at: c.started_at, head: c.head, actor: step(c.step),
  summary: `${CHECK_NAMES[c.command] ?? humanize(c.command)}${c.crate ? ` on ${c.crate}` : ""}${c.test_name ? ` (${c.test_name})` : ""}: ${outcomeWords(c.outcome)}`,
  ref: { checkId: c.id, head: c.head, ...(c.run_id !== null ? { runId: c.run_id } : {}), ...(c.task_id !== null ? { taskId: c.task_id } : {}) },
});
export const taskEvent = (t: { id: number; job_id: number | null; step: string; head_sha: string; state: string; summary: string | null; queued_at: string }): Ev => ({
  id: `task:${t.id}`, kind: "check", at: t.queued_at, head: t.head_sha, actor: step(t.step),
  summary: `Build task ${t.state}${t.summary ? `: ${clip(t.summary, 100)}` : ""}`, ref: { taskId: t.id, head: t.head_sha, ...(t.job_id !== null ? { jobId: t.job_id } : {}) },
});
export const pushEvent = (p: { id: number; at: string; stage: string; action: string; to_oid: string; before_res: string; after_res: string | null; outcome: string | null }): Ev => ({
  id: `push:${p.id}`, kind: "check", at: p.at, head: p.to_oid, actor: step(p.stage),
  summary: `${GITHUB_ACTIONS[p.action] ?? humanize(p.action)} by AutoCraft: required checks ${p.before_res} → ${p.after_res ?? "pending"}${p.outcome ? `, ${p.outcome}` : ""}`, ref: { head: p.to_oid },
});
export const patchCheckEvent = (p: { id: number; kind: string; subject: string; round: number; verdict: string; model: string; reasons: string; created_at: string }): Ev => ({
  id: `patchcheck:${p.id}`, kind: "check", at: p.created_at, head: null, actor: model(p.model, "model"), summary: `Patch check (${p.kind}, round ${p.round}): ${p.verdict}`,
  ref: {}, detail: { subject: p.subject, reasons: p.reasons },
});

const checks: Source = {
  kinds: ["check"],
  async run({ db, repo, n }) {
    return [
      ...(await db.all(db.k.selectFrom("model_checks").select(["id", "run_id", "step", "head", "command", "crate", "test_name", "task_id", "outcome", "started_at"]).where("repo", "=", repo).where("number", "=", n))).map(checkEvent),
      ...(await db.all(db.k.selectFrom("build_tasks").select(["id", "job_id", "step", "head_sha", "state", "summary", "queued_at"]).where("repo", "=", repo).where("number", "=", n))).map(taskEvent),
      ...(await db.all(db.k.selectFrom("push_outcomes").select(["id", "at", "stage", "action", "to_oid", "before_res", "after_res", "outcome"]).where("repo", "=", repo).where("number", "=", n))).map(pushEvent),
      ...(await db.all(db.k.selectFrom("patch_checks").select(["id", "kind", "subject", "round", "verdict", "model", "reasons", "created_at"]).where("repo", "=", repo).where("number", "=", n))).map(patchCheckEvent),
    ];
  },
};

export type OpusRow = { head_oid: string; at: string; model: string | null; mode: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: string | null; fixes: string | null; claims?: string | null };
export const opusEvent = (r: OpusRow, key: string): Ev => ({
  id: `review:${key}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "opus"),
  summary: `Opus review: ${r.verdict ?? "no verdict"}${arr(r.fixes).length ? ` with ${plural(arr(r.fixes).length, "fix")}` : ""}${r.sure === 0 ? ", not sure" : ""}`, ref: { reviewId: key, head: r.head_oid },
  detail: { mode: r.mode, verdict: r.verdict, sure: r.sure === 1, reason: r.reason, fixes: arr(r.fixes), risks: arr<string>(r.risks), claims: arr(r.claims ?? null) },
});

export const premergeEvent = (r: { head_oid: string; at: string; model: string | null; findings: string | null; error: string | null; searched: string | null }): Ev => {
  const f = arr(r.findings);
  return {
    id: `review:premerge:${r.head_oid}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "premerge"),
    summary: r.error ? `Pre-merge review failed: ${clip(r.error, 100)}` : `Pre-merge review: ${count(f)}`,
    ref: { reviewId: `premerge:${r.head_oid}`, head: r.head_oid }, detail: { findings: f, searched: r.searched, error: r.error },
  };
};
export const postmergeEvent = (r: { merge_sha: string; at: string; model: string | null; findings: string | null; error: string | null }, staff: boolean): Ev => {
  const f = arr<Record<string, unknown>>(r.findings);
  return {
    id: `review:postmerge:${r.merge_sha}`, kind: "review", at: r.at, head: r.merge_sha, actor: model(r.model, "postmerge"),
    summary: r.error ? `Post-merge review failed: ${clip(r.error, 100)}` : `Post-merge review: ${count(f)}`,
    ref: { reviewId: `postmerge:${r.merge_sha}`, head: r.merge_sha },
    // Which stage missed a finding and why is for staff, as on the item page (postmergeOf).
    detail: { findings: staff ? f : f.map(({ missed_by: _by, missed_why: _why, ...rest }) => rest), error: r.error },
  };
};
export const verifyEvent = (v: { head_sha: string; kind: string; state: string; reason: string; summary: string | null; note: string | null; created_at: string; head_task_id: number | null }): Ev => ({
  id: `verify:${v.head_sha}`, kind: "review", at: v.created_at, head: v.head_sha, actor: step("verify"), summary: `Verification (${v.kind}): ${v.state}`,
  ref: { head: v.head_sha, ...(v.head_task_id !== null ? { taskId: v.head_task_id } : {}) }, detail: { reason: v.reason, summary: v.summary, note: v.note },
});

const reviews: Source = {
  kinds: ["review"],
  async run({ db, repo, n, staff }) {
    const out: Ev[] = [];
    const seen = new Set<string>();
    for (const r of await db.all(db.k.selectFrom("opus_review_history").select([kx.rowid("opus_review_history").as("rowid"), "head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "claims"]).where("repo", "=", repo).where("number", "=", n))) {
      seen.add(`${r.head_oid}|${r.at}`);
      out.push(opusEvent(r, `opus:${r.rowid}`));
    }
    // Reviews stored before the history table existed.
    for (const r of await db.all(db.k.selectFrom("opus_reviews").select(["head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "claims"]).where("repo", "=", repo).where("number", "=", n)))
      if (!seen.has(`${r.head_oid}|${r.at}`)) out.push(opusEvent(r, `opus-latest:${r.head_oid}`));
    for (const r of await db.all(db.k.selectFrom("premerge_reviews").select(["head_oid", "at", "model", "findings", "error", "searched"]).where("repo", "=", repo).where("number", "=", n))) out.push(premergeEvent(r));
    for (const r of await db.all(db.k.selectFrom("postmerge_reviews").select(["merge_sha", "at", "model", "findings", "error"]).where("repo", "=", repo).where("number", "=", n))) out.push(postmergeEvent(r, staff));
    for (const v of await db.all(db.k.selectFrom("verifications").select(["head_sha", "kind", "state", "reason", "summary", "note", "created_at", "head_task_id"]).where("repo", "=", repo).where("number", "=", n))) out.push(verifyEvent(v));
    return out;
  },
};

/** Decisions that name the item: its own, a duplicate group's, and a batch's (decision_items, filled from the `items` JSON). */
async function decisionIds({ db, repo, n, hidden }: Ctx): Promise<string[]> {
  const found = await db.all(db.k.selectFrom(
    db.k.selectFrom("decisions").select("id").where("repo", "=", repo).where("number", "=", n)
      .union(db.k.selectFrom("dupe_group_items").select("decision_id as id").where("repo", "=", repo).where("number", "=", n))
      .union(db.k.selectFrom("decision_items").select("decision_id as id").where("repo", "=", repo).where("number", "=", n)).as("k"))
    .leftJoin("decisions as d", "d.id", "k.id").select(["k.id", "d.id as known", "d.repo", "d.number", "d.items"]));
  // A decision that touches a repo hidden from the viewer does not exist for them (the decisions API answers 404).
  return found.filter((d) => d.known === null || !reposOf(d as unknown as Parameters<typeof reposOf>[0]).some((r) => isHiddenRepo(hidden, r))).map((d) => d.id).sort();
}

export type DecisionRow = { id: string; kind: string; question: string; asked_at: string; asked_by: string | null; answer: string | null; answered_at: string | null; answered_by: string | null; answer_note?: string | null };
export const decisionEvents = (d: DecisionRow): Ev[] => [
  { id: `decision:${d.id}:asked`, kind: "decision", at: d.asked_at, head: null, actor: step(d.asked_by || "decide"), summary: `Asked: ${clip(d.question, 100)}`, ref: { decisionId: d.id } },
  ...(d.answered_at ? [{ id: `decision:${d.id}:answered`, kind: "decision" as const, at: d.answered_at, head: null,
    ...(d.answer === "withdrawn" ? { actor: step(d.answered_by || "decide"), summary: `Question withdrawn${d.answer_note ? `: ${clip(d.answer_note, 100)}` : ""}` } : { actor: person(d.answered_by), summary: `Answered: ${d.answer ?? ""}` }), ref: { decisionId: d.id } }] : []),
];
export const feedbackEvent = (decisionId: string, c: { id: string; login: string; at: string; len: number }): Ev =>
  ({ id: `decision:${decisionId}:feedback:${c.id}`, kind: "decision", at: c.at, head: null, actor: person(c.login), summary: `Feedback on the question, ${c.len} characters`, ref: { decisionId } });

const decisions: Source = {
  kinds: ["decision"],
  async run(c) {
    const { db } = c;
    const out: Ev[] = [];
    const ids = await decisionIds(c);
    const byId = new Map((await db.all(db.k.selectFrom("decisions").select(["id", "kind", "question", "asked_at", "asked_by", "answer", "answered_at", "answered_by", "answer_note"]).where(kx.inList(db, "id", ids)))).map((d) => [d.id, d]));
    // In the (decision_id, at) index's order, as a read of one decision's comments walks it.
    const comments = new Map<string, { id: string; login: string; at: string; len: number }[]>();
    for (const f of await db.all(db.k.selectFrom("decision_comments").select((eb) => ["decision_id", "id", "login", "at", eb.fn<number>("length", ["body"]).as("len")])
      .where(kx.inList(db, "decision_id", ids)).orderBy("decision_id").orderBy("at").orderBy(kx.rowid("decision_comments"))))
      (comments.get(f.decision_id) ?? comments.set(f.decision_id, []).get(f.decision_id)!).push({ id: f.id, login: f.login, at: f.at, len: f.len });
    for (const id of ids) {
      const d = byId.get(id);
      if (!d) continue;
      out.push(...decisionEvents(d));
      for (const f of comments.get(d.id) ?? []) out.push(feedbackEvent(d.id, f));
    }
    return out;
  },
};

type FixRow = { rowid: number; head: string; to_head: string | null; state: string; reason: string | null; files: string | null; attempt: number; created_at: string; task_id?: number | null; kind?: string };
export const fixEvent = (f: FixRow, id: string, name: string, label: string): Ev => ({
  id: `${id}:${f.rowid}`, kind: "step", at: f.created_at, head: f.head, actor: step(name), summary: `${label}, try ${f.attempt}: ${f.state}${f.reason ? `, ${clip(f.reason, 100)}` : ""}`,
  ref: { head: f.head, ...(f.to_head ? { toHead: f.to_head } : {}), ...(f.task_id ? { taskId: f.task_id } : {}) }, detail: { to: f.to_head, reason: f.reason, files: arr<string>(f.files) },
});
export const fixupEvent = (f: FixRow): Ev => fixEvent(f, "fixup", "fixup", "Fix-up");
export const ciFixEvent = (f: FixRow): Ev => fixEvent(f, "cifix", "cifix", `CI fix (${f.kind})`);
export const conflictEvent = (f: FixRow): Ev => fixEvent(f, "conflict", "conflict", "Conflict merge");
export const mergeEvent = (m: { rowid: number; head_oid: string; at: string; path: string; method: string | null; outcome: string; reason: string | null }): Ev =>
  ({ id: `merge:${m.rowid}`, kind: "step", at: m.at, head: m.head_oid, actor: step("merge"), summary: `Merge attempt (${m.path}${m.method ? `, ${m.method}` : ""}): ${m.outcome}${m.reason ? `, ${clip(m.reason, 100)}` : ""}`, ref: { head: m.head_oid } });
const ACTION_NAMES: Record<string, string> = { "comment-close": "Comment and close" };
export const actionEvent = (a: { id: number; decision_id: string; kind: string; state: string; reason: string | null; created_at: string }): Ev =>
  ({ id: `action:${a.id}`, kind: "step", at: a.created_at, head: null, actor: step("act"), summary: `${ACTION_NAMES[a.kind] ?? humanize(a.kind)}: ${a.state}${a.reason ? `, ${clip(a.reason, 100)}` : ""}`, ref: { decisionId: a.decision_id } });

const steps: Source = {
  kinds: ["step"],
  async run({ db, repo, n }) {
    return [
      ...(await db.all(db.k.selectFrom("fixups").select([kx.rowid("fixups").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]).where("repo", "=", repo).where("number", "=", n))).map(fixupEvent),
      ...(await db.all(db.k.selectFrom("ci_fixes").select([kx.rowid("ci_fixes").as("rowid"), "head", "to_head", "kind", "state", "reason", "files", "attempt", "task_id", "created_at"]).where("repo", "=", repo).where("number", "=", n))).map(ciFixEvent),
      ...(await db.all(db.k.selectFrom("conflict_merges").select([kx.rowid("conflict_merges").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]).where("repo", "=", repo).where("number", "=", n))).map(conflictEvent),
      ...(await db.all(db.k.selectFrom("merges").select([kx.rowid("merges").as("rowid"), "head_oid", "at", "path", "method", "outcome", "reason"]).where("repo", "=", repo).where("number", "=", n))).map(mergeEvent),
      ...(await db.all(db.k.selectFrom("actions").select(["id", "decision_id", "kind", "state", "reason", "created_at"]).where("repo", "=", repo).where("number", "=", n))).map(actionEvent),
    ];
  },
};

export const turnEvent = (t: { id: number; kind: string; login: string; at: string; len: number; status: string | null }): Ev => ({
  id: `turn:${t.id}`, kind: "conversation", at: t.at, head: null, actor: t.kind === "opus" ? model("opus", "opus") : t.kind === "system" ? step("system") : person(t.login),
  summary: `Conversation ${t.kind} message, ${t.len} characters${t.status && t.status !== "answered" ? ` (${t.status})` : ""}`, ref: {},
});

const conversation: Source = {
  kinds: ["conversation"],
  run: async ({ db, repo, n }) => (await db.all(db.k.selectFrom("conversation_turns").select((eb) => ["id", "kind", "login", "at", eb.fn<number>("length", ["body"]).as("len"), "status"])
    .where("repo", "=", repo).where("number", "=", n))).map(turnEvent),
};

/** The audit actions a viewer may see as writes: everyone the GitHub writes, maintainers the dashboard actions that are not operator-only, operators all (null). */
export const writeActions = (staff: boolean, operator: boolean): string[] | null =>
  operator ? null : [...new Set([...(staff ? AUDIT_ACTIONS.filter((a) => !operatorOnly(a)) : []), ...Object.keys(GITHUB_ACTIONS)])];

/** One audit row as a trace event; the same wording and actor rules wherever writes are listed. */
export function writeEvent(a: { rowid: number; at: string; login: string; action: string; details: string | null }, staff: boolean): Ev {
  const { text, ...d } = obj(a.details);
  const gh = a.action in GITHUB_ACTIONS;
  const head = typeof d.head === "string" ? d.head : null;
  const bad = typeof d.error === "string" ? ` (failed: ${clip(d.error, 80)})` : "";
  const more = gh ? detailOf(a.action, { ...d, text }) : "";
  return {
    id: `audit:${a.rowid}`, kind: "write" as const, at: a.at, head, actor: !staff || (gh && typeof d.state === "string") ? step("AutoCraft") : person(a.login),
    summary: gh ? `${GITHUB_ACTIONS[a.action]}${more ? `: ${more}` : ""}${bad}` : humanize(a.action),
    ref: { auditRowid: a.rowid, ...(head ? { head } : {}) },
    detail: staff ? { action: a.action, by: a.login, ...d, ...(typeof text === "string" ? { textLength: text.length } : {}) } : { action: GITHUB_ACTIONS[a.action] ?? a.action, detail: more },
  };
}

/** The merge batch of a repo's integration branch, if there is one. */
export const batchIdOf = async (db: Db, repo: string, branch: string): Promise<number | undefined> =>
  (await db.get(db.k.selectFrom("main.merge_batches").select("id").where("repo", "=", repo).where("branch", "=", branch).orderBy("id").limit(1)))?.id;

/**
 * The audit rows of the item. Everyone sees the GitHub writes with the activity page's allow-listed detail; maintainers also see the
 * dashboard actions that are not operator-only (as the audit log does); operators see every row. The posted text stays out: only its length shows.
 */
const writes: Source = {
  kinds: ["write"],
  async run({ db, ref, repo, staff, operator }) {
    const allowed = writeActions(staff, operator);
    return await mapSeq(await db.all(db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "login", "action", "details"]).where("target", "=", ref)
      .$if(!!allowed, (q) => q.where(kx.inList(db, "action", allowed!)))), async (a) => {
        const e = writeEvent(a, staff);
        const branch = typeof obj(a.details).batch === "string" ? (obj(a.details).batch as string) : null;
        const id = branch ? await batchIdOf(db, repo, branch) : undefined;
        return id === undefined ? e : { ...e, ref: { ...e.ref, batchId: id } };
      });
  },
};

const SOURCES: Source[] = [github, stages, plans, jobs, modelCalls, checks, reviews, decisions, steps, conversation, writes];

/** Heads are known for pushes, reviews and checks only; a model call, job or decision between two of them belongs to the head current at its time. */
export function carryHeads(events: Ev[]): void {
  const asc = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  let current: string | null = null;
  for (const e of asc) {
    if (e.head) current = e.head;
    else if (current && (e.kind === "model-call" || e.kind === "job" || e.kind === "decision" || e.kind === "conversation")) e.head = current;
  }
}

const REVIEW_PROMPTS: [prefix: string, prompt: string][] = [["review:opus", "review.opus"], ["review:premerge:", "premerge.opus"], ["review:postmerge:", "postmerge.opus"]];

/**
 * A review is made by model calls (more than one when its reply took a fix turn or a repeat). Each review gets the calls of its
 * prompt that started after the previous review of the same kind and before it, in `ref.runIds` (and the first in `ref.runId`).
 * Returns the ids of the calls taken, so the timeline lists them once, inside the review.
 */
export function linkReviewCalls(events: Ev[]): Set<number> {
  const taken = new Set<number>();
  const calls = events.filter((e) => e.kind === "model-call" && e.ref.runId !== undefined && e.call?.promptId);
  for (const [prefix, prompt] of REVIEW_PROMPTS) {
    const reviews = events.filter((e) => e.kind === "review" && e.id.startsWith(prefix)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    reviews.forEach((r, i) => {
      const from = i > 0 ? reviews[i - 1]!.at : "";
      const mine = calls.filter((c) => c.call!.promptId!.startsWith(prompt) && c.at > from && c.at <= r.at).sort((a, b) => (a.at < b.at ? -1 : 1));
      if (mine.length === 0) return;
      const ids = mine.map((c) => c.ref.runId!);
      r.ref = { ...r.ref, runId: ids[0], runIds: ids };
      const costs = mine.map((c) => c.call!.costUsd).filter((v): v is number => v !== null);
      r.costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
      for (const id of ids) taken.add(id);
    });
  }
  return taken;
}

/** Every source runs whatever the filter, so a filtered event still gets the head its neighbours carry. */
export const VEILED_KINDS: TraceKind[] = ["model-call", "check", "review", "decision", "conversation"];

/** A viewer's copy of a step, job or plan event on a quiet pull request: the kind, time and outcome state stay; free text goes. */
export function veilEvent(e: Ev): Ev {
  if (!["step", "job", "plan"].includes(e.kind)) return e;
  let summary = e.summary;
  const colon = summary.indexOf(": ");
  if (e.kind === "step" && colon >= 0) {
    const comma = summary.indexOf(", ", colon + 2);
    summary = comma >= 0 ? summary.slice(0, comma) : summary;
  } else if (e.id.startsWith("plan:")) summary = summary.replace(/, waiting for .*$/, "");
  else if (colon >= 0) summary = summary.slice(0, colon);
  const detail = e.detail ? { ...e.detail } as Record<string, unknown> : undefined;
  if (detail) for (const k of ["reason", "outcome", "error", "wait", "note"]) if (k in detail) detail[k] = null;
  if (detail && "reasons" in detail) detail.reasons = [];
  return { ...e, summary, ...(detail ? { detail } : {}) };
}

export async function gather(c: Ctx, kinds: Set<TraceKind> | null): Promise<Ev[]> {
  const all: Ev[] = [];
  // The sources read independently, so they run together; events keep the SOURCES order.
  for (const e of (await Promise.all(SOURCES.map((s) => s.run(c)))).flat()) {
    if (c.veiled && VEILED_KINDS.includes(e.kind)) continue;
    const at = iso(e.at);
    if (at) all.push({ ...(c.veiled ? veilEvent(e) : e), at, ...(c.staff ? {} : { summary: plainSummary(c.veiled ? veilEvent(e) : e) }) });
  }
  carryHeads(all);
  const taken = !kinds || kinds.has("review") ? linkReviewCalls(all) : new Set<number>();
  return (kinds ? all.filter((e) => kinds.has(e.kind)) : all).filter((e) => !(e.kind === "model-call" && taken.has(e.ref.runId ?? -1))).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

/** The header of a quiet pull request for viewers: the state only, without the planner's reasons and notes or the questions asked about it. */
function veilHeader(h: ItemTraceHeader): ItemTraceHeader {
  return {
    ...h,
    now: { ...h.now, text: h.now.state ?? "Not planned yet", waitsOn: null, reasons: [], note: null },
    who: { ...h.who, openDecisions: h.who.openDecisions.map((d) => ({ ...d, question: "" })) },
  };
}

async function headerOf(c: Ctx): Promise<ItemTraceHeader> {
  const { db, repo, n, box, hidden } = c;
  const [plan, it, hold] = await Promise.all([
    db.get(db.k.selectFrom("item_plans").select(["head", "state", "actions", "wait", "reasons", "note", "view", "planned_at"]).where("repo", "=", repo).where("number", "=", n)),
    db.get(db.k.selectFrom("items").select("assignees").where("repo", "=", repo).where("number", "=", n)),
    db.get(db.k.selectFrom("merge_holds").select(["held_by", "held_at"]).where("repo", "=", repo).where("number", "=", n)),
  ]);
  const view = obj(plan?.view);
  const acts = arr<{ kind?: unknown; head?: unknown }>(plan?.actions).filter((a) => a && typeof a.kind === "string");
  const assignees = arr(it?.assignees).filter((x): x is string => typeof x === "string");
  // The planner's texts as this reader may see them: no item of a hidden repo, and for viewers no note and plain reasons.
  const wait = waitFor(c, plan?.wait ?? null);
  const note = c.staff ? blankIfHidden(plan?.note ?? null, hidden) || null : null;
  const next = typeof view.next === "string" ? blankIfHidden(view.next, hidden) || null : null;
  return {
    now: {
      state: plan?.state ?? null, head: plan?.head ?? null, plannedAt: plan?.planned_at ?? null,
      text: plan ? (next ?? wait ?? note ?? plan.state) : "Not planned yet", waitsOn: wait, reasons: reasonsFor(c, arr<string>(plan?.reasons)), note,
    },
    next: acts.map((a) => ({ kind: a.kind as string, head: typeof a.head === "string" ? a.head : null })),
    who: {
      assignees, autocraftAssigned: box !== "" && assignees.includes(box),
      openDecisions: await (async (ids) => {
        const open = new Map((await db.all(db.k.selectFrom("decisions").select(["id", "kind", "question"]).where(kx.inList(db, "id", ids)).where("answer", "is", null))).map((d) => [d.id, d]));
        return ids.flatMap((id) => { const d = open.get(id); return d ? [{ id: d.id, kind: d.kind, question: clip(d.question, 140) }] : []; });
      })(await decisionIds({ db, repo, n, hidden } as Ctx)),
      holds: hold ? [{ by: hold.held_by, at: hold.held_at }] : [],
    },
  };
}

/**
 * A cheap fingerprint of what the item's sources hold: counts, newest keys and the states that change in place, each read through an
 * index on (repo, number). Equal fingerprints mean the answer would not change, so `since` is answered without gathering anything.
 * Each query selects its values in the order the fingerprint lists them; the states of several rows join in key order.
 */
const fingerprintQueries = (db: Db, repo: string, n: number, ref: string) => {
  const flag = (eb: kx.Eb, col: string) => eb.fn.sum<number | null>(eb.case().when(col, "is not", null).then(eb.lit(1)).else(eb.lit(0)).end());
  return [
    db.k.selectFrom("items").select(["updated_at", "head_oid", "state", "assignees", "closed_at", "merged_at"]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("item_plans").select(["planned_at", "state", "head"]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("comments").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("created_at").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("stages").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>(kx.rowid("stages")).as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("plan_history").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("job_items as i").innerJoin("jobs as j", "j.id", "i.job_id").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("i.id").as("newest"), kx.groupConcat(db, "j.state", ",", "i.id").as("states")])
      .where("i.repo", "=", repo).where("i.number", "=", n),
    db.k.selectFrom("agent_run_items as i").innerJoin("agent_runs as r", "r.id", "i.run_id")
      .select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("i.run_id").as("newest"), flag(eb, "r.ended_at").as("ended"), flag(eb, "r.cost_usd").as("costed")])
      .where("i.repo", "=", repo).where("i.number", "=", n),
    db.k.selectFrom("model_checks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest"), flag(eb, "outcome").as("done")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("build_tasks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest"), flag(eb, "ended_at").as("ended"), kx.groupConcat(db, "state", ",", "id").as("states")])
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("push_outcomes").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest"), flag(eb, "outcome").as("done")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("patch_checks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("opus_review_history").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>(kx.rowid("opus_review_history")).as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("opus_reviews").select((eb) => [eb.fn.max<string | null>("at").as("newest"), eb.fn.countAll<number>().as("n")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("premerge_reviews").select((eb) => [eb.fn.max<string | null>("at").as("newest"), eb.fn.countAll<number>().as("n"), eb.fn.sum<number | null>("tries").as("tries")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("postmerge_reviews").select((eb) => [eb.fn.max<string | null>("at").as("newest"), eb.fn.countAll<number>().as("n"), eb.fn.sum<number | null>("tries").as("tries")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("verifications").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>(eb.fn.coalesce("finished_at", "created_at")).as("newest"), kx.groupConcat(db, "state", ",", kx.rowid("verifications")).as("states")])
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("fixups").select((eb) => [eb.fn.countAll<number>().as("n"), kx.groupConcat(db, eb("state", "||", eb.fn.coalesce("to_head", eb.val(""))), ",", kx.rowid("fixups")).as("states")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("ci_fixes").select((eb) => [eb.fn.countAll<number>().as("n"), kx.groupConcat(db, eb("state", "||", eb.fn.coalesce("to_head", eb.val(""))), ",", kx.rowid("ci_fixes")).as("states")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("conflict_merges").select((eb) => [eb.fn.countAll<number>().as("n"), kx.groupConcat(db, eb("state", "||", eb.fn.coalesce("to_head", eb.val(""))), ",", kx.rowid("conflict_merges")).as("states")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("merges").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("at").as("newest")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("actions").select((eb) => [eb.fn.countAll<number>().as("n"), kx.groupConcat(db, "state", ",", "id").as("states")]).where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("conversation_turns").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest"), kx.groupConcat(db, eb.fn.coalesce("status", eb.val("")), ",", "id").as("states")])
      .where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("activity_sync").select("read_at").where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("merge_holds").select("held_at").where("repo", "=", repo).where("number", "=", n),
    db.k.selectFrom("audit").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>(kx.rowid("audit")).as("newest"), eb.fn.sum<number | null>(eb.fn("length", [eb.fn.coalesce("details", eb.val(""))])).as("length")]).where("target", "=", ref),
  ];
};

export const rowValuesOf = kx.rowValues;

export async function fingerprint(c: Ctx, qkey: string): Promise<string> {
  const { db, repo, n, ref } = c;
  const parts: unknown[] = [qkey, c.staff, c.operator, c.hidden];
  const [values, ids] = await Promise.all([rowValuesOf(db, fingerprintQueries(db, repo, n, ref)), decisionIds(c)]);
  parts.push(...values);
  const byId = new Map((await db.all(db.k.selectFrom("decisions as d").select((eb) => ["d.id", "d.answer", "d.answered_at", "d.applied_at", "d.asked_at",
    eb.selectFrom("decision_comments as x").select((e) => e.fn.countAll<number>().as("n")).whereRef("x.decision_id", "=", "d.id").as("comments")])
    .where(kx.inList(db, "d.id", ids)))).map(({ id, ...r }) => [id, [id, ...Object.values(r)]]));
  for (const id of ids) parts.push(byId.get(id) ?? []);
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export async function context(db: Db, req: Req): Promise<Ctx> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  // The visibility check decides first: an item of a hidden repo is a 404 for its repo whether or not the mirror has it.
  // The rest reads alongside, and counts only once both checks passed.
  const staff = canSeeInternals(req);
  const rest = Promise.all([setting(db, "pipeline_login"), ownLogins(db, repo), !staff && isQuiet(db, repo, n), hiddenRepos(db, req)]);
  rest.catch(() => {});
  const [, found] = await Promise.all([needVisible(db, req, repo), db.get(db.k.selectFrom("items").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n))]);
  if (!found) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const [box, own, veiled, hidden] = await rest;
  return { db, repo, n, ref: `${repo}#${n}`, own, box: box ?? "", staff, veiled, operator: req.user.role === "operator", hidden };
}

/**
 * What a viewer reads of an event's detail: the fields the item page and timeline give them. Anything not listed (model reasons, fixes,
 * risks, claims, verification and fix-up text, job errors) is staff only, and so is every kind this table does not know.
 */
const VIEWER_FIELDS: [match: (e: Ev) => boolean, fields: string[]][] = [
  [(e) => e.id.startsWith("plan:"), ["from", "to"]],
  [(e) => e.kind === "job", ["step", "state"]],
  [(e) => e.id.startsWith("patchcheck:"), ["subject"]],
  [(e) => e.id.startsWith("review:opus") || e.id.startsWith("review:opus-latest:"), ["mode", "verdict", "sure"]],
  [(e) => e.id.startsWith("review:premerge:"), ["findings", "searched", "error"]],
  [(e) => e.id.startsWith("review:postmerge:"), ["findings", "error"]],
  [(e) => e.kind === "step", ["to"]],
  [(e) => e.kind === "write", ["action", "detail"]],
];
const viewerFields = (e: Ev): Record<string, unknown> => {
  const allowed = VIEWER_FIELDS.find(([match]) => match(e))?.[1] ?? [];
  return Object.fromEntries(Object.entries(e.detail ?? {}).filter(([k]) => allowed.includes(k)));
};

/** A viewer's summary of an event whose wording ends in model or log text: the part before that text. */
export function plainSummary(e: Ev): string {
  if (e.id.startsWith("plan:")) return e.summary.replace(/, waiting for .*$/, "");
  const colon = e.summary.indexOf(": ");
  if (colon < 0) return e.summary;
  // The note of a stage and the outcome of a job carry review, verification and failure text; a job keeps its leading state word.
  if (e.id.startsWith("stage:") || e.summary.startsWith("Question withdrawn")) return e.summary.slice(0, colon);
  if (e.kind === "job") {
    const word = /^[A-Za-z-]+/.exec(e.summary.slice(colon + 2))?.[0];
    return word ? `${e.summary.slice(0, colon)}: ${word}` : e.summary.slice(0, colon);
  }
  if (e.kind === "step") {
    const comma = e.summary.indexOf(", ", colon + 2);
    return comma >= 0 ? e.summary.slice(0, comma) : e.summary;
  }
  if (e.kind === "model-call") return `${e.summary.slice(0, colon)}: ${e.call?.state === "running" ? "running" : e.call?.state === "failed" ? "failed" : "done"}`;
  if (e.id.startsWith("task:") || e.id.startsWith("review:premerge:") || e.id.startsWith("review:postmerge:")) return e.summary.slice(0, colon);
  return e.summary;
}

const strip = ({ detail: _d, ...e }: Ev): TraceEvent => e;

export async function trace(db: Db, req: Req): Promise<ItemTrace | { unchanged: true; stamp: string }> {
  const c = await context(db, req);
  const q = (k: string) => req.query.get(k) || undefined;
  const limitRaw = q("limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? TRACE_PAGE_DEFAULT), 1), TRACE_PAGE_MAX);
  let kinds: Set<TraceKind> | null = null;
  const kq = q("kinds");
  if (kq) {
    const list = kq.split(",");
    if (list.some((k) => !KINDS.includes(k as TraceKind))) throw new HttpError(400, `kinds are ${KINDS.join(", ")}`);
    kinds = new Set(list as TraceKind[]);
  }
  const only = q("autocraftOnly") === "1" || q("autocraftOnly") === "true";
  const cursor = q("cursor");
  let after: { at: string; id: string } | null = null;
  if (cursor) {
    const i = cursor.indexOf("|");
    const at = i < 1 ? null : iso(cursor.slice(0, i));
    if (!at) throw new HttpError(400, "bad cursor");
    after = { at, id: cursor.slice(i + 1) };
  }
  const stamp = await fingerprint(c, JSON.stringify([kq ?? "", only, limit]));
  // `since` applies to the first page; a later page is always read.
  if (!cursor && q("since") === stamp) return { unchanged: true, stamp };
  let events = await gather(c, kinds);
  if (only) events = events.filter((e) => e.actor.type !== "person");
  const rest = after ? events.filter((e) => e.at > after.at || (e.at === after.at && e.id > after.id)) : events;
  const page = rest.slice(0, limit).map(strip);
  const last = page[page.length - 1];
  return { header: c.veiled ? veilHeader(await headerOf(c)) : await headerOf(c), events: page, nextCursor: rest.length > limit && last ? `${last.at}|${last.id}` : null, stamp };
}

/** The fields an event keeps back from the list, for the kinds whose detail has no endpoint of its own (runs, build tasks and decisions have theirs). */
export async function traceDetail(db: Db, req: Req): Promise<ItemTraceDetail> {
  const c = await context(db, req);
  const e = (await gather(c, null)).find((x) => x.id === (req.query.get("id") ?? ""));
  if (!e) throw new HttpError(404, "no such event");
  return { id: e.id, kind: e.kind, at: e.at, summary: e.summary, fields: c.staff ? e.detail ?? {} : viewerFields(e) };
}

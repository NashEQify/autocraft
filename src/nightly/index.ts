// Nightly checks per repo (build feature "nightly"): once a day a repo's selected checks run as sandbox tasks at the
// default branch head, below all PR work. A later run of the step reads the finished tasks (pass or fail from the exit
// codes, never from a model), stores one result per check, parses benchmark lines, and, for a check that fails two
// nights running, asks an operator whether to open an issue. Nothing is read, written or queued while the switch is off.
import { readFileSync } from "node:fs";
import type { BuildTask } from "../../web/src/api/types.ts";
import { absolute } from "../build/artifacts.ts";
import { listEnvs } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { createTask, getTask, MAX_QUEUED, TERMINAL } from "../build/tasks.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guardRepo } from "../core/guard.ts";
import { actionable, ask, getDecision } from "../decisions.ts";
import { createIssue, IssueError } from "../github/write.ts";
import { exec } from "../fixup/git.ts";
import { mainCiRepos } from "../mainci/index.ts";
import { cleanLine } from "../review/post-template.ts";
import { scrub } from "../runner/scrub.ts";
import { outcomeOf } from "../verify/results.ts";
import { checkOf, NIGHTLY_CHECKS, type CheckOpts, type NightlyCheck } from "./checks.ts";
import { filterSeq, mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { cols, excluded } from "../db/kx.ts";

export { NIGHTLY_CHECKS, checkOf } from "./checks.ts";
export type { NightlyCheck, CheckOpts } from "./checks.ts";

export const ACTOR = "nightly";
/** Nightly tasks wait behind PR verification (0) and the warm build (-10). */
export const NIGHTLY_PRIORITY = -20;
/** The once-a-day schedule: a repo with a run started within this long ago is not queued again. */
const DAY_MS = 24 * 3600_000;
export const NIGHTLY_EVERY_MS = DAY_MS;
/** A run whose tasks never finished (no environment claims them) blocks the next night's run for this long, so tasks do not pile up. */
export const STALE_RUN_MS = 3 * DAY_MS;
export const BENCH_KEEP_MS = 180 * 24 * 3600_000;
/** A bench is judged against its last 7 nights, once at least this many are known. */
export const BENCH_WINDOW = 7;
export const BENCH_MIN_HISTORY = 3;
export const BENCH_WARN_RATIO = 1.1;
export const OPEN_ISSUE = "open-issue";
export const NOT_NOW = "not-now";
/** Failing nights in a row before an operator is asked. */
export const STREAK_TO_ASK = 2;

export type ResultState = "queued" | "pass" | "fail" | "error" | "skipped" | "warn";
export type NightlyResult = { runId: number; checkId: string; taskId: number | null; state: ResultState; summary: string | null; issueNumber: number | null; decisionId: string | null; finishedAt: string | null };
export type NightlyRun = { id: number; repo: string; sha: string; startedAt: string; state: "running" | "done" };
export type NightlySelection = { repo: string; checkId: string; enabled: boolean; crates: string[]; targets: string[] };
export type BenchPoint = { repo: string; bench: string; sha: string; at: string; value: number; unit: string };

export type NightlyDeps = {
  now: () => Date;
  /** Toolchain names some enabled, online build environment reports. */
  toolchains: (db: Db) => Promise<Set<string>>;
  /** The text of a finished task's artifact, or null. */
  readArtifact: (db: Db, taskId: number, name: string) => Promise<string | null>;
  /** Opens the issue the operator asked for; throws IssueError. The default checks the repo's comment approval first. */
  openIssue: (db: Db, o: { repo: string; title: string; body: string; decisionId: string; by: By }) => Promise<{ number: number; url: string }>;
};

export type NightlySummary = { repo: string; queued: number; skipped: number; collected: number; asked: number; issues: number; note: string | null };

// ---- selection ----------------------------------------------------------------

const paramsOf = (s: string | null): { crates: string[]; targets: string[] } => {
  try {
    const o = JSON.parse(s ?? "{}") as { crates?: unknown; targets?: unknown };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { crates: list(o.crates), targets: list(o.targets) };
  } catch { return { crates: [], targets: [] }; }
};

/** The repo's rows for checks the catalogue knows, in catalogue order. */
export async function selectionOf(db: Db, repo: string): Promise<NightlySelection[]> {
  const rows = await db.all(db.k.selectFrom("nightly_selection").select(cols("nightly_selection")).where("repo", "=", repo));
  return NIGHTLY_CHECKS.flatMap((c) => {
    const r = rows.find((x) => x.check_id === c.id);
    return r ? [{ repo, checkId: c.id, enabled: r.enabled === 1, ...paramsOf(r.params) }] : [];
  });
}

/** Sets one check on or off for a repo, keeping its crates and targets unless new ones are given. */
export async function setSelection(db: Db, repo: string, checkId: string, enabled: boolean, o: { crates?: string[]; targets?: string[] } = {}): Promise<void> {
  if (!checkOf(checkId)) throw new Error(`unknown nightly check ${checkId}`);
  const old = (await selectionOf(db, repo)).find((s) => s.checkId === checkId);
  const params = JSON.stringify({ crates: o.crates ?? old?.crates ?? [], targets: o.targets ?? old?.targets ?? [] });
  await db.run(db.k.insertInto("nightly_selection").values({ repo, check_id: checkId, enabled: enabled ? 1 : 0, params })
    .onConflict((oc) => oc.columns(["repo", "check_id"]).doUpdateSet(excluded(["enabled", "params"]))));
}

const enabledChecks = async (db: Db, repo: string): Promise<{ check: NightlyCheck; opts: CheckOpts }[]> =>
  (await selectionOf(db, repo)).filter((s) => s.enabled).map((s) => ({ check: checkOf(s.checkId)!, opts: { crates: s.crates, targets: s.targets } }));

// ---- schedule -----------------------------------------------------------------

/** The default branch head the main CI poll last read for a tracked repo, or null. */
const headOf = async (db: Db, repo: string): Promise<string | null> => (await mainCiRepos(db)).find((r) => r.repo === repo)?.headSha ?? null;

/** A run started since `since`, or one still running that started since `staleSince`. */
const recentRun = async (db: Db, repo: string, since: string, staleSince: string): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("nightly_runs").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo)
    .where((eb) => eb.or([eb("started_at", ">", since), eb.and([eb("state", "=", "running"), eb("started_at", ">", staleSince)])])).limit(1));

const nightlyDecision = (repo: string, id: string): boolean => id.startsWith(`${repo}:nightly:`);

/**
 * Whether a run of the step has work for the repo: an answered issue decision, a result whose task ended, or (the
 * once-a-day schedule, in data, not a timer) a selected check, a known head and no run started in the last 24 hours.
 */
export async function nightlyDue(db: Db, repo: string, nowMs: number = Date.now()): Promise<boolean> {
  if (!await featureOn(db, "nightly", repo)) return false;
  if ((await actionable(db)).some((a) => a.kind === "other" && nightlyDecision(repo, a.id))) return true;
  if (await db.get(db.k.selectFrom("nightly_results as r").innerJoin("nightly_runs as u", "u.id", "r.run_id").innerJoin("build_tasks as t", "t.id", "r.task_id")
    .select((eb) => eb.lit(1).as("one")).where("u.repo", "=", repo).where("r.state", "=", "queued").where("t.state", "in", TERMINAL).limit(1))) return true;
  if (!(await enabledChecks(db, repo)).length) return false;
  const since = new Date(nowMs - NIGHTLY_EVERY_MS).toISOString();
  if (await recentRun(db, repo, since, new Date(nowMs - STALE_RUN_MS).toISOString())) return false;
  return await headOf(db, repo) !== null;
}

/** The lane's candidates: tracked repos with the work above, sorted. */
export const nightlyRepos = async (db: Db, tracked: string[], nowMs: number = Date.now()): Promise<string[]> =>
  (await filterSeq(tracked, async (r) => await nightlyDue(db, r, nowMs))).sort();

// ---- reading ------------------------------------------------------------------

type ResRow = { run_id: number; check_id: string; task_id: number | null; state: ResultState; summary: string | null; issue_number: number | null; decision_id: string | null; finished_at: string | null };
const resultOf = (r: ResRow): NightlyResult => ({ runId: r.run_id, checkId: r.check_id, taskId: r.task_id, state: r.state, summary: r.summary, issueNumber: r.issue_number, decisionId: r.decision_id, finishedAt: r.finished_at });

/** Newest runs of a repo with their results; for the Nightly page. */
export async function recentRuns(db: Db, repo: string, limit = 14): Promise<(NightlyRun & { results: NightlyResult[] })[]> {
  const runs = await db.all(db.k.selectFrom("nightly_runs").select(cols("nightly_runs")).$narrowType<{ state: "running" | "done" }>()
    .where("repo", "=", repo).orderBy("id", "desc").limit(limit));
  return await mapSeq(runs, async (u) => ({
    id: u.id, repo: u.repo, sha: u.sha, startedAt: u.started_at, state: u.state,
    results: (await db.all(db.k.selectFrom("nightly_results").select(cols("nightly_results")).$narrowType<{ state: ResultState }>()
      .where("run_id", "=", u.id).orderBy("check_id"))).map(resultOf),
  }));
}

/** A bench's points, oldest first. */
export async function benchSeries(db: Db, repo: string, bench: string): Promise<BenchPoint[]> {
  return await db.all(db.k.selectFrom("nightly_bench").select(cols("nightly_bench")).where("repo", "=", repo).where("bench", "=", bench).orderBy("at").orderBy("sha"));
}

export function defaultDeps(): NightlyDeps {
  return {
    now: () => new Date(),
    toolchains: async (db) => new Set((await listEnvs(db)).filter((e) => e.enabled && e.online).flatMap((e) => e.capabilities?.toolchains ?? [])),
    readArtifact: async (db, taskId, name) => {
      const row = await db.get(db.k.selectFrom("build_artifacts").select("file").where("task_id", "=", taskId).where("name", "=", name));
      const path = row ? absolute(row.file) : null;
      if (!path) return null;
      try { return readFileSync(path, "utf8"); } catch { return null; }
    },
    openIssue: async (db, o) => {
      const g = await guardRepo(db, o.repo, "comment", o.by, o.decisionId);
      if ("refused" in g) throw new IssueError(g.refused, true);
      return createIssue({ db, login: ACTOR }, g, exec, { repo: o.repo, target: `${o.repo}:nightly`, title: o.title, body: o.body }, { by: "operator", model: "haiku" }, { decision: o.decisionId });
    },
  };
}

// ---- benchmarks ---------------------------------------------------------------

/** The lines of `cargo bench -- --output-format bencher`: `test name ... bench:   1,234 ns/iter (+/- 56)`. */
export function parseBench(text: string): { bench: string; value: number; unit: string }[] {
  const out: { bench: string; value: number; unit: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^test\s+(\S+)\s+\.\.\.\s+bench:\s+([\d,]+(?:\.\d+)?)\s+(\S+)/.exec(line);
    if (m) out.push({ bench: m[1]!.slice(0, 200), value: Number(m[2]!.replace(/,/g, "")), unit: m[3]!.slice(0, 20) });
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Stores the points and returns the benches more than 10% above the median of their last 7 earlier nights. */
async function storeBench(db: Db, repo: string, sha: string, at: string, points: { bench: string; value: number; unit: string }[]): Promise<{ bench: string; pct: number }[]> {
  const slow: { bench: string; pct: number }[] = [];
  for (const p of points) {
    const prior = (await db.all(db.k.selectFrom("nightly_bench").select("value").where("repo", "=", repo).where("bench", "=", p.bench)
      .where("sha", "<>", sha).where("at", "<", at).orderBy("at", "desc").limit(BENCH_WINDOW))).map((r) => r.value);
    if (prior.length >= BENCH_MIN_HISTORY) {
      const m = median(prior);
      if (m > 0 && p.value > m * BENCH_WARN_RATIO) slow.push({ bench: p.bench, pct: Math.round((p.value / m - 1) * 100) });
    }
    await db.run(db.k.insertInto("nightly_bench").values({ repo, bench: p.bench, sha, at, value: p.value, unit: p.unit })
      .onConflict((oc) => oc.columns(["repo", "bench", "sha"]).doUpdateSet(excluded(["at", "value", "unit"]))));
  }
  return slow;
}

/** Drops benchmark points older than BENCH_KEEP_MS. */
export async function pruneBench(db: Db, nowMs: number = Date.now()): Promise<number> {
  return (await db.run(db.k.deleteFrom("nightly_bench").where("at", "<", new Date(nowMs - BENCH_KEEP_MS).toISOString()))).changes;
}

// ---- collecting ---------------------------------------------------------------

const one = (s: string, n = 200): string => scrub(s).replace(/\s+/g, " ").trim().slice(0, n);

/** Advisory ids only: the audit's text never reaches an issue. */
export function advisoryIds(text: string | null): string[] {
  return [...new Set(text?.match(/RUSTSEC-\d{4}-\d{4}/g) ?? [])].slice(0, 20);
}

async function judge(db: Db, c: NightlyCheck, t: BuildTask, run: NightlyRun, at: string, deps: NightlyDeps): Promise<{ state: ResultState; summary: string | null }> {
  const o = outcomeOf(t);
  if (o.kind === "error") return { state: "error", summary: one(o.reason) };
  if (o.kind === "fail") {
    const why = o.timedOut ? "timed out" : `exit ${o.exitCode ?? "none"}`;
    if (c.kind === "audit") {
      const ids = advisoryIds(c.artifact ? await deps.readArtifact(db, t.id, c.artifact) : null);
      return { state: "fail", summary: ids.length ? `advisories: ${ids.join(", ")}` : `${o.step} failed (${why})` };
    }
    return { state: "fail", summary: `${o.step} failed (${why})` };
  }
  if (c.kind === "bench") {
    const text = c.artifact ? await deps.readArtifact(db, t.id, c.artifact) : null;
    const points = text ? parseBench(text) : [];
    if (!points.length) return { state: "error", summary: "no benchmark lines in the output" };
    const slow = await storeBench(db, run.repo, run.sha, at, points);
    if (slow.length) return { state: "warn", summary: one(`slower than the 7-night median: ${slow.slice(0, 5).map((s) => `${s.bench} +${s.pct}%`).join(", ")}${slow.length > 5 ? `, ${slow.length - 5} more` : ""}`, 300) };
  }
  return { state: "pass", summary: null };
}

/** The earlier results of one check, newest first, from runs before `runId`. */
const history = async (db: Db, repo: string, checkId: string, runId: number): Promise<ResRow[]> =>
  await db.all(db.k.selectFrom("nightly_results as r").innerJoin("nightly_runs as u", "u.id", "r.run_id").select(cols("nightly_results", "r")).$narrowType<{ state: ResultState }>()
    .where("u.repo", "=", repo).where("r.check_id", "=", checkId).where("r.run_id", "<", runId).orderBy("r.run_id", "desc"));

const decisionIdOf = (repo: string, checkId: string, startRun: number): string => `${repo}:nightly:${checkId}@${startRun}`;

/** Issue text: fixed layout; the summary is scrubbed and, for an audit, only advisory ids. */
export function nightlyIssueBody(c: NightlyCheck, sha: string, summary: string | null): string {
  return `The nightly check "${cleanLine(c.label, 80)}" failed on the default branch at ${sha.slice(0, 8)} on two nights in a row.${summary ? `\n\n${cleanLine(summary, 300)}` : ""}`;
}
const issueTitle = (c: NightlyCheck): string => `Nightly check fails: ${cleanLine(c.label, 80)}`;

/**
 * After a failure: the failing streak is the consecutive failed nights before this one (a skipped or errored night says
 * nothing; a pass or warn ends it). A streak of two asks one decision, keyed by the streak's first run, so a repeat
 * failure of an issue-opened streak asks nothing; the next streak after a green night asks again.
 */
async function afterFailure(db: Db, c: NightlyCheck, run: NightlyRun, summary: string | null, at: string, s: NightlySummary): Promise<void> {
  if (c.experimental) return;
  let start = run.id, count = 1;
  for (const h of await history(db, run.repo, c.id, run.id)) {
    if (h.state === "error" || h.state === "skipped" || h.state === "queued") continue;
    if (h.state !== "fail") break;
    start = h.run_id; count++;
  }
  const id = decisionIdOf(run.repo, c.id, start);
  const known = await getDecision(db, id);
  if (count < STREAK_TO_ASK && !known) return;
  if (!known) {
    await ask(db, [{
      id, kind: "other", repo: run.repo, number: 0,
      question: `Open an issue for the nightly check "${cleanLine(c.label, 80)}" on ${run.repo}'s default branch?`,
      context: `The check failed ${count} nights in a row. AutoCraft can open one issue with the check name and the failure; it opens no second issue until the check has passed again.`,
      facts: [`check: ${c.id}`, `head: ${run.sha.slice(0, 8)}`, ...(summary ? [`failure: ${cleanLine(summary, 300)}`] : [])],
      options: [
        { key: OPEN_ISSUE, label: "Open issue", hint: "AutoCraft opens one issue on the repo with the check and the failure." },
        { key: NOT_NOW, label: "Not now", hint: "Nothing is posted." },
      ],
      recommended: OPEN_ISSUE, recommended_reason: "A failure that repeats is not a flake.",
      public_text: nightlyIssueBody(c, run.sha, summary), asked_by: ACTOR, asked_at: at,
    }]);
    s.asked++;
  }
  const issue = (await db.get(db.k.selectFrom("nightly_results").select("issue_number as n").where("decision_id", "=", id).where("issue_number", "is not", null).limit(1)))?.n ?? null;
  await db.run(db.k.updateTable("nightly_results").set({ decision_id: id, issue_number: issue }).where("run_id", "=", run.id).where("check_id", "=", c.id));
  // The streak's earlier failures point at the same decision.
  await db.run(db.k.updateTable("nightly_results").set({ decision_id: id }).where("decision_id", "is", null).where("state", "=", "fail").where("check_id", "=", c.id).where("run_id", ">=", start)
    .where("run_id", "in", (eb) => eb.selectFrom("nightly_runs").select("id").where("repo", "=", run.repo)));
}

async function collect(db: Db, repo: string, deps: NightlyDeps, s: NightlySummary): Promise<void> {
  const at = deps.now().toISOString();
  const runs = await db.all(db.k.selectFrom("nightly_runs").select(cols("nightly_runs")).$narrowType<{ state: "running" }>().where("repo", "=", repo).where("state", "=", "running").orderBy("id"));
  for (const u of runs) {
    const run: NightlyRun = { id: u.id, repo: u.repo, sha: u.sha, startedAt: u.started_at, state: u.state };
    for (const r of await db.all(db.k.selectFrom("nightly_results").select(cols("nightly_results")).$narrowType<{ state: ResultState }>().where("run_id", "=", u.id).where("state", "=", "queued").orderBy("check_id"))) {
      const c = checkOf(r.check_id);
      const t = r.task_id === null ? null : await getTask(db, r.task_id);
      if (!c || !t) { await db.run(db.k.updateTable("nightly_results").set({ state: "error", summary: !c ? "check no longer in the catalogue" : "the build task is gone", finished_at: at }).where("run_id", "=", u.id).where("check_id", "=", r.check_id)); s.collected++; continue; }
      if (!TERMINAL.includes(t.state)) continue;
      const j = await judge(db, c, t, run, t.endedAt ?? at, deps);
      await db.run(db.k.updateTable("nightly_results").set({ state: j.state, summary: j.summary, finished_at: at }).where("run_id", "=", u.id).where("check_id", "=", r.check_id));
      s.collected++;
      if (j.state === "fail") await afterFailure(db, c, run, j.summary, at, s);
    }
    if (!await db.get(db.k.selectFrom("nightly_results").select((eb) => eb.lit(1).as("one")).where("run_id", "=", u.id).where("state", "=", "queued").limit(1))) await db.run(db.k.updateTable("nightly_runs").set({ state: "done" }).where("id", "=", u.id));
  }
}

/** Opens the issues operators asked for and records the "not now" answers. */
async function applyAnswers(db: Db, repo: string, deps: NightlyDeps, log: (l: string) => void, s: NightlySummary, by: By): Promise<void> {
  for (const a of (await actionable(db)).filter((x) => x.kind === "other" && nightlyDecision(repo, x.id))) {
    const at = deps.now().toISOString();
    const done = async (): Promise<void> => void await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", a.id).where("applied_at", "is", null));
    if (a.answer === NOT_NOW) { await done(); continue; }
    if (a.answer !== OPEN_ISSUE) continue;
    const rows = await db.all(db.k.selectFrom("nightly_results as r").innerJoin("nightly_runs as u", "u.id", "r.run_id").select([...cols("nightly_results", "r"), "u.sha"]).$narrowType<{ state: ResultState }>()
      .where("r.decision_id", "=", a.id).orderBy("r.run_id", "desc"));
    const last = rows[0];
    const c = last && checkOf(last.check_id);
    if (!last || !c || rows.some((r) => r.issue_number !== null)) { await done(); continue; }
    try {
      const made = await deps.openIssue(db, { repo, title: issueTitle(c), body: nightlyIssueBody(c, last.sha, last.summary), decisionId: a.id, by });
      await db.run(db.k.updateTable("nightly_results").set({ issue_number: made.number }).where("decision_id", "=", a.id));
      await done();
      s.issues++;
      log(`  ${repo}: opened ${made.url}`);
    } catch (e) {
      // A refusal leaves the answer unapplied for the next run; an unclear failure may have left an issue, so it is not retried.
      const clear = e instanceof IssueError && e.clear;
      log(`  ${repo}: issue for ${c.id} not opened: ${one(String((e as Error).message ?? e))}`);
      if (!clear) await done();
    }
  }
}

// ---- queueing -----------------------------------------------------------------

/** One run: a row, and per selected check a queued task, or `skipped` when no environment has the toolchain or the selection leaves nothing to run. */
async function queueRun(db: Db, repo: string, deps: NightlyDeps, s: NightlySummary): Promise<void> {
  const sha = await headOf(db, repo);
  const checks = await enabledChecks(db, repo);
  if (!sha || !checks.length) return;
  const nowMs = deps.now().getTime();
  if (await recentRun(db, repo, new Date(nowMs - NIGHTLY_EVERY_MS).toISOString(), new Date(nowMs - STALE_RUN_MS).toISOString())) return;
  const queued = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "queued")))!.n;
  if (queued + checks.length > MAX_QUEUED) { s.note = "the build queue is full; tried again at the next run"; return; }
  const have = await deps.toolchains(db);
  const at = new Date(nowMs).toISOString();
  await db.write(async () => {
    const runId = (await db.get(db.k.insertInto("nightly_runs").values({ repo, sha, started_at: at, state: "running" }).returning("id")))!.id;
    for (const { check, opts } of checks) {
      const insert = async (taskId: number | null, state: ResultState, summary: string | null): Promise<void> =>
        void await db.run(db.k.insertInto("nightly_results").values({ run_id: runId, check_id: check.id, task_id: taskId, state, summary, finished_at: state === "queued" ? null : at }));
      if (!have.has(check.toolchain)) { await insert(null, "skipped", "no toolchain"); s.skipped++; continue; }
      const plan = check.steps(opts);
      if (!plan) { await insert(null, "skipped", check.id === "fuzz" ? "no fuzz targets chosen" : "no crates chosen"); s.skipped++; continue; }
      const id = await createTask(db, { step: "nightly", repo, headSha: sha, baseSha: sha, requires: { os: "linux", toolchains: [check.toolchain] }, priority: NIGHTLY_PRIORITY, plan });
      await insert(id, "queued", null);
      s.queued++;
    }
  });
}

/** One repo: answers first, then results of finished tasks, then (once a day) the next run. Nothing at all with the switch off. */
export async function runNightly(db: Db, params: { repo: string; by?: By; onHandled?: (n: number) => void }, log: (l: string) => void = console.log, deps: NightlyDeps = defaultDeps()): Promise<NightlySummary> {
  const { repo } = params;
  const s: NightlySummary = { repo, queued: 0, skipped: 0, collected: 0, asked: 0, issues: 0, note: null };
  if (!await featureOn(db, "nightly", repo)) {
    s.note = `the Nightly checks feature is off for ${repo}`;
    log(`nightly ${repo}: ${s.note}; nothing done`);
    return s;
  }
  await applyAnswers(db, repo, deps, log, s, params.by ?? CLI_BY);
  await collect(db, repo, deps, s);
  await queueRun(db, repo, deps, s);
  params.onHandled?.(s.queued + s.skipped + s.collected + s.issues);
  log(`nightly ${repo}: queued ${s.queued}, skipped ${s.skipped}, collected ${s.collected}, asked ${s.asked}, issues ${s.issues}`);
  return s;
}

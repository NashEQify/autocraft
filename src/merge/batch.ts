// Stage 6, Integrate (batches): lands the merge-eligible PRs of a repo together. A batch is built from the
// default branch by merging each PR head with a merge commit (so GitHub marks every contributor PR merged when
// the batch lands), pushed to the pipeline account's fork, opened as a PR at once and merged through the merge
// command once upstream CI on the batch PR is green. Upstream CI is the only check of the combined tree.
//
//   autocraft-server merge-batches --repo R [--limit N]    (the runner's merge step calls runBatches)
//
// One run advances every batch of the repo in flight, then starts the next batch when none is left. A red batch is
// worked out without a model, cheapest first: checks that were red on the default branch at the base too blame no PR
// (the batch is rebuilt on a newer head, or waits); a failure the log traces to members (batch-blame.ts) tests those
// alone and rebuilds the rest without them; otherwise the failed runs are rerun once (a flake); then the batch is
// split in half and each half retried. A single PR still red goes on hold. When the default branch moves, the batch
// is rebuilt on the new head. Every GitHub write goes through `exec` / `run`.
import { ownPrSelect } from "../github/adopt.ts";
import { baseScopeRepos, scopeRepos } from "../pilot.ts";
import { isFastTracked, workScores } from "../fasttrack.ts";
import { mergeHeld } from "./holds.ts";
import { holdMerge } from "./controls.ts";
import { settlesLive, type RefreshDeps } from "../preapproval/permissions.ts";
import { markMerged } from "../mirror.ts";
import { closeMergedQuestions } from "./withdraw.ts";
import { mkdirSync } from "node:fs";
import { audit } from "../dash/audit.ts";
import { createTask, getTask, MAX_PATCH_BYTES, TERMINAL, warmKeyOf } from "../build/tasks.ts";
import { featureOn } from "../build/features.ts";
import { failureTail } from "../build/rounds.ts";
import { cloneTask } from "../verify/tasks.ts";
import { outcomeOf } from "../verify/results.ts";
import { scrub } from "../runner/scrub.ts";
import { rustPlan } from "../worker/rust.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guard, guardBatchMerge, guardRepo, liveOf, type GuardedRepo } from "../core/guard.ts";
import { claimForWork } from "../github/claim.ts";
import { ghClosePr, ghOpenPr, ghRerunMainFailed, mergeViaCommand, pushOwnBranch, type Writer } from "../github/write.ts";
import { readFailure } from "../cifix/logs.ts";
import type { CiFailure } from "../cifix/types.ts";
import { failureLocations, MAX_SUSPECTS, suspects } from "./batch-blame.ts";
import { type Exec, exec, fixupDir } from "../fixup/git.ts";
import { whoAmI } from "../fixup/index.ts";
import { setPipelineLogin } from "../github/pipeline-account.ts";
import { commitIdentity } from "../github/identity.ts";
import { branchOf, forkOf } from "../fixissue/index.ts";
import type { Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { BatchGit } from "./batch-git.ts";
import { ACTIVE_BATCH, BLOCKED_BY_REVIEW, CLOSED_BY_PERSON, MAX_PUBLISH_FAILURES, PUBLISH_FAILED, RUNS_WAIT_NOTE, BUILD_MAX_MS, MAX_BUILD_TRIES, activeBatches, admits, batchSizeOf, cancelBuild, retryDelayMs, getBatch, growBatchSize, insertBatch, membersOf, nextBranch, publishDelayMs, shrinkBatchSize, updateBatch, type BatchMember, type BatchRow } from "./batch-store.ts";
import { mergeApprovalOf } from "./approval.ts";
import { baseRefusal, recordLiveBase } from "./base.ts";
import { allowFailedArgs, prInfo, mergeRun, DEFAULT_MERGE_COMMAND, type CommandResult } from "./index.ts";
import { liveGateChecked } from "../review/discussion.ts";
import { redMainRepos } from "../mainci/index.ts";
import { effectiveCi, optionalChecks } from "../optional-checks.ts";
import { PIPELINE_LOGIN_KEY, buildQueue, type QueueEntry } from "./queue.ts";
import { planned } from "../core/select.ts";
import { envVar } from "../env.ts";
import { jobItem } from "../runner/job-items.ts";
import { leaseItem } from "../runner/leases.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { everySeq, filterSeq, someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const ACTOR = "batch";
/** How long the one rerun of a red batch PR gets to report new results before the batch is split anyway. */
export const RERUN_WAIT_MS = 45 * 60_000;
/** Batches in flight per repo at most; a split or a trace starts no more. */
const MAX_ACTIVE = 8;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)$/;

export type BatchDeps = {
  /** Every git and gh command. */
  exec: Exec;
  querier: Querier;
  /** Runs the merge command (`$AUTOCRAFT_MERGE_CMD`, default safe-merge). */
  run: (cmd: string, args: string[], appEnv?: Record<string, string>) => Promise<CommandResult>;
  mergeCommand: string;
  /** The head commit of the repo's default branch, or null. */
  mainHead: (repo: string, branch: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** Reads a maintainer's write permission through the GitHub App (default `appPermission`). */
  permission?: RefreshDeps["permission"];
};

export type BatchParams = {
  repo: string;
  /** Most PRs this run may start or land (the stage's daily limit left). */
  limit?: number;
  /** Called with the running count of PRs merged. */
  onMerged?: (merged: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};

export type BatchSummary = { runId: string; repo: string; started: string[]; published: string[]; merged: number[]; failed: number[]; split: string[]; superseded: string[]; waiting: string[] };

const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Why a text diff cannot be applied by a build task, or "". */
const diffProblem = (patch: string): string =>
  Buffer.byteLength(patch) > MAX_PATCH_BYTES ? "larger than the task limit" : /^Binary files |^GIT binary patch/m.test(patch) ? "binary" : "";

type Cand = { number: number; head: string; size: string; lines: number };

export async function defaultBatchDeps(): Promise<BatchDeps> {
  const { Client } = await import("../mirror.ts");
  const { defaultDeps } = await import("../fixissue/index.ts");
  return {
    exec, querier: new Client(1000), run: mergeRun, mergeCommand: envVar("MERGE_CMD") || DEFAULT_MERGE_COMMAND,
    mainHead: defaultDeps().mainHead, now: () => new Date(), root: fixupDir(),
  };
}

export async function runBatches(db: Db, params: BatchParams, log: (line: string) => void = console.log, deps?: BatchDeps): Promise<BatchSummary> {
  const d = deps ?? await defaultBatchDeps();
  const { repo } = params;
  if (!await mergeApprovalOf(db, repo)) throw new Error(`merging in ${repo} is not approved`);
  const at = () => d.now().toISOString();
  const runId = `batch-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: BatchSummary = { runId, repo, started: [], published: [], merged: [], failed: [], split: [], superseded: [], waiting: [] };
  if (!(await scopeRepos(db)).has(repo)) { log(`batch ${repo}: not in the pipeline scope; nothing done`); return s; }
  // A repo in scope only through fast track: only batches made of fast-tracked PRs are touched.
  const fullScope = (await baseScopeRepos(db)).has(repo);
  const mine = async (b: BatchRow): Promise<boolean> => fullScope || await everySeq((await membersOf(db, b.id)), async (m) => await isFastTracked(db, repo, m.number));
  const myBatches = async (): Promise<BatchRow[]> => await filterSeq((await activeBatches(db, repo)), mine);
  mkdirSync(d.root, { recursive: true });
  const git = new BatchGit(d.exec, d.root, repo);
  const stage = db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)");
  let landed = 0;
  /** PRs this run may still start or land under the stage's daily limit. */
  const left = () => (params.limit === undefined ? Infinity : params.limit - landed);

  const w: Writer = { db, login: ACTOR };
  const by = params.by ?? CLI_BY;
  const liveRead = liveOf(db, d.querier);
  const refOf = (n: number) => `${repo}#${n}`;
  const branch = await branchOf(db, repo);
  /** The batch stage's repo-level writes (its branch and PR) need the repo's merge approval. */
  const grant = async (need: "merge" | null = "merge"): Promise<GuardedRepo | null> => {
    const g = await guardRepo(db, repo, need, by);
    if ("refused" in g) { log(`  ${g.refused}`); return null; }
    return g;
  };
  const closePr = async (b: BatchRow, why: string) => {
    if (b.pr_number === null) return;
    const g = await grant(null);
    if (!g) return;
    const r = await ghClosePr(w, g, d.exec, { repo, number: b.pr_number }, { by: "fixed" }, why, { run: runId, batch: b.branch });
    if (r.code !== 0) log(`  ${b.branch}: could not close the batch PR: ${oneLine(r.stderr)}`);
  };

  /**
   * Members that merge on a Merge answer (path operator) whose answerer no longer settles on the repo. The batch PR is merged without the user
   * lane, so a maintainer's write permission is read now (settlesLive) rather than trusted from the cache. `unsure`: GitHub could not answer for one.
   */
  async function answersGone(members: { number: number; head: string }[], q: QueueEntry[]): Promise<{ gone: { number: number; why: string }[]; unsure: boolean }> {
    const gone: { number: number; why: string }[] = [];
    let unsure = false;
    for (const m of members) {
      const e = q.find((x) => x.number === m.number && x.head === m.head);
      if (e?.path !== "operator" || !e.decisionId) continue;
      const login = (await db.prepare("SELECT answered_by FROM main.decisions WHERE id = ? AND answer = 'merge'").get(e.decisionId) as { answered_by: string | null } | undefined)?.answered_by;
      if (!login) continue;
      const v = await settlesLive(db, login, repo, d.permission);
      if (v === "unknown") unsure = true;
      if (v === "no") gone.push({ number: m.number, why: `${login} no longer settles decisions on ${repo}, so their Merge answer no longer counts` });
    }
    return { gone, unsure };
  }
  /** Holds a PR whose Merge answer stopped counting, as Remove from batch does, so the next run does not batch it again; an operator releases it. */
  const holdGone = async (x: { number: number; why: string }, batch: string | null) => {
    await holdMerge(db, ACTOR, repo, x.number, { ...(batch ? { batch } : {}), reason: x.why });
    if (batch) await audit(db, ACTOR, "batch-remove", refOf(x.number), { run: runId, batch, reason: x.why });
    log(`  ${refOf(x.number)}: held: ${x.why}`);
  };

  /**
   * Builds a batch of the candidates, in order, from the current head of the default branch (or `onBase`, a head the caller
   * fetched for several batches that must share it); null when no PR could be merged.
   */
  async function startBatch(cands: Cand[], max: number, parentId: number | null, onBase?: string): Promise<number | null> {
    const base = onBase ?? await git.fetchMain(ownerOf(repo), repo, branch);
    const who = await whoAmI(d.exec);
    const author = await commitIdentity(db, repo, async () => who);
    await setPipelineLogin(db, who.login);
    const chain: { cand: Cand; commit: string }[] = [];
    let cur = base;
    const q = await buildQueue(db, { repo, merged: "exclude" });
    for (const c of cands) {
      if (chain.length && !admits(chain.map((x) => x.cand), c, max)) continue;
      const sha = await git.fetchPr(ownerOf(repo), repo, c.number);
      if (sha !== c.head) { log(`  ${refOf(c.number)}: head moved to ${short(sha)}; left out`); continue; }
      // A batch is built on the default branch: a PR aimed at another base would bring that base's commits along.
      const info = await prInfo(d.querier, repo, c.number);
      if (!info || info.baseRef !== branch) {
        if (info) await recordLiveBase(db, repo, c.number, c.head, info.baseRef);
        log(`  ${refOf(c.number)}: left out: its base branch is ${info?.baseRef ?? "unknown"}, not ${branch}`);
        continue;
      }
      // The review must have read the diff against the default branch too, or the batch would bring in commits no review read.
      const baseWhy = await baseRefusal(db, repo, c.head, c.number, info.baseRef);
      if (baseWhy) { log(`  ${refOf(c.number)}: left out: ${baseWhy}`); continue; }
      const g = await guard(db, { repo, number: c.number }, { kind: "merge", head: c.head, batch: true }, by, liveRead);
      if ("refused" in g) { log(`  ${refOf(c.number)}: left out: ${g.refused}`); continue; }
      const answers = await answersGone([c], q);
      if (answers.gone.length) { await holdGone(answers.gone[0]!, null); continue; }
      if (answers.unsure) { log(`  ${refOf(c.number)}: left out: GitHub could not confirm the write permission of who answered Merge`); continue; }
      const tree = await git.mergeTree(cur, sha);
      if (!tree) { log(`  ${refOf(c.number)}: conflicts with the batch so far; waits for the next one`); continue; }
      cur = await git.mergeCommit(tree, [cur, sha], `Merge pull request #${c.number}`, { name: author.name, email: author.email });
      chain.push({ cand: c, commit: cur });
    }
    if (!chain.length) return null;
    const tip = chain[chain.length - 1]!.commit;
    // With Build batches on, a build task checks the combined tree before the batch PR opens. Any trouble queueing it
    // opens the PR as usual: upstream CI stays the authority.
    let taskId: number | null = null;
    let skipped = "";
    if (fullScope && await featureOn(db, "batch-build", repo)) {
      try {
        const patch = await git.diffText(base, tip);
        skipped = diffProblem(patch) && `the combined diff is ${diffProblem(patch)}`;
        if (!skipped) {
          taskId = await createTask(db, {
            step: "merge-batch", repo, headSha: base, baseSha: base, requires: { os: "linux", toolchains: ["rust-stable"] },
            plan: rustPlan({ cargoArgs: ["--workspace"] }), patch, warm: { key: warmKeyOf(repo), role: "use" },
          });
        }
      } catch (e) { skipped = `the build could not be queued: ${oneLine(String((e as Error).message ?? e), 120)}`; }
    }
    const name = await nextBranch(db, repo, d.now());
    const members: BatchMember[] = chain.map((x) => ({ number: x.cand.number, head_oid: x.cand.head }));
    const id = await insertBatch(db, { repo, branch: name, baseSha: base, commitSha: tip, parentId, taskId, members, at: at() });
    if (taskId !== null) await updateBatch(db, id, at(), { build_state: "pending", build_tries: 1 });
    else if (skipped) await skipBuild(await getBatch(db, id), skipped);
    await audit(db, ACTOR, "batch-start", `${repo}:${name}`, { run: runId, base, prs: members.map((m) => m.number) });
    s.started.push(name);
    const ag = await grant();
    if (ag) for (const m of members) await claimForWork(w, ag, d.querier, repo, m.number, "pr", { id: who.nodeId, login: who.login }, { run: runId, batch: name }, log);
    log(`  ${name}: ${members.length} PR${members.length === 1 ? "" : "s"} (${members.map((m) => `#${m.number}`).join(", ")}) on ${short(base)}; ${taskId === null ? "opening the batch PR" : `building and testing it in task #${taskId} first`}`);
    if (taskId === null) await publish(await getBatch(db, id), members);
    return id;
  }

  /** The batch PR opens without a passed build: records why. */
  async function skipBuild(b: BatchRow, why: string): Promise<void> {
    await updateBatch(db, b.id, at(), { build_state: "skipped" });
    await audit(db, ACTOR, "batch-build-skip", `${repo}:${b.branch}`, { run: runId, reason: oneLine(why, 200) });
    log(`  ${b.branch}: build skipped: ${why}`);
  }

  const asCands = (ms: BatchMember[]): Cand[] => ms.map((m) => ({ number: m.number, head: m.head_oid, size: "S", lines: 0 }));

  /** The batch's PRs are rebuilt on the current default branch head, leaving out `members` that changed. */
  async function supersede(b: BatchRow, keep: BatchMember[], why: string): Promise<void> {
    // A control may have ended the batch while the caller's GitHub calls ran.
    if (!ACTIVE_BATCH.includes((await getBatch(db, b.id)).state)) return;
    await cancelBuild(db, b, ACTOR);
    await updateBatch(db, b.id, at(), { state: "superseded", summary: why });
    await closePr(b, `Closing: ${why}. The PRs are rebuilt in a new batch.`);
    s.superseded.push(b.branch);
    log(`  ${b.branch}: ${why}`);
    const rebuild = await filterSeq(keep, async (m) => !await mergeHeld(db, repo, m.number));
    if (rebuild.length && left() > 0) await startBatch(asCands(rebuild), left(), b.id);
  }

  /** Why the batch must be rebuilt because the default branch moved, or null: a move that merges cleanly with the batch tip does not matter (GitHub and upstream CI re-check the batch PR). */
  async function movedAway(b: BatchRow): Promise<string | null> {
    const head = await d.mainHead(repo, branch);
    if (!head || head === b.base_sha) return null;
    try {
      const now = await git.fetchMain(ownerOf(repo), repo, branch);
      if (await git.mergeTree(now, b.commit_sha)) return null;
    } catch { /* the batch commit is gone from the cache: rebuild */ }
    return `${branch} moved to ${short(head)} and conflicts with the batch`;
  }

  /** A failed batch: several PRs split in half and each half retried; one PR goes on hold. */
  async function fail(b: BatchRow, why: string): Promise<void> {
    const members = await membersOf(db, b.id);
    await shrinkBatchSize(db, repo);
    await closePr(b, "Closing: the batch failed. Its PRs are retried in smaller batches or held.");
    if (members.length === 1) {
      const m = members[0]!;
      const summary = why;
      await updateBatch(db, b.id, at(), { state: "failed", summary: oneLine(summary, 400) });
      await stage.run(repo, m.number, "hold", at(), ACTOR, `batch failed at ${short(m.head_oid)}: ${oneLine(summary, 200)}`);
      await audit(db, ACTOR, "batch-hold", refOf(m.number), { run: runId, batch: b.branch, summary: oneLine(summary, 200) });
      s.failed.push(m.number);
      log(`  ${b.branch}: ${refOf(m.number)} failed alone; on hold: ${oneLine(summary, 120)}`);
      return;
    }
    await updateBatch(db, b.id, at(), { state: "split", summary: oneLine(why, 400) });
    s.split.push(b.branch);
    log(`  ${b.branch}: ${why}; splitting ${members.length} PRs in half`);
    const mid = Math.ceil(members.length / 2);
    for (const half of [members.slice(0, mid), members.slice(mid)]) {
      if ((await activeBatches(db, repo)).length >= MAX_ACTIVE) break;
      if (left() <= 0) break;
      await startBatch(asCands(half), left(), b.id);
    }
  }

  /**
   * The failure points at `traced` (fewer than all members): each of them is tested alone in a batch of its own, which
   * holds it only if it is red there too, and the others are rebuilt without them. The batch size stays: the batch
   * was not too big, one PR broke it.
   */
  async function drop(b: BatchRow, members: BatchMember[], traced: Map<number, string>, why: string): Promise<void> {
    // A control may have ended the batch while the caller's GitHub calls ran.
    if (!ACTIVE_BATCH.includes((await getBatch(db, b.id)).state)) return;
    await cancelBuild(db, b, ACTOR);
    const list = [...traced].map(([n, w]) => `#${n} (${w})`).join("; ");
    await updateBatch(db, b.id, at(), { state: "split", summary: oneLine(`${why}; traced to ${list}: tested alone, the rest rebuilt without`, 400) });
    await closePr(b, `Closing: the batch failed and its failure points at ${[...traced.keys()].map((n) => `#${n}`).join(", ")}. Those are tested alone; the other PRs are rebuilt without them.`);
    for (const [n, w] of traced) await audit(db, ACTOR, "batch-blame", refOf(n), { run: runId, batch: b.branch, reason: oneLine(w, 200) });
    s.split.push(b.branch);
    log(`  ${b.branch}: ${why}; traced to ${list}`);
    // Every batch started here is built on one head, so a suspect alone is never red from a change the others did not have.
    const base = await git.fetchMain(ownerOf(repo), repo, branch);
    // The suspects go first: their tests alone are what the trace asks for. A rest that finds no room returns to the queue
    // and is batched again later; nothing of it is lost.
    for (const m of await filterSeq(members, async (x) => traced.has(x.number) && !await mergeHeld(db, repo, x.number))) {
      if (left() <= 0 || (await activeBatches(db, repo)).length >= MAX_ACTIVE) break;
      await startBatch(asCands([m]), 1, b.id, base);
    }
    const rest = await filterSeq(members, async (m) => !traced.has(m.number) && !await mergeHeld(db, repo, m.number));
    if (rest.length && left() > 0 && (await activeBatches(db, repo)).length < MAX_ACTIVE) await startBatch(asCands(rest), left(), b.id, base);
  }

  /** The members a failure's log text points at, when that is a trace worth following (some, not all, and few). */
  async function traceOf(b: BatchRow, members: BatchMember[], text: string): Promise<Map<number, string> | null> {
    if (members.length < 2) return null;
    try {
      const found = await suspects(git, b, members, failureLocations(text));
      return found.size && found.size < members.length && found.size <= MAX_SUSPECTS ? found : null;
    } catch (e) {
      log(`  ${b.branch}: the failure could not be traced: ${oneLine(String((e as Error).message ?? e), 120)}`);
      return null;
    }
  }

  /** The failed checks of the batch tip with their log tails, or null when they cannot be read. Read-only. */
  async function readBatchFailure(b: BatchRow): Promise<CiFailure | null> {
    const gh = async (args: string[]): Promise<string> => {
      const r = await d.exec("gh", args);
      if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout || `gh exited ${r.code}`));
      return r.stdout;
    };
    try {
      const r = await readFailure(gh, repo, b.commit_sha, await optionalChecks(db, repo));
      return r.kind === "failure" ? r.failure : null;
    } catch {
      return null;
    }
  }

  /** The gate checks that failed on the default branch at `sha`, from the main CI poll; null when that head was not polled. */
  async function redOnMainAt(sha: string): Promise<Set<string> | null> {
    const row = await db.prepare("SELECT failing FROM main.main_ci WHERE repo = ? AND head_sha = ?").get(repo, sha) as { failing: string } | undefined;
    if (!row) return null;
    try {
      return new Set((JSON.parse(row.failing) as { name?: string }[]).map((f) => f.name ?? "").filter(Boolean));
    } catch {
      return null;
    }
  }

  /**
   * Upstream CI failed on the batch PR. In order: checks red on the default branch at the base too blame no PR; a
   * failure the log traces drops those PRs (tested alone); otherwise the failed runs are rerun once; then the batch fails.
   */
  async function red(b: BatchRow, members: BatchMember[], names: string[]): Promise<void> {
    const optional = new Set(await optionalChecks(db, repo));
    const failing = names.filter((n) => !optional.has(n));
    const why = `upstream CI failed on the batch PR${failing.length ? `: ${failing.join(", ")}` : ""}`;
    const atBase = await redOnMainAt(b.base_sha);
    if (atBase && failing.length && failing.every((n) => atBase.has(n))) {
      const head = await d.mainHead(repo, branch);
      if (head && head !== b.base_sha) return supersede(b, members, `${failing.join(", ")} failed on ${branch} at the base too; rebuilt on ${short(head)}`);
      const note = `${failing.join(", ")} failed on ${branch} at the base too; waits for ${branch} to change`;
      if (b.summary !== note) { await updateBatch(db, b.id, at(), { summary: note }); log(`  ${b.branch}: ${note}`); }
      s.waiting.push(b.branch);
      return;
    }
    const failure = await readBatchFailure(b);
    if (b.ci_reruns && b.ci_rerun_at) {
      // Only results from after the rerun say it failed again; older ones are what the rerun replaces. Results that cannot
      // be read are not fresh either: a GitHub hiccup must not split or hold before the wait is over.
      const fresh = !!failure && failure.checks.every((c) => !!c.completedAt && Date.parse(c.completedAt) > Date.parse(b.ci_rerun_at!));
      if (!fresh && d.now().getTime() < Date.parse(b.ci_rerun_at) + RERUN_WAIT_MS) { s.waiting.push(b.branch); return; }
    }
    const traced = failure && await traceOf(b, members, failure.checks.flatMap((c) => c.steps.map((x) => x.tail)).join("\n"));
    // A control may have ended the batch while the log and trace reads ran.
    const active = async (): Promise<boolean> => ACTIVE_BATCH.includes((await getBatch(db, b.id)).state);
    if (!await active()) return;
    if (traced) return drop(b, members, traced, why);
    if (!b.ci_reruns) {
      const runs = [...new Set((failure?.checks ?? []).filter((c) => c.conclusion === "failure" && c.runId !== null).map((c) => c.runId!))];
      const g = runs.length ? await grant() : null;
      if (g) {
        // GitHub's rollup is red as soon as one job fails, while the run's other jobs go on, and it refuses to rerun the
        // failed jobs of a run in progress: the one rerun waits until every failed check's run is completed.
        if (await anyRunInProgress(runs)) {
          if (!await active()) return;
          const note = `${why}; waiting for the failed CI runs to finish before the one rerun`;
          if (b.summary !== note) { await updateBatch(db, b.id, at(), { summary: oneLine(note, 400) }); log(`  ${b.branch}: ${note}`); }
          s.waiting.push(b.branch);
          return;
        }
        if (!await active()) return;
        // Recorded before the calls: one rerun per batch, also when this process dies in the middle of them.
        await updateBatch(db, b.id, at(), { ci_reruns: 1, ci_rerun_at: at(), summary: oneLine(`${why}; no PR traced, rerunning the failed runs once`, 400) });
        let refused = 0;
        for (const id of runs) if ((await ghRerunMainFailed(w, g, d.exec, { repo, head: b.commit_sha, runId: id }, { batch: b.branch })).code !== 0) refused++;
        await audit(db, ACTOR, "batch-rerun", `${repo}:${b.branch}`, { run: runId, runs, refused });
        log(`  ${b.branch}: ${why}; no PR traced, reran ${runs.length} failed run${runs.length === 1 ? "" : "s"} once${refused ? ` (${refused} refused)` : ""}`);
        // Every call refused: no rerun is under way, so there is nothing to wait for.
        if (runs.length && refused === runs.length) return await active() ? fail(b, why) : undefined;
        s.waiting.push(b.branch);
        return;
      }
    }
    if (!await active()) return;
    return fail(b, why);
  }

  /** Whether any of the Actions runs is known to be not completed. A run that cannot be read counts as completed: the rerun is refused if it is not. */
  async function anyRunInProgress(runs: number[]): Promise<boolean> {
    for (const id of runs) {
      try {
        const r = await d.exec("gh", ["api", `repos/${slugOf(repo)}/actions/runs/${id}`]);
        if (r.code !== 0) continue;
        const st = (JSON.parse(r.stdout) as { status?: string }).status;
        if (st && st !== "completed") return true;
      } catch { /* unreadable: treated as completed */ }
    }
    return false;
  }

  /** A push or PR creation failed: the error is kept on the batch, the next try waits longer, and the fifth failure ends the batch so its PRs go back to the queue. */
  async function publishFailed(b: BatchRow, error: string): Promise<void> {
    const failures = b.retries + 1;
    log(`  ${b.branch}: ${error}`);
    if (failures >= MAX_PUBLISH_FAILURES) {
      await updateBatch(db, b.id, at(), { state: "failed", retries: failures, summary: oneLine(`${PUBLISH_FAILED} after ${failures} tries: ${error}`, 400) });
      s.failed.push(...(await membersOf(db, b.id)).map((m) => m.number));
      return;
    }
    await updateBatch(db, b.id, at(), { retries: failures, summary: oneLine(error, 400) });
    s.waiting.push(b.branch);
  }

  async function publish(b: BatchRow, members: BatchMember[]): Promise<void> {
    const moved = await movedAway(b);
    if (moved) return supersede(b, members, moved);
    // Time passes between building and pushing (and between retries of a failed push): the members must still be open at the batched heads.
    const checks = await refreshChecks(db, d.querier, repo, members.map((m) => m.number));
    const live = members.filter((m) => checks.some((c) => c.number === m.number && c.state === "OPEN" && c.head_oid === m.head_oid));
    if (live.length < members.length) return supersede(b, live, "a PR in the batch was closed, merged or pushed to");
    // An operator may have stopped the batch while the checks were read.
    if ((await getBatch(db, b.id)).state !== "checking") return;
    const who = await whoAmI(d.exec);
    const g = await grant();
    if (!g) return publishFailed(b, "not approved or the pipeline is off");
    const fork = await forkOf(w, g, d.exec, who.login, repo, { run: runId });
    const push = await pushOwnBranch(w, g, git, "batch-push", { repo, remote: fork, branch: b.branch, sha: b.commit_sha }, { run: runId, fork });
    if (push.code !== 0) return publishFailed(b, `push failed: ${oneLine(push.stderr)}`);
    await updateBatch(db, b.id, at(), { fork });
    const links = members.map((m) => `- [${repo}#${m.number}](https://github.com/${slugOf(repo)}/pull/${m.number})`).join("\n");
    const body = `Lands ${members.length} reviewed and verified pull request${members.length === 1 ? "" : "s"} together. Each one is merged with its own commits.\n\n${links}\n`;
    // A crash after `gh pr create` leaves a PR for this branch: adopt it instead of failing on "already exists".
    const owner = fork.split("/")[0]!;
    const sel = await ownPrSelect(db, repo, [owner], branch);
    const found = await d.exec("gh", ["pr", "list", "--repo", `${slugOf(repo)}`, "--state", "open", "--head", b.branch, "--json", sel.json, "--jq", sel.jq]);
    const existing = found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    const pr = PR_URL.test(existing) ? { code: 0, stdout: existing, stderr: "" }
      : await ghOpenPr(w, g, d.exec, "batch-pr", { repo, target: `${repo}:${b.branch}`, base: branch, head: `${owner}:${b.branch}`, title: `Integration batch ${b.branch}`, body }, { by: "fixed" }, { run: runId });
    const url = pr.stdout.trim().split("\n").pop() ?? "";
    const m = url.match(PR_URL);
    if (pr.code !== 0 || !m) return publishFailed(b, `batch PR not opened: ${oneLine(pr.stderr || pr.stdout)}`);
    if ((await getBatch(db, b.id)).state !== "checking") {
      // Ended while the PR was being opened: close it again and leave the row as it is.
      const closed = await ghClosePr(w, g, d.exec, { repo, number: Number(m[1]) }, { by: "fixed-operator" }, "Closing: the batch was ended by an operator.", { run: runId, batch: b.branch });
      if (closed.code !== 0) {
        // Keep the PR on the row so a later control or run can close it.
        await updateBatch(db, b.id, at(), { pr_number: Number(m[1]), pr_url: url });
        log(`  ${b.branch}: ended while its PR was opened; could not close ${url}: ${oneLine(closed.stderr)}`);
        return;
      }
      log(`  ${b.branch}: ended while its PR was opened; closed ${url}`);
      return;
    }
    await updateBatch(db, b.id, at(), { state: "open", pr_number: Number(m[1]), pr_url: url });
    s.published.push(b.branch);
    log(`  ${b.branch}: opened ${url}`);
  }

  /** Bookkeeping once the batch PR is merged, whoever merged it. */
  async function recordLanded(b: BatchRow, members: BatchMember[], q: QueueEntry[], mergeSha: string | null = null): Promise<void> {
    // A control may have ended the batch while the merge ran: the merge still happened, so the row says so and the audit shows the order of events.
    const was = (await getBatch(db, b.id)).state;
    if (was !== "open" && was !== "checking") await audit(db, ACTOR, "batch-merged-after-end", `${repo}:${b.branch}`, { run: runId, was, prs: members.map((m) => m.number) });
    await updateBatch(db, b.id, at(), { state: "merged", summary: null, ...(mergeSha ? { merge_sha: mergeSha } : {}) });
    for (const m of members) {
      const e = q.find((x) => x.number === m.number);
      await db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome, reason, ci, mergeable) VALUES (?, ?, ?, ?, ?, ?, 'merge', 'merged', NULL, ?, ?)")
        .run(repo, m.number, m.head_oid, runId, at(), e?.path ?? "rule", e?.ci ?? "success", e?.mergeable ?? "MERGEABLE");
      await stage.run(repo, m.number, "merged", at(), ACTOR, `merge in ${b.branch} at ${short(m.head_oid)}`);
      await jobItem(db, repo, m.number, `merged in batch ${b.branch}`, log);
      await markMerged(db, repo, m.number, at());
      await closeMergedQuestions(db, repo, m.number, at());
      await audit(db, ACTOR, "merge", refOf(m.number), { run: runId, head: m.head_oid, method: "merge", batch: b.branch });
      if (e?.path === "operator" && e.decisionId) await db.prepare("UPDATE main.decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(at(), e.decisionId);
      s.merged.push(m.number);
    }
    await growBatchSize(db, repo);
    landed += members.length;
    params.onMerged?.(landed);
    log(`  ${b.branch}: merged ${members.length} PR${members.length === 1 ? "" : "s"}`);
  }

  async function land(b: BatchRow, members: BatchMember[], q: QueueEntry[]): Promise<void> {
    // One query for the batch PR and its members: the members must still be open at the head that was batched.
    const checks = await refreshChecks(db, d.querier, repo, [b.pr_number!, ...members.map((m) => m.number)]);
    const ch = checks.find((c) => c.number === b.pr_number);
    if (!ch) { s.waiting.push(b.branch); return; }
    if (ch.state === "MERGED") return await recordLanded(b, members, q);
    // Main is red: the batch keeps its checks but does not merge until main is green. Main-fix PRs never join a batch (a plan merge action with singleOnly).
    if ((await redMainRepos(db)).has(repo)) {
      log(`  ${b.branch}: main CI is red in ${repo}; not merged`);
      s.waiting.push(b.branch);
      return;
    }
    // A control (stop, remove) may have ended the batch while the checks were read; it closes the PR itself.
    if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
    if (ch.state === "CLOSED") {
      // Our own closes mark the batch first, so a closed active batch was closed by a person: hold its PRs for their current heads.
      await updateBatch(db, b.id, at(), { state: "failed", summary: CLOSED_BY_PERSON });
      for (const m of members) await stage.run(repo, m.number, "hold", at(), ACTOR, `the batch PR ${b.branch} was closed; held at ${short(m.head_oid)}`);
      s.failed.push(...members.map((m) => m.number));
      log(`  ${b.branch}: the batch PR was closed; its PRs are held until they change`);
      return;
    }
    const live = members.filter((m) => checks.some((c) => c.number === m.number && c.state === "OPEN" && c.head_oid === m.head_oid));
    if (live.length < members.length) return supersede(b, live, "a PR in the batch was closed, merged or pushed to");
    const ci = await effectiveCi(db, repo, ch.overall, ch.checks);
    if (ci === "failure") return red(b, members, ch.checks.filter((c) => c.state === "failure").map((c) => c.name));
    if (ch.mergeable === "CONFLICTING") return supersede(b, members, `the batch PR conflicts with ${branch}`);
    const moved = await movedAway(b);
    if (moved) return supersede(b, members, moved);
    if (members.length > left()) { log(`  ${b.branch}: ${members.length} PRs exceed the ${Math.max(left(), 0)} left of the daily limit; waits`); s.waiting.push(b.branch); return; }
    if (ci !== "success" || ch.mergeable !== "MERGEABLE") {
      // A fork's runs wait for a maintainer's approval; the ci-approve step does it where the repo allows, and the note says so until the runs started.
      const waiting = await db.prepare("SELECT runs, reread FROM ci_run_approvals WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, b.pr_number!, b.commit_sha) as { runs: string; reread: number } | undefined;
      const note = waiting && (JSON.parse(waiting.runs).length || waiting.reread) ? RUNS_WAIT_NOTE : null;
      if ((b.summary ?? null) !== note) await updateBatch(db, b.id, at(), { summary: note });
      s.waiting.push(b.branch);
      return;
    }
    const info = await prInfo(d.querier, repo, b.pr_number!);
    if (!info) { s.waiting.push(b.branch); return; }
    if (info.head !== b.commit_sha) { log(`  ${b.branch}: the batch branch moved from ${short(b.commit_sha)} to ${short(info.head)}; not merged`); s.waiting.push(b.branch); return; }
    if (info.baseRef !== branch) { log(`  ${b.branch}: the batch PR's base is ${info.baseRef}, not ${branch}; not merged`); s.waiting.push(b.branch); return; }
    // The batch PR is ours but a maintainer may review it too.
    const own = await liveGateChecked(db, d.querier, repo, b.pr_number!, "", log);
    if (own === null) { s.waiting.push(b.branch); return; }
    if (own.blocked) {
      if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
      // Rebuilding would only open a new PR around the review: the batch fails and its PRs wait for a new head.
      await updateBatch(db, b.id, at(), { state: "failed", summary: BLOCKED_BY_REVIEW });
      await closePr(b, `Closing: ${own.blocked}. The PRs in it are held until they change.`);
      for (const m of members) await stage.run(repo, m.number, "hold", at(), ACTOR, `the batch PR ${b.branch} has changes requested; held at ${short(m.head_oid)}`);
      s.failed.push(...members.map((m) => m.number));
      log(`  ${b.branch}: ${own.blocked}; its PRs are held until they change`);
      return;
    }
    for (const m of members) {
      // A member retargeted or reviewed again against another base since the batch was built: what lands is no longer what its review read.
      const mirrored = (await db.prepare("SELECT base_ref FROM items WHERE repo = ? AND number = ?").get(repo, m.number) as { base_ref: string | null } | undefined)?.base_ref ?? branch;
      const baseWhy = mirrored !== branch ? `its base branch is ${mirrored}, not ${branch}` : await baseRefusal(db, repo, m.head_oid, m.number, branch);
      if (baseWhy) return supersede(b, members.filter((x) => x !== m), `${refOf(m.number)} left the batch: ${baseWhy}`);
      const gate = await liveGateChecked(db, d.querier, repo, m.number, m.head_oid, log);
      if (gate === null) { s.waiting.push(b.branch); return; }
      if (gate.blocked) return supersede(b, members.filter((x) => x !== m), `a PR in the batch has a review: ${gate.blocked}`);
      if (gate.moved) return supersede(b, members.filter((x) => x !== m), "a PR in the batch has new comments or reviews to be reviewed first");
    }
    // A member merging on a maintainer's Merge answer: that maintainer must still have write access, read now.
    const answers = await answersGone(members.map((m) => ({ number: m.number, head: m.head_oid })), q);
    if (answers.gone.length) {
      if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
      for (const x of answers.gone) await holdGone(x, b.branch);
      return supersede(b, members.filter((m) => !answers.gone.some((x) => x.number === m.number)), `${answers.gone.map((x) => refOf(x.number)).join(", ")} left the batch: ${answers.gone[0]!.why}`);
    }
    if (answers.unsure) { log(`  ${b.branch}: GitHub could not confirm the write permission of who answered Merge for a PR in it; not merged this pass`); s.waiting.push(b.branch); return; }
    // Holds and controls may have changed during the calls above: look again right before merging.
    if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; not merged`); return; }
    if (await someSeq(members, async (m) => await mergeHeld(db, repo, m.number))) { log(`  ${b.branch}: a PR in the batch was held meanwhile; not merged`); s.waiting.push(b.branch); return; }
    // A fix-up or CI fix pushing to a member would move its head under the merge: hold the members' leases until it ends.
    const leases: (() => Promise<void>)[] = [];
    for (const m of members) {
      const release = await leaseItem(db, `pr:${repo}#${m.number}`, log);
      if (!release) { for (const f of leases) await f(); log(`  ${b.branch}: a PR in the batch is being worked; not merged this pass`); s.waiting.push(b.branch); return; }
      leases.push(release);
    }
    try {
      let after: Awaited<ReturnType<typeof refreshChecks>>[number] | undefined;
      // Every member must still hold at its batched head, and the batch PR at the batch tip.
      const g = await guardBatchMerge(db, { repo, number: b.pr_number!, head: b.commit_sha }, members.map((m) => ({ number: m.number, head: m.head_oid })), by, liveRead);
      if ("refused" in g) { log(`  ${b.branch}: not merged: ${g.refused}`); s.waiting.push(b.branch); return; }
      const r = await mergeViaCommand(w, d.run, d.mergeCommand, g, { method: "merge", extra: await allowFailedArgs(db, repo, d.mergeCommand) }, { run: runId, head: b.commit_sha, batch: b.branch }, async () => {
        after = (await refreshChecks(db, d.querier, repo, [b.pr_number!]))[0];
        return after?.state === "MERGED";
      });
      if (r.code !== 0) {
        // The merge may have gone through although the command failed afterwards.
        if (after?.state === "MERGED") return await recordLanded(b, members, q);
        const why = oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`;
        await updateBatch(db, b.id, at(), { summary: `${d.mergeCommand}: ${why}`.slice(0, 400) });
        log(`  ${b.branch}: refused: ${why}`);
        s.waiting.push(b.branch);
        return;
      }
      // The merge command prints `<repo>#<pr> MERGED <merge commit>`.
      await recordLanded(b, members, q, /\bMERGED ([0-9a-f]{7,40})\b/.exec(r.stdout)?.[1] ?? null);

    } finally {
      for (const f of leases) await f();
    }
  }

  /** Reads the build task of a batch that has no PR yet: opens the PR when it passed, fails the batch when the tree is red, waits or fails open otherwise. */
  async function readBuild(b: BatchRow, members: BatchMember[]): Promise<void> {
    const open = async (why?: string) => { if (why) await skipBuild(b, why); return publish(await getBatch(db, b.id), members); };
    const task = b.task_id === null ? null : await getTask(db, b.task_id);
    if (!task) return open("the build task is gone");
    if (!TERMINAL.includes(task.state)) {
      if (d.now().getTime() - Date.parse(task.queuedAt) <= BUILD_MAX_MS) { s.waiting.push(b.branch); return; }
      await cancelBuild(db, b, ACTOR);
      return open("the build took longer than 3 hours");
    }
    const out = outcomeOf(task);
    const tries = b.build_tries ?? 0;
    if (out.kind === "pass") {
      await updateBatch(db, b.id, at(), { build_state: "passed" });
      return open();
    }
    if (out.kind === "fail") {
      // One rerun of a failed test step tells a flake from a red tree.
      if (out.step === "test" && tries < 2) {
        await updateBatch(db, b.id, at(), { task_id: await cloneTask(db, task.id), build_tries: tries + 1 });
        log(`  ${b.branch}: the test step failed; queued the build again to rule out a flake`);
        s.waiting.push(b.branch);
        return;
      }
      await updateBatch(db, b.id, at(), { build_state: "failed" });
      const text = scrub(await failureTail(db, task.id, out.step));
      const traced = await traceOf(b, members, text);
      if (traced) return drop(await getBatch(db, b.id), members, traced, `the combined tree failed at ${out.step}`);
      const tail = oneLine(text, 150);
      return fail(await getBatch(db, b.id), `the combined tree failed at ${out.step}${tail ? `: ${tail}` : ""}`);
    }
    // A build-environment error says nothing about the PRs: try again with growing waits, then open the PR anyway; never split or hold.
    if (tries >= MAX_BUILD_TRIES) return open(`${out.reason} (${tries} tries)`);
    if (d.now().getTime() - Date.parse(b.updated_at) < retryDelayMs(tries - 1)) { s.waiting.push(b.branch); return; }
    await updateBatch(db, b.id, at(), { task_id: await cloneTask(db, task.id), build_tries: tries + 1 });
    log(`  ${b.branch}: ${out.reason}; queued the build again (try ${tries + 1})`);
    s.waiting.push(b.branch);
  }

  async function advance(id: number): Promise<void> {
    const b = await getBatch(db, id);
    if (!ACTIVE_BATCH.includes(b.state)) return;
    const members = await membersOf(db, b.id);
    const q = await buildQueue(db, { repo, merged: "exclude" });
    // The batch state overrides a PR's own only while it would still be mergeable (see BATCHABLE), and its merge path must still exist.
    const keep = members.filter((m) => q.some((e) => e.number === m.number && e.head === m.head_oid && e.path !== null && !e.held && (e.state === "batch-checking" || e.state === "in-batch")));
    if (keep.length < members.length) return supersede(b, keep, "a PR in the batch changed or is no longer ready");
    if (b.state === "open") return land(b, members, q);
    if (b.state === "checking" && b.build_state === "pending") {
      if (await featureOn(db, "batch-build", repo)) return readBuild(b, members);
      // The switch went off while the build was in flight: the PR opens without it.
      await cancelBuild(db, b, ACTOR);
      await skipBuild(b, "Build batches was switched off");
      return publish(await getBatch(db, b.id), members);
    }
    // A checking batch has no PR yet: its push or PR creation failed earlier, so it is tried again once the wait is over.
    if (d.now().getTime() - Date.parse(b.updated_at) < publishDelayMs(b.retries)) { s.waiting.push(b.branch); return; }
    return publish(b, members);
  }

  for (const b of await myBatches()) await advance(b.id);
  // A batch in a repo that is off only through fast track loses its place when a mark is removed: it is only closed, never advanced.
  for (const b of await filterSeq((await activeBatches(db, repo)), async (x) => !await mine(x))) await supersede(b, [], "a PR in the batch is no longer fast-tracked and the repo's pipeline is off");

  if (!(await myBatches()).length && (params.limit === undefined || params.limit > 0)) {
    const scores = await workScores(db, repo);
    // PRs in a repo Verify cannot build, or with no CI for a batch PR to wait on, are left to the single-PR merge (the plan's merge action is not batchable).
    const ranked = (await planned(db, "merge", { repo })).filter((p) => p.action.params?.batchable)
      .sort((a, b) => (scores.get(b.facts.number) ?? -1) - (scores.get(a.facts.number) ?? -1) || a.facts.number - b.facts.number)
      .map((p): Cand => ({ number: p.facts.number, head: p.action.head!, size: p.facts.size, lines: p.facts.lines }));
    if (ranked.length) {
      const max = Math.min(await batchSizeOf(db, repo), params.limit ?? Infinity);
      log(`merge ${repo}: ${ranked.length} PRs may merge; batch of up to ${max}`);
      await startBatch(ranked, max, null);
    }
  }
  log(`merge ${repo}: ${s.merged.length} merged, ${s.started.length} batches started, ${s.published.length} opened, ${s.split.length} split, ${s.superseded.length} rebuilt, ${s.waiting.length} waiting; run ${runId}`);
  return s;
}

export const commands = {
  "merge-batches": {
    summary: "merge-batches --repo R [--limit N]: advance the repo's integration batches and start the next one (needs merge approval)",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo"), l = args.indexOf("--limit");
      if (i < 0 || !args[i + 1]) throw new Error("missing --repo");
      const { connect } = await import("../db.ts");
      await runBatches(await openDb(), { repo: args[i + 1]!, ...(l >= 0 ? { limit: Number(args[l + 1]) } : {}) });
    },
  },
};

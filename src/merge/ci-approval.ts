// Approves the Actions runs that GitHub holds for approval (`action_required`) on pull requests from outside
// contributors, once the current head has a final take or take-fix review: the review read that code, and the
// runs use GitHub's runners. The checks sync records the waiting runs per PR head from the check suites in its
// query (recordRuns); a merge refused for `action_required` marks the head for a read of its runs (markReread).
// The ci-approve step approves them (approveRuns) for repos an operator approved. Set only from the dashboard
// (src/dash/api/admin.ts).
import { jobItem } from "../runner/job-items.ts";
import { MAX_FAILURES } from "../core/rules.ts";
import { effectiveCi } from "../optional-checks.ts";
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { Exec } from "../fixup/git.ts";
import { guard } from "../core/guard.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { ghApproveRun, type Writer } from "../github/write.ts";
import { trackedNames } from "../repos.ts";
import type { Gh } from "./safe-merge.ts";
import { slugOf } from "../owners.ts";
import { repoStepApproval, setStepApproval } from "../data/control/index.ts";
import type { StepApproval } from "../data/control/types.ts";
import { loadChecks } from "../data/mirror/index.ts";
import { loadRunApprovals, markRereads, recordRuns as saveRuns, saveRunResults } from "../data/merge/index.ts";
import type { RunsInput, Suite, WaitingRun } from "../data/merge/types.ts";
import { mergeHeld } from "./holds.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

export type CiApproval = StepApproval;
export type { Suite, WaitingRun };

export async function ciApprovalOf(db: Db, repo: string): Promise<CiApproval | null> {
  return await repoStepApproval(db, repo, "ci");
}

// Returns false when nothing changed.
export async function setCiApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "ci", on: approved }], by) > 0;
}

/** The stage's audit login. */
export const ACTOR = "ci-approve";
/** Approval attempts per run before the PR is left to a person. */
export { MAX_FAILURES };
/** Refusals by GitHub that repeat when asked again; other errors (network, 5xx) are retried without counting. */
const REPEATABLE = /HTTP (403|422)/;

const headOf = (repo: string, number: number, head: string): string => `${repo}#${number}@${head}`;

/** Records the workflow runs waiting for approval at each open PR's head, from the check suites the sync read. */
export async function recordRuns(db: Db, rows: readonly RunsInput[], at = new Date().toISOString()): Promise<void> {
  await saveRuns(db, [...rows], at);
}

/** A merge was refused because of `action_required` runs the sync does not list: the step reads that head's runs. */
export async function markReread(db: Db, repo: string, number: number, head: string, at = new Date().toISOString()): Promise<void> {
  await markRereads(db, [{ repo, number, head }], at);
}

/** `overall` as CI reads for the PR's head, with failures of the repo's optional checks left out (effectiveOverall): "pending" while runs wait for approval or the ones we approved have not finished, since the check rollup does not list them. */
export async function overallAt(db: Db, repo: string, number: number, head: string, overall: string): Promise<string> {
  const ref = [{ repo, number }];
  const [checks, runs] = await db.together(() => Promise.all([
    overall === "failure" ? loadChecks(db, ref) : Promise.resolve(null),
    loadRunApprovals(db, ref),
  ]));
  const row = checks?.get(`${repo}#${number}`);
  const eff = overall === "failure" ? await effectiveCi(db, repo, overall, row?.head_oid === head ? row.checks : undefined) : overall;
  const r = runs.get(headOf(repo, number, head));
  if (!r) return eff;
  return r.reread || r.runs.length || r.approved.length ? "pending" : eff;
}

export type Candidate = { number: number; head: string; runs: WaitingRun[]; reread: boolean; failed: Record<string, number>; crossRepo: boolean };

/**
 * The candidates the step has work on (approvable runs of a fork PR, or a head to read): the PRs whose Plan holds an `approve-ci` action: reviewed PRs of the repo with runs waiting at the reviewed head, and open integration
 * batch PRs with runs waiting at the batch tip (their code is the members' code, and every member is reviewed at the head it was batched at).
 * The runs are read from the recorded row at the action's head.
 */
export async function needsWork(db: Db, repo: string, run?: string | null, plans?: PlanSet): Promise<Candidate[]> {
  const due = await planned(db, "approve-ci", { repo, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) });
  const rows = await loadRunApprovals(db, due.map((p) => ({ repo, number: p.facts.number })));
  const out: Candidate[] = [];
  for (const { facts, action } of due) {
    const a = rows.get(headOf(repo, facts.number, action.head!));
    if (!a) continue;
    out.push({ number: facts.number, head: action.head!, runs: a.runs, reread: a.reread, failed: a.failed, crossRepo: a.crossRepo });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** The repos the step has work in, from a pass's Plans. */
export async function ciApproveRepos(db: Db, plans: PlanSet, run: string | null): Promise<Set<string>> {
  const due = await planned(db, "approve-ci", { run, plans });
  const rows = await loadRunApprovals(db, due.map((p) => ({ repo: p.facts.repo, number: p.facts.number })));
  return new Set(due.filter((p) => rows.has(headOf(p.facts.repo, p.facts.number, p.action.head!))).map((p) => p.facts.repo));
}

/** Runs of a candidate the step may still try: pull_request runs with fewer than MAX_FAILURES failed attempts. */
export const approvable = (c: Candidate): WaitingRun[] => c.runs.filter((r) => r.event === "pull_request" && (c.failed[r.id] ?? 0) < MAX_FAILURES);

type RunsReply = { workflow_runs?: { id: number; name?: string | null; event?: string; head_sha?: string; head_repository?: { full_name?: string } | null; repository?: { full_name?: string } | null }[] };

/** Reads the runs waiting for approval at a head (one request); only runs of a fork's PR count. */
async function readRuns(gh: Gh, repo: string, head: string): Promise<WaitingRun[]> {
  const r = JSON.parse(await gh(["api", `repos/${slugOf(repo)}/actions/runs?head_sha=${head}&status=action_required&per_page=100`])) as RunsReply;
  return (r.workflow_runs ?? []).filter((w) => w.head_sha === head && w.head_repository?.full_name !== w.repository?.full_name)
    .map((w) => ({ id: w.id, name: w.name ?? "", event: w.event ?? "" }));
}

export type ApproveDeps = {
  /** Reads from GitHub (`gh api` arguments). */
  gh: Gh;
  /** Runs the approving write. */
  exec: Exec;
  /** Most PRs to approve runs for. */
  limit: number;
  log?: (line: string) => void;
  /** Who asked; a command-line run is an operator's. */
  by?: By;
};
export type ApproveResult = { approved: string[]; skipped: string[]; failed: string[] };

/** Approves the waiting runs of every candidate whose PR is still open, not a draft, a fork's, and at the reviewed head. */
export async function approveRuns(db: Db, repo: string, d: ApproveDeps): Promise<ApproveResult> {
  const log = d.log ?? (() => {});
  const w: Writer = { db, login: ACTOR };
  const out: ApproveResult = { approved: [], skipped: [], failed: [] };
  const save = async (c: Candidate, runs: WaitingRun[], approved: number[], failed: Record<string, number>): Promise<void> =>
    await saveRunResults(db, [{ key: headOf(repo, c.number, c.head), runs, approved, failed, approvedNow: approved.length > 0 }]);
  for (const c of await needsWork(db, repo)) {
    if (out.approved.length + out.failed.length >= d.limit) break;
    if (!await ciApprovalOf(db, repo)) throw new Error(`approving CI runs in ${repo} is not approved`);
    if (await mergeHeld(db, repo, c.number)) continue;
    const ref = `${repo}#${c.number}`;
    let runs = c.runs;
    let pr: { state?: string; draft?: boolean; head?: { sha?: string; repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } | null } };
    try {
      if (c.reread) runs = await readRuns(d.gh, repo, c.head);
      pr = JSON.parse(await d.gh(["api", `repos/${slugOf(repo)}/pulls/${c.number}`]));
    } catch (e) {
      await jobItem(db, repo, c.number, `CI runs not read: ${(e as Error).message}`, log);
      out.failed.push(ref);
      continue;
    }
    const sameRepo = !pr.head?.repo || pr.head.repo.full_name === pr.base?.repo?.full_name;
    if (pr.state !== "open" || pr.draft !== false || pr.head?.sha !== c.head || sameRepo) {
      await jobItem(db, repo, c.number, "CI runs skipped: closed, a draft, at another head or not from a fork", log);
      if (c.reread) await save(c, c.runs, [], c.failed);
      out.skipped.push(ref);
      continue;
    }
    const todo = runs.filter((r) => r.event === "pull_request" && (c.failed[r.id] ?? 0) < MAX_FAILURES);
    const failed = { ...c.failed };
    const done: number[] = [];
    let stopped: string | null = null;
    for (const run of todo) {
      if (!await ciApprovalOf(db, repo)) throw new Error(`approving CI runs in ${repo} is not approved`);
      const g = await guard(db, { repo, number: c.number }, { kind: "approve-ci", head: c.head }, d.by ?? CLI_BY);
      if ("refused" in g) { stopped = g.refused; break; }
      const r = await ghApproveRun(w, d.exec, g, run.id, { head: c.head, workflow: run.name });
      if (r.code === 0) done.push(run.id);
      else if (REPEATABLE.test(`${r.stderr} ${r.stdout}`)) failed[run.id] = (failed[run.id] ?? 0) + 1;
      else log(`${ref}: run ${run.id}: ${(r.stderr || r.stdout).trim().slice(0, 120)}; will retry`);
    }
    await save(c, runs.filter((r) => !done.includes(r.id)), done, failed);
    if (stopped !== null) { await jobItem(db, repo, c.number, `CI runs not approved: ${stopped}`, log); out.skipped.push(ref); continue; }
    const bad = todo.length - done.length;
    (bad ? out.failed : out.approved).push(ref);
    await jobItem(db, repo, c.number, bad ? `${bad} of ${todo.length} CI runs not approved` : `approved ${todo.length} CI run${todo.length === 1 ? "" : "s"}`, log);
  }
  return out;
}

export const commands = {
  "ci-approval": {
    summary: "ci-approval [--repo R] [on|off]: whether the pipeline may approve waiting CI runs of reviewed outside PRs, per tracked repo; on or off with --repo sets it",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      const i = args.indexOf("--repo");
      const set = args.find((a) => a === "on" || a === "off");
      if (set) {
        const repo = i >= 0 ? args[i + 1] ?? "" : "";
        if (!repo) throw new Error("ci-approval --repo R on|off");
        console.log(await setCiApproval(db, "cli", repo, set === "on") ? `${repo}: CI run approval ${set}` : `${repo}: CI run approval was already ${set}`);
        return;
      }
      for (const repo of i >= 0 ? [args[i + 1] ?? ""] : await trackedNames(db)) {
        const a = await ciApprovalOf(db, repo);
        console.log(`${repo}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};

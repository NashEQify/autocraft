// The build bucket of the `implement` step: from a stored plan to a change that passes AutoCraft's checks, then the PR.
// A job does one unit and stores where it got: a session turn (state implementing, or fixing for a follow-up) and, when
// time allows, the checks after it (checking); clean checks hand the attempt to the PR step (opening). Findings go back to
// the same session, FOLLOW_UP_ROUNDS times at most; a follow-up its Task Runner no longer takes starts a fresh session on the
// changes. Anything that cannot go on makes the attempt stuck (stuck.ts). A job that resumes picks up the call or step it
// was in; checks just run again.
import type { Db } from "../db/index.ts";
import { createWorkspace, getWorkspace, LIVE_STATES, resumeWorkspace, type WorkspaceStateName } from "../build/workspaces.ts";
import { READY_LIMIT_MS } from "../build/workspace-launch.ts";
import { roundDir, runChecks, workspacePod, type CheckRound, type Pod } from "./checks.ts";
import { awaitTurn, findingsMessage, lintedReport, needsDependency, queueTurn, realCalls, REPORT_MESSAGE, renderSession, retryStdin, sessionInput, type CallDeps, type TurnPurpose, type TurnRound } from "./session.ts";
import { applyStuckAnswer, markStuck, noDiffCheck, opensAsDraft, type DiffCheck, type StuckCause } from "./stuck.ts";
import { addRound, currentImplementation, implementationById, roundsOf, setImplementationState, updateImplementation } from "./store.ts";
import { BUILD_STATES, type Implementation, type ImplementationRound } from "./types.ts";

/** Follow-up turns with the checks' findings before the attempt is stuck (D6). */
export const FOLLOW_UP_ROUNDS = 3;
/** Model calls one job makes at most: a turn, its report or lint follow-up, and a fresh session. */
const TURNS_PER_JOB = 4;
/** A job that has run this long ends after its turn; the next job runs the checks, so a long session and its checks do not share one job's time limit. */
const CHECKS_IN_SAME_JOB_MS = 60 * 60_000;
/** A workspace made again for an attempt whose workspace was lost. */
const WORKSPACE_DEADLINE_SEC = 12 * 3600;
/** Consecutive PR attempts that failed in a way a later run may fix before the attempt is stuck. */
const PUSH_FAILURES_MAX = 3;
const READY_POLL_MS = 3000;
const SHA = /^[0-9a-f]{40}$/;

/** What a build job needs from its context; StepContext has it. */
export type BuildRun = {
  db: Db;
  log(line: string): void;
  progress(text: string): Promise<void>;
  cancelled(): Promise<boolean>;
  stopping(): Promise<boolean>;
  /** When the job started (ms). */
  startedMs: number;
  /** Stop at `opening`: nothing goes to GitHub (the CLI's --no-pr). */
  noPr?: boolean;
};

export type OpenPr = (run: BuildRun, impl: Implementation, o: { draft: boolean; checks: CheckRound }) =>
  Promise<{ ok: true; url: string } | { ok: false; reason: string; retry: boolean; problems?: string[] }>;

export type BuildDeps = {
  calls: CallDeps;
  pod(db: Db, workspaceId: number, cancelled: () => Promise<boolean>): Pod;
  /** Whether the change passes the PR step's diff check, for the stuck decision's Open as draft PR. */
  diffCheck: DiffCheck;
  /** Opens the PR (the PR step). Absent: a clean attempt waits in `opening`. */
  openPr?: OpenPr;
};

export const defaultBuildDeps = (): BuildDeps => ({ calls: realCalls, pod: workspacePod, diffCheck: noDiffCheck });

const ref = (i: Implementation): string => `${i.repo}#${i.number}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const turnsOf = (rounds: ImplementationRound[]) => rounds.filter((r) => r.kind === "session" || r.kind === "follow-up");
const checksOf = (rounds: ImplementationRound[]) => rounds.filter((r) => r.kind === "checks").map((r) => r.result as CheckRound);
const turnResult = (r: ImplementationRound): TurnRound => r.result as TurnRound;

class Stuck extends Error {
  cause_: StuckCause;
  constructor(cause: StuckCause, detail: string) {
    super(detail);
    this.cause_ = cause;
  }
}

/** Waits for the attempt's workspace to be ready, making it again (once) when it is gone. `fresh`: the tree holds none of the attempt's changes. */
async function readyWorkspace(run: BuildRun, impl: Implementation): Promise<{ wsId: number; base: string; fresh: boolean }> {
  const db = run.db;
  const make = async (envId: string): Promise<number> => {
    if (!impl.baseSha) throw new Stuck("workspace-lost", "the attempt has no base commit");
    return await db.write(async () => {
      const id = await createWorkspace(db, { repo: impl.repo, baseSha: impl.baseSha!, envId, limits: { deadlineSec: WORKSPACE_DEADLINE_SEC }, owner: `implementation ${impl.id}` });
      await updateImplementation(db, impl.id, { workspaceId: id });
      return id;
    });
  };
  const envOf = async (wsId: number | null): Promise<string> => (wsId !== null ? (await getWorkspace(db, wsId))?.env_id : undefined)
    ?? (await db.get(db.k.selectFrom("build_envs").select("id").where("kind", "=", "kubernetes").where("enabled", "=", 1).orderBy("id").limit(1)))?.id
    ?? (() => { throw new Stuck("workspace-lost", "no kubernetes environment is set up for workspaces"); })();
  let wsId = impl.workspaceId, fresh = false, remade = false;
  const live = async (id: number | null) => id !== null && LIVE_STATES.includes((await getWorkspace(db, id))?.state as WorkspaceStateName);
  if (!await live(wsId)) {
    wsId = await make(await envOf(wsId));
    fresh = remade = true;
    run.log(`workspace ${wsId} requested: the attempt's workspace was gone`);
  }
  for (let from = Date.now(), last = "";;) {
    const w = await getWorkspace(db, wsId!);
    let gone: string | null = null;
    if (!w) gone = "is gone";
    else if (w.state === "ready") return { wsId: wsId!, base: w.base_commit && SHA.test(w.base_commit) ? w.base_commit : impl.baseSha ?? w.base_sha, fresh };
    else if (w.state === "parked" && !await resumeWorkspace(db, wsId!)) gone = `is parked and could not be resumed${w.error ? `: ${w.error}` : ""}`;
    else if (!LIVE_STATES.includes(w.state as WorkspaceStateName)) gone = `is ${w.state}${w.error ? `: ${w.error}` : ""}`;
    else if (Date.now() - from > READY_LIMIT_MS) gone = `was not ready within ${Math.round(READY_LIMIT_MS / 60_000)} min`;
    if (gone) {
      if (remade) throw new Stuck("workspace-lost", `workspace ${wsId} ${gone}`);
      run.log(`workspace ${wsId} ${gone}; requesting a new one`);
      wsId = await make(await envOf(wsId));
      fresh = remade = true;
      from = Date.now();
      continue;
    }
    if (await run.cancelled()) throw new Error("cancelled while the workspace started");
    if (w!.state !== last) {
      last = w!.state;
      await run.progress(`${ref(impl)}: workspace ${wsId} ${last}`);
    }
    await sleep(READY_POLL_MS);
  }
}

/** The call of the attempt's last turn when it is still to be read: queued, leased, or answered and unread. */
async function pendingCall(db: Db, impl: Implementation, rounds: ImplementationRound[]): Promise<number | null> {
  const id = impl.sessionCallId;
  if (id === null || rounds.some((r) => r.callId === id)) return null;
  const c = await db.get(db.k.selectFrom("main.remote_calls").select(["state", "consumed_at"]).where("id", "=", id));
  return c && (c.state === "queued" || c.state === "leased" || (c.state === "done" && c.consumed_at === null)) ? id : null;
}

/** The last checks round's findings and a refusal after it, for a follow-up turn. */
function fixingMessage(rounds: ImplementationRound[]): string {
  const lastChecks = rounds.map((r) => r.kind).lastIndexOf("checks");
  const refusal = rounds.slice(lastChecks + 1).reverse().find((r) => r.kind === "refusal" && (r.result as { kind?: string })?.kind === "diff");
  if (refusal) {
    const problems = ((refusal.result as { problems?: string[] }).problems ?? []).slice(0, 30);
    return `These changes cannot go into the pull request:\n${problems.map((p) => `- ${p}`).join("\n")}\nUndo them, keep the rest of your work, run the checks again, and reply with the JSON report as before.`;
  }
  const c = lastChecks >= 0 ? rounds[lastChecks]!.result as CheckRound : null;
  return findingsMessage(c?.findings ?? []);
}

/** The session's turns for this unit, until one ends in a report (then checking) or the attempt is stuck. */
async function turnPhase(run: BuildRun, deps: BuildDeps, impl: Implementation, ws: { wsId: number; base: string }, pod: Pod): Promise<Implementation> {
  const db = run.db;
  for (let n = 0; n < TURNS_PER_JOB; n++) {
    const rounds = await roundsOf(db, impl.id);
    const turns = turnsOf(rounds);
    const last = turns.at(-1);
    let callId = await pendingCall(db, impl, rounds), purpose: TurnPurpose, follow = false;
    if (callId !== null) {
      purpose = impl.state === "fixing" ? "findings" : "start";
      follow = (await db.get(db.k.selectFrom("main.remote_calls").select("parent_id").where("id", "=", callId)))?.parent_id != null;
      run.log(`${ref(impl)}: waiting for turn ${callId} of the run before`);
    } else {
      if (n > 0 && await run.stopping()) return impl;
      const input = async (earlier?: Parameters<typeof sessionInput>[3]) => renderSession(await sessionInput(db, impl, ws.base, earlier)).stdin;
      const lastDone = [...turns].reverse().find((r) => turnResult(r).outcome === "done" && turnResult(r).report !== null);
      let stdin: string, parentId: number | undefined;
      if (last && turnResult(last).outcome === "failed" && last.kind === "session") {
        purpose = "retry";
        stdin = await retryStdin(db, last.callId!, await input());
      } else if (last && (turnResult(last).outcome === "unclaimed" || turnResult(last).outcome === "failed")) {
        // The follow-up's harness session is gone with its Task Runner, or the follow-up failed: a fresh session on the changes, with what the checks found.
        const c = checksOf(rounds).at(-1);
        purpose = "fresh";
        stdin = await input({ diff_stat: c?.diffStat ?? "", findings: c?.findings ?? [] });
      } else if (last && turnResult(last).outcome === "done" && !turnResult(last).report && turnResult(last).purpose !== "lint") {
        purpose = "report";
        stdin = REPORT_MESSAGE;
        parentId = last.callId!;
      } else if (impl.state === "fixing" && lastDone) {
        purpose = "findings";
        stdin = fixingMessage(rounds);
        parentId = lastDone.callId!;
      } else {
        purpose = "start";
        stdin = await input();
      }
      follow = parentId !== undefined;
      callId = await queueTurn(db, deps.calls, { impl, workspaceId: ws.wsId, purpose, stdin, ...(follow && { parentId }) });
      await setImplementationState(db, impl.id, impl.state === "fixing" ? "fixing" : "implementing", { sessionCallId: callId });
      impl = (await implementationById(db, impl.id))!;
      run.log(`${ref(impl)}: turn ${callId} (${purpose}) queued for ${impl.queuedBy}'s Task Runner${follow ? `, on the session of call ${parentId}` : ""}`);
    }
    await run.progress(`${ref(impl)}: session turn ${callId} (${purpose})`);
    const r = await awaitTurn(db, deps.calls, pod, { impl, workspaceId: ws.wsId, callId, purpose, follow, log: run.log });
    if (r.outcome === "failed") {
      const failed = [...turnsOf(await roundsOf(db, impl.id))].reverse();
      const streak = failed.findIndex((x) => turnResult(x).outcome !== "failed");
      if ((streak < 0 ? failed.length : streak) >= 2) throw new Stuck("session-failed", r.error ?? "the call failed");
      continue;
    }
    if (r.outcome === "unclaimed") continue;
    if (!r.report) {
      if (purpose === "report") throw new Stuck("no-report", r.parseError ?? "no report");
      continue;
    }
    if (r.report.status === "blocked") {
      await updateImplementation(db, impl.id, { report: r.report });
      throw needsDependency(r.report) ? new Stuck("needs-dependency", r.report.blocked_reason ?? "") : new Stuck("blocked", r.report.blocked_reason ?? "");
    }
    const linted = await lintedReport(db, deps.calls, { impl, workspaceId: ws.wsId, callId, report: r.report, log: run.log });
    await setImplementationState(db, impl.id, "checking", { report: linted.report, sessionCallId: linted.callId });
    return (await implementationById(db, impl.id))!;
  }
  run.log(`${ref(impl)}: ${TURNS_PER_JOB} turns in this job; the next job goes on`);
  return impl;
}

/** Runs the checks and moves the attempt on: to opening when clean, fixing with findings, or stuck. */
async function checksPhase(run: BuildRun, impl: Implementation, ws: { base: string }, pod: Pod): Promise<{ impl: Implementation; line: string }> {
  const db = run.db;
  const done = checksOf(await roundsOf(db, impl.id));
  const round = done.length + 1;
  await run.progress(`${ref(impl)}: checks, round ${round}`);
  const c = await runChecks(pod, { dir: roundDir(impl.id, round), base: ws.base, round });
  await addRound(db, impl.id, "checks", { result: c });
  await updateImplementation(db, impl.id, { diffStat: c.diffStat });
  run.log(`${ref(impl)}: checks round ${round}: ${c.diffStat}; ${c.findings.length} findings${c.notes.length ? `; ${c.notes.join("; ")}` : ""}`);
  if (c.needsDependency) throw new Stuck("needs-dependency", "cargo could not resolve a dependency offline");
  if (c.clean) {
    if (c.diffStat === "no changes") throw new Stuck("no-change", "");
    await setImplementationState(db, impl.id, "opening");
    return { impl: (await implementationById(db, impl.id))!, line: `checks clean (${c.diffStat})` };
  }
  const failing = [...done, c].filter((x) => !x.clean).length;
  if (failing > FOLLOW_UP_ROUNDS) throw new Stuck("checks-failing", `${c.findings.length} findings, first: ${c.findings[0]?.message ?? ""}`);
  await setImplementationState(db, impl.id, "fixing");
  return { impl: (await implementationById(db, impl.id))!, line: `checks round ${round}: ${c.findings.length} findings; a follow-up turn is next` };
}

/** Hands a clean attempt to the PR step. */
async function openingPhase(run: BuildRun, deps: BuildDeps, impl: Implementation): Promise<string> {
  const db = run.db;
  if (run.noPr) return "ready for its PR; not opened (--no-pr)";
  if (!deps.openPr) return "ready for its PR; opening it is not available, so it waits";
  const rounds = await roundsOf(db, impl.id);
  const checks = checksOf(rounds).at(-1);
  if (!checks?.clean) throw new Stuck("checks-failing", "the attempt reached the PR step without clean checks");
  const r = await deps.openPr(run, impl, { draft: await opensAsDraft(db, impl), checks });
  if (r.ok) return `PR ${r.url}`;
  if (r.problems?.length) {
    // One turn to undo what the diff check refused (D7); a second refusal is stuck.
    if (rounds.some((x) => x.kind === "refusal" && (x.result as { kind?: string })?.kind === "diff")) throw new Stuck("diff-refused", r.problems.slice(0, 3).join("; "));
    await addRound(db, impl.id, "refusal", { result: { kind: "diff", reason: r.reason, problems: r.problems } });
    await setImplementationState(db, impl.id, "fixing");
    return `the diff check refused the change (${r.reason}); an undo turn is next`;
  }
  if (r.retry) {
    await addRound(db, impl.id, "refusal", { result: { kind: "push", reason: r.reason } });
    const tail = [...(await roundsOf(db, impl.id))].reverse();
    const streak = tail.findIndex((x) => !(x.kind === "refusal" && (x.result as { kind?: string })?.kind === "push"));
    if ((streak < 0 ? tail.length : streak) >= PUSH_FAILURES_MAX) throw new Stuck("push-failed", r.reason);
    return `the PR was not opened (${r.reason}); the next run tries again`;
  }
  if (/issue is closed/.test(r.reason)) {
    await setImplementationState(db, impl.id, "closed", { reason: r.reason });
    return r.reason;
  }
  throw new Stuck("push-failed", r.reason);
}

/** One unit of the build bucket for the issue's current attempt: the job's summary line, and whether anything moved. */
export async function runBuild(run: BuildRun, repo: string, number: number, deps: BuildDeps = defaultBuildDeps()): Promise<{ summary: string; moved: boolean }> {
  const before = await currentImplementation(run.db, repo, number);
  const summary = await buildUnit(run, repo, number, deps);
  const after = before ? await implementationById(run.db, before.id) : null;
  const moved = !!before && (after?.state !== before.state || after?.updatedAt !== before.updatedAt);
  return { summary, moved };
}

async function buildUnit(run: BuildRun, repo: string, number: number, deps: BuildDeps): Promise<string> {
  const db = run.db;
  let impl = await currentImplementation(db, repo, number);
  if (!impl) return `${repo}#${number}: no current implementation`;
  try {
    if (impl.state === "stuck") {
      const o = await applyStuckAnswer(db, impl);
      return `${ref(impl)}: ${o ? o.did : "stuck; no answer to carry out"}`;
    }
    if (!BUILD_STATES.has(impl.state)) return `${ref(impl)}: ${impl.state}; nothing to build`;
    if (!impl.plan) throw new Stuck("plan-unparseable", "the attempt has no stored plan");
    if (impl.state === "opening") return `${ref(impl)}: ${await openingPhase(run, deps, impl)}`;
    const ws = await readyWorkspace(run, impl);
    if (ws.fresh && impl.state !== "planned") {
      run.log(`${ref(impl)}: the new workspace holds none of the earlier changes; the session starts over from the plan`);
      await setImplementationState(db, impl.id, "planned", { sessionCallId: null });
    }
    impl = (await implementationById(db, impl.id))!;
    const pod = deps.pod(db, ws.wsId, run.cancelled);
    if (impl.state !== "checking") {
      impl = await turnPhase(run, deps, impl, ws, pod);
      if (impl.state !== "checking") return `${ref(impl)}: ${impl.state}; the next job goes on`;
      if (Date.now() - run.startedMs > CHECKS_IN_SAME_JOB_MS || await run.stopping()) return `${ref(impl)}: the session reported ${impl.report?.status}; the checks run in the next job`;
    }
    const c = await checksPhase(run, impl, ws, pod);
    if (c.impl.state !== "opening") return `${ref(impl)}: ${c.line}`;
    return `${ref(impl)}: ${c.line}; ${await openingPhase(run, deps, c.impl)}`;
  } catch (e) {
    if (!(e instanceof Stuck)) throw e;
    const now = (await implementationById(db, impl.id))!;
    const id = await markStuck(db, now, e.cause_, e.message || null, { diffCheck: deps.diffCheck });
    return `${ref(impl)}: stuck (${e.cause_}${e.message ? `: ${e.message}` : ""}); decision ${id}`;
  }
}

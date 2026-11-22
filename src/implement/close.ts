// Closing a queued issue on a maintainer's answer: Close on the question-limit decision (plan.ts) and Close issue on the
// stuck decision (stuck.ts); and closing our implementation PR on Close PR of a stuck revision's decision. It follows Act's closes (act/index.ts): the answer must still stand (not taken back, applied
// or disputed) and not wait for its person's sign-in or access; the comment goes out as the bot and, under the app
// identity, the close as the person who answered (laneForDecision). Both writes go through write.ts.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { githubWide, readLive } from "../act/index.ts";
import { endWorkspace } from "../build/workspaces.ts";
import { guardItem, guardRepo } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { getDecision } from "../decisions.ts";
import { closeItem, commentOn, type Writer } from "../github/write.ts";
import { authFailure, isWaiting, laneForDecision, markExecDone, noWriteReason, setExecState, SIGN_IN_REASON, type LaneDeps } from "../github/user-lane.ts";
import { Client, type Querier } from "../mirror.ts";
import { IMPLEMENT_ASKER } from "./questions.ts";
import { setImplementationState } from "./store.ts";
import type { Implementation } from "./types.ts";

const COMMENT_ACTION = "implement-close-comment";

export type CloseDeps = {
  /** GitHub reads and the close where every repo is on the box account (tests replace it). */
  querier?: Querier;
  lane?: LaneDeps;
  /** Writer overrides (tests). */
  writer?: Omit<Writer, "db" | "login">;
  /** The job's actor, for the guard; default the pipeline. */
  by?: By;
  now?: () => string;
};

/**
 * `done`: the issue is closed (or was already), the answer applied and the attempt cancelled. `waiting`: nothing was
 * written and the answer stays; the planner leaves it until what it waits for clears (the decision's exec_state, a taken
 * back or disputed answer). `refused`: it cannot be carried out as it stands (no comment approval, a write GitHub refused);
 * the caller asks again with the reason. A failure of GitHub or the network throws: the job fails and is retried later.
 */
export type CloseOutcome = { done: string } | { waiting: string } | { refused: string };

/** The decision still carries `answer`: not undone, applied, disputed or answered differently. */
async function answerStands(db: Db, id: string, answer: string): Promise<boolean> {
  const d = await getDecision(db, id);
  return !!d && d.answer === answer && !d.applied_at && d.exec_state !== "disputed";
}

/** Whether the comment for this answer was posted already (a close that failed after it is retried without a second comment). */
async function commentedFor(db: Db, ref: string, id: string, since: string): Promise<boolean> {
  const rows = await db.all(db.k.selectFrom("audit").select("details").where("action", "=", COMMENT_ACTION).where("target", "=", ref).where("at", ">=", since));
  return rows.some((r) => {
    try {
      const d = JSON.parse(r.details ?? "{}") as { decision?: unknown; state?: unknown };
      return d.decision === id && d.state === "done";
    } catch { return false; }
  });
}

/**
 * Carries out a close answer on the attempt's issue: `comment` as the bot, then the issue closed as not planned. `bucket` is
 * the implement bucket the planner gives the attempt while the answer stands (the guard checks it on the issue). With `pr`,
 * the attempt's PR is commented on and closed instead, under a repo grant once the issue's guard holds; the attempt then ends
 * `closed` with its PR, and its workspace is ended, and the issue stays open.
 */
export async function closeOnAnswer(db: Db, impl: Implementation, o: { decisionId: string; answer: string; bucket: "plan" | "build"; comment: string; pr?: number }, deps: CloseDeps = {}): Promise<CloseOutcome> {
  const target = o.pr ?? impl.number;
  const ref = `${impl.repo}#${target}`, id = o.decisionId;
  if (!await answerStands(db, id, o.answer)) return { waiting: "the answer was taken back or disputed" };
  if (await isWaiting(db, id)) return { waiting: "the answer waits for its person's sign-in or access" };
  if (!await commentApprovalOf(db, impl.repo)) return { refused: `commenting in ${impl.repo} is not approved, so ${ref} was not closed` };
  const lr = await laneForDecision(db, deps.lane, id, [impl.repo]);
  if (lr && !("lane" in lr)) {
    // A token that cannot be refreshed now: the job fails and its registered backoff spaces the tries.
    if ("transient" in lr) throw new Error(`${ref} not closed yet: ${lr.transient}`);
    await setExecState(db, id, lr.state, lr.reason);
    return { waiting: lr.reason };
  }
  const gi = await guardItem(db, { repo: impl.repo, number: impl.number }, { kind: "implement", bucket: o.bucket }, deps.by ?? "pipeline", id);
  if ("refused" in gi) return { waiting: `not closed: ${gi.refused}` };
  const gr = o.pr === undefined ? gi : await guardRepo(db, impl.repo, "comment", deps.by ?? "pipeline", id);
  if ("refused" in gr) return { waiting: `not closed: ${gr.refused}` };
  const g = gr;
  if (lr) await setExecState(db, id, "pending");
  const q = lr ? lr.lane.querier : deps.querier ?? new Client(500);
  const w: Writer = { db, login: IMPLEMENT_ASKER, ...deps.writer };
  const answeredAt = (await getDecision(db, id))?.answered_at ?? "";
  let already = false;
  try {
    const live = await readLive(q, impl.repo, target);
    if (!live) return { refused: `GitHub returned no item ${ref}` };
    already = live.state !== "OPEN";
    if (!already) {
      if (!await commentedFor(db, ref, id, answeredAt)) {
        await commentOn(w, g, q, COMMENT_ACTION, { repo: impl.repo, number: target, id: live.id }, { by: "fixed-operator" }, o.comment, { decision: id });
      }
      // Read again after the comment: an answer taken back or disputed meanwhile stops the close.
      if (!await answerStands(db, id, o.answer)) return { waiting: "the answer was taken back or disputed" };
      await closeItem(w, g, q, { repo: impl.repo, number: target, id: live.id, pr: live.type === "PullRequest" }, { decision: id }, "NOT_PLANNED");
    }
  } catch (e) {
    const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
    const denied = lr ? authFailure(e) : null;
    // GitHub or the network failing says nothing about this answer: the job fails and its registered backoff spaces the tries.
    if (denied === "transient" || (!denied && githubWide(e))) throw e;
    if (denied) {
      await setExecState(db, id, denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(impl.repo));
      return { waiting: why };
    }
    if (lr) await setExecState(db, id, "failed", why);
    return { refused: `closing ${ref} failed: ${why}` };
  }
  const at = deps.now?.() ?? new Date().toISOString();
  const d = await getDecision(db, id);
  await db.write(async () => {
    await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", id).where("applied_at", "is", null));
    const what = o.pr === undefined ? "the issue" : `PR #${o.pr}`;
    await setImplementationState(db, impl.id, o.pr === undefined ? "cancelled" : "closed", { reason: `${already ? `${what} was already closed` : `${what} closed`} on ${d?.answered_by ?? "a maintainer"}'s answer` }, at);
    if (!already) await db.run(db.k.insertInto("main.stages").values({ repo: impl.repo, number: target, stage: "closed", at, actor: IMPLEMENT_ASKER, note: `closed after implement decision ${id}` }));
  });
  if (o.pr !== undefined && impl.workspaceId !== null) await endWorkspace(db, impl.workspaceId);
  await markExecDone(db);
  await audit(db, IMPLEMENT_ASKER, "implement-close", ref, { implementation: impl.id, decision: id, already });
  return { done: already ? `${ref} was already closed on GitHub; the attempt ends` : `${ref}: commented and closed on the answer to ${id}` };
}

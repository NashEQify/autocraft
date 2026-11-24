// Moves each live maintainer workflow on from what the pipeline recorded: its numbered plan from the latest review, a blocker that
// stops an approved item, the one recommendation an unapproved item comes back with when its steps are done, the merge leg of an
// approved PR (the pre-approved merge in src/preapproval, owned through preapprovals.workflow_id, which merges as the approver), and
// the end once the PR merged or closed. The runner runs it on each tick its inputs changed, before the pre-approval pass.
//
// It never asks a question: a person answers the recommendation with a command (apply.ts), and nothing here writes to GitHub.
import type { Db } from "../db/index.ts";
import { decidePr, MAINTAINER_ANSWER_WAIT } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import type { PrFacts } from "../core/plan.ts";
import { currentImplementation } from "../implement/store.ts";
import { cancelPreapproval, PreapprovalRefused, preapproveMerge } from "../preapproval/index.ts";
import type { ReviewFix, ReviewWorkflow } from "../review/opus-parse.ts";
import { withSettingsSnapshot } from "../settings-read.ts";
import { detectBlocker, type BlockerFacts, type Found } from "./blockers.ts";
import { afterSteps, atBlocker, planOf, type ReviewView } from "./recommend.ts";
import { largeFixLines, outsidePurposeMin } from "./settings.ts";
import { addEvent, goOnAt, liveWorkflows, repoWorkflows, updateWorkflow, type WorkflowPatch } from "./store.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "./types.ts";

const ACTOR = "pipeline";
const ACTIVE_LEG = ["fixup", "review", "ci", "queued"];
const ENDED_LEG = ["asked", "cancelled", "failed"];
/** Fix-up and CI fix tries that failed (src/fixup, src/cifix). */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];

/** What changed in a pass, for the Discord alerts and the log. */
export type Moved = { id: number; repo: string; number: number; to: ItemWorkflow["state"] };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** Changed lines of a unified diff. */
export const patchLines = (patch: string | null): number =>
  (patch ?? "").split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;

/** Whether our own pushes (fix-up, CI fix, base merge, implementation revision, autorepin) lead from `from` to `to`. */
async function ownChain(db: Db, repo: string, number: number, from: string, to: string): Promise<boolean> {
  let cur = from;
  for (let i = 0; i < 20 && cur !== to; i++) {
    const next = (await db.get(db.k.selectFrom("main.push_outcomes").select("to_oid as to").where("repo", "=", repo).where("number", "=", number).where("from_oid", "=", cur).orderBy("id", "desc").limit(1)))?.to
      ?? (await db.get(db.k.selectFrom("main.conflict_merges").select("to_head as to").where("repo", "=", repo).where("number", "=", number).where("from_head", "=", cur).where("state", "=", "merged").limit(1)))?.to
      ?? (await db.get(db.k.selectFrom("main.autorepins").select("to_head as to").where("repo", "=", repo).where("number", "=", number).where("head", "=", cur).where("state", "=", "pushed").limit(1)))?.to
      ?? null;
    if (!next || next === cur) return false;
    cur = next;
  }
  return cur === to;
}

type Review = { at: string; verdict: string; sure: boolean; fixes: ReviewFix[]; workflow: ReviewWorkflow | null };

async function reviewAt(db: Db, repo: string, number: number, head: string): Promise<Review | null> {
  const r = await db.get(db.k.selectFrom("main.opus_reviews").select(["at", "verdict", "sure", "fixes", "workflow"]).where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "is not", null));
  return r ? { at: r.at, verdict: r.verdict!, sure: r.sure === 1, fixes: json<ReviewFix[]>(r.fixes, []), workflow: json<ReviewWorkflow | null>(r.workflow, null) } : null;
}

/** Tries of a step on the PR that failed after `since`. */
async function failures(db: Db, repo: string, number: number, since: string): Promise<{ step: string; count: number }[]> {
  const count = async (table: "main.fixups" | "main.ci_fixes"): Promise<number> => Number((await db.get(db.k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo", "=", repo).where("number", "=", number).where("state", "in", FAILED_TRY).where("created_at", ">", since)))?.n ?? 0);
  return [{ step: "fix-up", count: await count("main.fixups") }, { step: "CI fix", count: await count("main.ci_fixes") }];
}

/** Our latest pushed fix-up of the PR after `since`: its changed lines and files. */
async function latestFix(db: Db, repo: string, number: number, since: string): Promise<BlockerFacts["fix"]> {
  const r = await db.get(db.k.selectFrom("main.fixups").select(["patch", "files"]).where("repo", "=", repo).where("number", "=", number).where("state", "=", "pushed").where("created_at", ">", since)
    .orderBy("created_at", "desc").limit(1));
  return r ? { lines: patchLines(r.patch), files: json<string[]>(r.files, []) } : null;
}

/** The merge leg of the workflow that ended after `since` (and none active), with its reason. */
async function endedLeg(db: Db, w: ItemWorkflow, since: string): Promise<{ reason: string } | null> {
  const r = await db.get(db.k.selectFrom("main.preapprovals").select(["state", "reason", "updated_at"]).where("workflow_id", "=", w.id).orderBy("id", "desc").limit(1));
  if (!r || !ENDED_LEG.includes(r.state) || r.updated_at <= since) return null;
  return { reason: r.reason ?? r.state };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the PR's plan stops for a maintainer's answer: its steps are done, or a review verdict needs a person. */
const waitsForAnswer = (f: PrFacts): boolean => {
  const p = decidePr(f);
  return p.wait === MAINTAINER_ANSWER_WAIT || p.state === "opus-hold" || p.state === "opus-close";
};

/** Starts or adopts the approved PR's merge leg; a refusal is returned as the reason it cannot go on. */
async function ensureLeg(db: Db, w: ItemWorkflow, repo: string, pr: number, head: string): Promise<string | null> {
  const active = await db.get(db.k.selectFrom("main.preapprovals").select(["id", "workflow_id"]).where("repo", "=", repo).where("number", "=", pr).where("state", "in", ACTIVE_LEG).orderBy("id", "desc").limit(1));
  if (!active) {
    try {
      await preapproveMerge(db, { repo, number: pr, by: w.approvedBy!, via: "workflow", head });
    } catch (e) {
      // A refusal by rule (not reviewable, merging not approved) needs a person; anything else is tried again on the next pass.
      if (e instanceof PreapprovalRefused) return e.message;
      throw e;
    }
  } else if (active.workflow_id === w.id) return null;
  await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: w.id }).where("repo", "=", repo).where("number", "=", pr).where("state", "in", ACTIVE_LEG).where("workflow_id", "is", null));
  return null;
}

/** The PR a workflow works on: its own item, or an implement workflow's implementation PR; null while an issue has none. */
async function prOf(db: Db, w: ItemWorkflow): Promise<{ number: number; stuck: boolean } | null> {
  if (w.kind === "pr") return { number: w.number, stuck: false };
  const im = await currentImplementation(db, w.repo, w.number);
  if (im?.prNumber != null) return { number: im.prNumber, stuck: im.state === "stuck" };
  if (im?.state === "stuck") return { number: -1, stuck: true };
  // The attempt may have ended with its PR: the latest one that opened a PR.
  const ended = await db.get(db.k.selectFrom("main.implementations").select("pr_number").where("repo", "=", w.repo).where("number", "=", w.number).where("pr_number", "is not", null).orderBy("id", "desc").limit(1));
  return ended?.pr_number != null ? { number: ended.pr_number, stuck: false } : null;
}

/**
 * One pass over the live workflows of repos on the maintainer workflow. Writes only what changed; returns the workflows that moved to
 * another state.
 */
export async function advanceWorkflows(db: Db, log: (line: string) => void = () => {}): Promise<Moved[]> {
  const repos = new Set((await repoWorkflows(db)).filter((r) => r.workflow === "new").map((r) => r.repo));
  if (!repos.size) return [];
  const live = (await liveWorkflows(db)).filter((w) => repos.has(w.repo));
  if (!live.length) return [];
  const thresholds = { largeFix: await largeFixLines(db), outsideMin: await outsidePurposeMin(db) };
  const targets = new Map<number, { number: number; stuck: boolean } | null>();
  for (const w of live) targets.set(w.id, await prOf(db, w));
  const refs = [...new Set(live.flatMap((w) => { const t = targets.get(w.id); return t && t.number > 0 ? [`${w.repo}#${t.number}`] : []; }))];
  const facts = new Map((refs.length ? await withSettingsSnapshot(db, () => loadPrFacts(db, { refs })) : []).map((f) => [`${f.repo}#${f.number}`, f]));
  const moved: Moved[] = [];
  for (const w of live) {
    try {
      const to = await advanceOne(db, w, targets.get(w.id) ?? null, facts, thresholds);
      if (to) moved.push({ id: w.id, repo: w.repo, number: w.number, to });
    } catch (e) {
      log(`workflow ${w.repo}#${w.number}: ${(e as Error).message}`);
    }
  }
  return moved;
}

async function advanceOne(db: Db, w: ItemWorkflow, target: { number: number; stuck: boolean } | null, facts: Map<string, PrFacts>, thresholds: BlockerFacts["thresholds"]): Promise<ItemWorkflow["state"] | null> {
  const at = new Date().toISOString();
  const write = async (patch: WorkflowPatch, event?: "blocked"): Promise<ItemWorkflow["state"] | null> => {
    await updateWorkflow(db, w.id, patch, at);
    if (event) await addEvent(db, { workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: event, line: patch.rec?.text ?? null, at });
    return patch.state !== undefined && patch.state !== w.state ? patch.state : null;
  };
  const self = await db.get(db.k.selectFrom("main.items").select(["state"]).where("repo", "=", w.repo).where("number", "=", w.number));
  if (!target || target.number < 0) {
    // An issue with no PR yet: it ends when the issue closes, and stops when its implementation is stuck.
    if (self && self.state !== "OPEN") return await write({ state: "closed", rec: null, blocker: null, blockerParams: null });
    if (target?.stuck && w.state !== "blocked" && w.approvedBy) {
      const found: Found = { blocker: "failed-twice", params: { step: "implement" } };
      return await write({ state: "blocked", blocker: found.blocker, blockerParams: found.params, rec: atBlocker(found, null, w.plan), recAt: at, recHead: null }, "blocked");
    }
    return null;
  }
  const pr = await db.get(db.k.selectFrom("main.items").select(["state", "head_oid"]).where("repo", "=", w.repo).where("number", "=", target.number));
  if (!pr) return null;
  if (pr.state === "MERGED") return await write({ state: "done", rec: null, blocker: null, blockerParams: null });
  if (pr.state !== "OPEN") return await write({ state: "closed", rec: null, blocker: null, blockerParams: null });
  // Waiting for a person: nothing moves until they answer.
  if (w.state === "blocked" || w.state === "recommending") return null;
  const head = pr.head_oid;
  if (!head) return null;
  const since = await goOnAt(db, w);
  const patch: WorkflowPatch = {};

  // The head the workflow accepted moves along our own pushes; any other push is the author's.
  let authorPush: BlockerFacts["authorPush"] = null;
  const base = w.kind === "pr" ? w.baseHead : null;
  if (!base || w.kind !== "pr") {
    if (w.kind === "pr") patch.baseHead = head;
  } else if (base !== head) {
    if (await ownChain(db, w.repo, target.number, base, head)) patch.baseHead = head;
    else authorPush = { from: base, to: head };
  }

  // The numbered plan follows the latest review at the head; a merge-queue entry has no review.
  const review = w.entry === "merge" ? null : await reviewAt(db, w.repo, target.number, head);
  const plan: PlanPart[] = review ? planOf(review.fixes, w.plan) : w.plan;
  if (!sameJson(plan, w.plan)) patch.plan = plan;
  const view: ReviewView | null = review ? { verdict: review.verdict, sure: review.sure, rec: review.workflow?.recommendation ?? null } : null;

  const approved = w.approvedBy !== null;
  const fresh = review && review.at > since ? review : null;
  const found = detectBlocker({
    entry: w.entry, approved, authorPush,
    review: fresh ? { verdict: fresh.verdict, sure: fresh.sure, majors: plan.filter((p) => p.major && p.state === "planned").map((p) => p.n), outsideLines: fresh.workflow?.outside_purpose?.lines ?? 0 } : null,
    failures: target.stuck ? [{ step: "implement", count: 2 }, ...await failures(db, w.repo, target.number, since)] : await failures(db, w.repo, target.number, since),
    fix: await latestFix(db, w.repo, target.number, since),
    plannedFiles: plan.filter((p) => p.state !== "dropped" && p.file).map((p) => p.file!),
    leg: approved ? await endedLeg(db, w, since) : null,
    thresholds,
  });
  if (found) {
    // The merge leg stops before it can merge; one the merge queue already holds goes through (the approval said merge).
    const leg = await db.get(db.k.selectFrom("main.preapprovals").select("state").where("repo", "=", w.repo).where("number", "=", target.number).where("state", "in", ACTIVE_LEG).orderBy("id", "desc").limit(1));
    if (leg?.state === "queued") return patch.plan || patch.baseHead ? await write(patch) : null;
    if (leg) await cancelPreapproval(db, ACTOR, w.repo, target.number, undefined, "workflow");
    return await write({ ...patch, state: "blocked", blocker: found.blocker, blockerParams: found.params, rec: atBlocker(found, view, plan), recAt: at, recHead: head }, "blocked");
  }

  const f = facts.get(`${w.repo}#${target.number}`);
  if (!approved) {
    if (f && f.head === head && waitsForAnswer(f)) {
      const rec: Recommendation = afterSteps(view, plan);
      return await write({ ...patch, state: "recommending", rec, recAt: at, recHead: head });
    }
  } else {
    const refused = await ensureLeg(db, w, w.repo, target.number, head);
    if (refused) {
      const stop: Found = { blocker: "other", params: { reason: refused } };
      return await write({ ...patch, state: "blocked", blocker: stop.blocker, blockerParams: stop.params, rec: atBlocker(stop, view, plan), recAt: at, recHead: head }, "blocked");
    }
  }
  return Object.keys(patch).length ? await write(patch) : null;
}

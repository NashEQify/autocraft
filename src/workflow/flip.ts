// Moves a tracked repo between the decision pipeline (`legacy`) and the maintainer workflow (`new`), with its in-flight items.
//
// To `new`, each open item in flight gets a live workflow row, built from the legacy rows that stay in place:
//   fast_track on a PR with no pre-approval   -> entry fixup, not approved, weight kept
//   fast_track on an issue                    -> entry implement, approved by whoever fast-tracked it
//   live pre-approval (fixup|review|ci|queued) -> approved by its operator, legacy_preapproval_id set; the row finishes unchanged
//   pre-approval in `asked`, its Merge? question at the stop head open and that head still the PR's
//                                             -> blocked, blocker mapped from its reason, approval kept, recommendation from that
//                                                question's pick; any other `asked` row has ended
//   open Merge? or Hold on a started PR       -> recommending, from the question's pick; the question stays open
//   implement question or stuck decision      -> recommending on the issue's workflow; its options become numbered parts
// Open questions with no started item behind them: a Merge? or Hold question on an unstarted PR and every scope question are
// withdrawn (renamed and answered withdrawn by the pipeline, as src/merge/withdraw.ts sets a question aside), so the legacy
// planner can ask again after a rollback; duplicate and other questions stay. A flip writes nothing to GitHub.
//
// To `legacy` (rollback), the repo's live workflows stop and their pre-approvals lose the link. The legacy rows were kept
// current, so the old planner carries on; it asks the withdrawn questions again as new rows.
//
// Idempotent, like src/db/fix-retire.ts: a repo already on the target model, with nothing left to stop, changes nothing.
// One audit row per flip that changed something. Refused to `new` while the GitHub identity is `box`, since merges and
// closes in the workflow are made as the person, and while WORKFLOW_ENGINE_READY is false.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { BACKLOG, HANDLED, WITHDRAWN_OPTION, clearAskedStage, type Option } from "../decisions.ts";
import { githubIdentity } from "../github/identity.ts";
import { mergeDecisionId } from "../core/rules.ts";
import { renameDecision, WITHDRAWN } from "../merge/withdraw.ts";
import { addEvent, insertWorkflow, liveWorkflows, repoWorkflow, type NewWorkflow, type RepoWorkflow } from "./store.ts";
import { WEIGHT_NORMAL, type Blocker, type ItemKind, type PlanPart, type Recommendation, type Surface } from "./types.ts";

const LIVE_PREAPPROVAL = ["fixup", "review", "ci", "queued"];
/** Keys every decision offers that are not a choice of work. */
const NOT_PARTS = new Set([BACKLOG.key, HANDLED.key, WITHDRAWN_OPTION.key]);
const IMPLEMENT_DECISION = /#\d+:implement(-q\d+-\d+|-limit-\d+)?$/;
export const FLIP_WITHDRAWN_NOTE = "withdrawn when the repo moved to the maintainer workflow";
/** The id suffix of a question a flip withdrew; `~replaced-` keeps it out of every reader of current questions. */
const FLIP_SUFFIX = "~replaced-flip-";
/**
 * Whether the planner works item_workflows. Until it does, a flip to `new` would only withdraw questions the legacy planner
 * asks again, so a real flip is refused; a dry run still reports what it would do.
 */
export const WORKFLOW_ENGINE_READY = false;
const ENGINE_NOT_READY = "the planner does not work maintainer workflows yet: a flip now would only withdraw questions the legacy planner asks again";

export class FlipRefused extends Error {}

export type FlipStart = NewWorkflow & { preapprovalId: number | null; from: string };
export type FlipDecision = { id: string; kind: string; number: number };
export type FlipReport = {
  repo: string;
  from: RepoWorkflow;
  to: RepoWorkflow;
  applied: boolean;
  /** Why the flip cannot run; a dry run reports it, a real flip throws it. */
  refused: string | null;
  started: FlipStart[];
  withdrawn: FlipDecision[];
  /** Live workflows stopped by a rollback. */
  stopped: { id: number; number: number }[];
  /** Rollback: questions an earlier flip withdrew on items still open, which the legacy planner asks again. */
  reasked: number;
};

type DecisionRow = { id: string; kind: string; number: number; options: string; recommended: string | null; recommended_reason: string | null; question: string; asked_at: string };

const parseOptions = (s: string): Option[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((o): o is Option => typeof o?.key === "string" && typeof o?.label === "string") : [];
  } catch {
    return [];
  }
};

/** The blocker a pre-approval's stop reason (src/preapproval/index.ts) stands for; the reason itself is kept in blocker_params. */
export function blockerOfReason(reason: string | null): Blocker {
  const r = reason ?? "";
  // A review verdict of hold or close, or an unsure review; the pre-merge review's defects or doubt.
  if (/^the review says |^the pre-merge review found \d+ defects?$|^the pre-merge review is unsure$/.test(r)) return "major-finding";
  // The CI fix gave up, the pre-merge review used its tries, the review failed for good.
  if (/^CI failed at .* and the CI fix did not repair it$|^the pre-merge review of .* failed$|^the review of .* waits on /.test(r)) return "failed-twice";
  if (/asks for fixes and its fix-up cannot run \(too-large\)$/.test(r)) return "large-fix";
  // Conflicts, merging no longer approved, a head that cannot be reviewed, a fix-up that cannot run, a failed verification, ...
  return "other";
}

/** A Merge? or Hold question's pick as a recommendation; null when it has none. */
function recOfPick(d: DecisionRow): Recommendation | null {
  if (!d.recommended) return null;
  const label = parseOptions(d.options).find((o) => o.key === d.recommended)?.label ?? d.recommended;
  return { text: d.recommended_reason?.trim() || label, parts: { fix: [], drop: [] }, merges: d.recommended === "merge" };
}

/** An implement question's options as numbered parts, and its pick as the recommendation. */
function implementPlan(d: DecisionRow, approved: boolean): { plan: PlanPart[]; rec: Recommendation } {
  const opts = parseOptions(d.options).filter((o) => !NOT_PARTS.has(o.key));
  const plan = opts.map((o, i): PlanPart => ({ n: i + 1, title: o.label, source: "implement", state: "planned" }));
  const pick = opts.findIndex((o) => o.key === d.recommended);
  return { plan, rec: { text: d.recommended_reason?.trim() || d.question, parts: { fix: pick >= 0 ? [pick + 1] : [], drop: [] }, merges: approved } };
}

/** What a flip of `repo` to `new` would do, read in the caller's transaction. */
async function planToNew(db: Db, repo: string, at: string): Promise<{ started: FlipStart[]; withdrawn: FlipDecision[] }> {
  const items = new Map((await db.all(db.k.selectFrom("main.items").select(["number", "kind", "head_oid"]).where("repo", "=", repo).where("state", "=", "OPEN")))
    .map((r) => [r.number, r]));
  const fast = new Map((await db.all(db.k.selectFrom("main.fast_track").select(["number", "added_by", "added_at", "weight"]).where("repo", "=", repo))).map((r) => [r.number, r]));
  const pre = new Map<number, { id: number; by: string; at: string; state: string; from_head: string; head: string | null; reason: string | null; fix_id: number | null }>();
  for (const p of await db.all(db.k.selectFrom("main.preapprovals").select(["id", "number", "by", "at", "state", "from_head", "head", "reason", "fix_id"]).where("repo", "=", repo).orderBy("id"))) pre.set(p.number, p);
  const open: DecisionRow[] = await db.all(db.k.selectFrom("main.decisions")
    .select(["id", "kind", "number", "options", "recommended", "recommended_reason", "question", "asked_at"]).$narrowType<{ number: number }>()
    .where("repo", "=", repo).where("number", "is not", null).where("answer", "is", null).orderBy("asked_at").orderBy("id"));
  const live = new Set((await liveWorkflows(db, repo)).map((w) => w.number));
  const queuedOnGithub = new Set((await db.all(db.k.selectFrom("main.github_commands").select(["number", "login"])
    .where("repo", "=", repo).where("command", "=", "merge-queue").where("state", "=", "done"))).map((c) => `${c.number}:${c.login.toLowerCase()}`));

  const latestOpen = (n: number, test: (d: DecisionRow) => boolean): DecisionRow | undefined => open.filter((d) => d.number === n && test(d)).at(-1);
  const isMergeQ = (d: DecisionRow) => d.kind === "merge" || d.kind === "hold";
  const started: FlipStart[] = [];
  const startedNums = new Set<number>();
  const candidates = [...new Set([...fast.keys(), ...pre.keys(), ...open.filter((d) => IMPLEMENT_DECISION.test(d.id)).map((d) => d.number)])].sort((a, b) => a - b);
  for (const n of candidates) {
    const item = items.get(n);
    if (!item || live.has(n)) continue;
    const kind: ItemKind = item.kind === "pr" ? "pr" : "issue";
    const ft = fast.get(n);
    const p0 = pre.get(n);
    // A row in `asked` is final in the legacy pipeline: it is in flight only while its Merge? question at the head it stopped
    // on is still open and that head is still the PR's (as resumeReviewStops in src/preapproval/index.ts reads it).
    const stopHead = p0 ? p0.head ?? p0.from_head : null;
    const stopQuestion = p0?.state === "asked" && item.head_oid === stopHead ? open.find((d) => d.id === mergeDecisionId(repo, n, stopHead!)) : undefined;
    const p = p0 && (LIVE_PREAPPROVAL.includes(p0.state) || stopQuestion) ? p0 : undefined;
    const base = { repo, number: n, kind, weight: ft?.weight ?? WEIGHT_NORMAL, startedVia: "cli" as Surface };
    let s: FlipStart | undefined;
    if (p) {
      const via: Surface = queuedOnGithub.has(`${n}:${p.by.toLowerCase()}`) ? "github" : "dashboard";
      s = {
        ...base, entry: p.fix_id !== null ? "fixup" : "review", state: "running",
        startedBy: ft?.added_by ?? p.by, startedAt: ft && ft.added_at < p.at ? ft.added_at : p.at, baseHead: p.from_head,
        approvedBy: p.by, approvedAt: p.at, approvedVia: via, legacyPreapprovalId: p.id, preapprovalId: p.id, from: `pre-approval ${p.state}`,
      };
      if (stopQuestion) {
        const rec = recOfPick(stopQuestion);
        Object.assign(s, {
          state: "blocked", blocker: blockerOfReason(p.reason), blockerParams: { reason: p.reason, decisionId: stopQuestion.id },
          ...(rec ? { rec, recAt: stopQuestion.asked_at, recHead: stopHead } : {}),
        });
      }
    } else if (ft && kind === "pr") {
      s = { ...base, entry: "fixup", state: "running", startedBy: ft.added_by, startedAt: ft.added_at, baseHead: item.head_oid ?? null, preapprovalId: null, from: "fast track" };
      const d = latestOpen(n, isMergeQ);
      const rec = d ? recOfPick(d) : null;
      if (d && rec) Object.assign(s, { state: "recommending", rec, recAt: d.asked_at, recHead: item.head_oid ?? null, blockerParams: { decisionId: d.id } });
    } else if (kind === "issue") {
      s = ft
        ? { ...base, entry: "implement", state: "running", startedBy: ft.added_by, startedAt: ft.added_at, approvedBy: ft.added_by, approvedAt: ft.added_at, approvedVia: "dashboard", preapprovalId: null, from: "fast track" }
        : { ...base, entry: "implement", state: "running", startedBy: "pipeline", startedAt: at, preapprovalId: null, from: "implement question" };
      const d = latestOpen(n, (x) => IMPLEMENT_DECISION.test(x.id));
      if (d) {
        const { plan, rec } = implementPlan(d, !!s.approvedBy);
        Object.assign(s, { state: "recommending", plan, rec, recAt: d.asked_at, blockerParams: { decisionId: d.id } });
      }
    }
    if (s) {
      started.push(s);
      startedNums.add(n);
    }
  }
  const withdrawn = open
    .filter((d) => d.kind === "scope" || (isMergeQ(d) && items.get(d.number)?.kind === "pr" && !startedNums.has(d.number) && !live.has(d.number)))
    .map((d) => ({ id: d.id, kind: d.kind, number: d.number }));
  return { started, withdrawn };
}

/**
 * Flips `repo` to `to`. A dry run (`apply` false) reads and reports only. `by` is recorded on the audit row, the started
 * and stopped events, and as the stopper of a rollback.
 */
export async function flipRepo(db: Db, repo: string, o: { to: RepoWorkflow; by: string; apply: boolean; at?: string; /** Tests only: WORKFLOW_ENGINE_READY. */ engineReady?: boolean }): Promise<FlipReport> {
  const at = o.at ?? new Date().toISOString();
  const work = async (): Promise<FlipReport> => {
    if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new FlipRefused(`${repo} is not tracked`);
    const from = await repoWorkflow(db, repo);
    const report: FlipReport = { repo, from, to: o.to, applied: false, refused: null, started: [], withdrawn: [], stopped: [], reasked: 0 };
    if (o.to === "new") {
      if (from === "new") return report;
      if (await githubIdentity(db) === "box") report.refused = "the GitHub identity is box: switch it to the app first, so merges and closes are made as the person";
      else if (!(o.engineReady ?? WORKFLOW_ENGINE_READY)) report.refused = ENGINE_NOT_READY;
      Object.assign(report, await planToNew(db, repo, at));
    } else {
      report.stopped = (await liveWorkflows(db, repo)).map((w) => ({ id: w.id, number: w.number }));
      if (from === "legacy" && !report.stopped.length) return report;
      report.reasked = Number((await db.get(db.k.selectFrom("main.decisions as d").select((eb) => eb.fn.countAll<number>().as("n"))
        .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
        .where("d.repo", "=", repo).where("i.state", "=", "OPEN").where("d.answer", "=", WITHDRAWN).where("d.answer_note", "=", FLIP_WITHDRAWN_NOTE)))?.n ?? 0);
    }
    if (!o.apply) return report;
    if (report.refused) throw new FlipRefused(report.refused);
    for (const s of report.started) {
      const { preapprovalId, from: _from, ...row } = s;
      const id = await insertWorkflow(db, row, at);
      if (preapprovalId !== null) await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: id }).where("id", "=", preapprovalId));
      await addEvent(db, { workflowId: id, repo, number: s.number, login: o.by, via: "cli", kind: "started", at });
    }
    const clear = clearAskedStage(db);
    for (const d of report.withdrawn) {
      const to = `${d.id}${FLIP_SUFFIX}${at}`;
      await renameDecision(db, d.id, to);
      await db.run(db.k.updateTable("main.decisions")
        .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: FLIP_WITHDRAWN_NOTE, adopted_opinion: null })
        .where("id", "=", to).where("answer", "is", null));
      if (d.kind === "scope") await clear(repo, d.number, d.id);
    }
    for (const w of report.stopped) {
      await db.run(db.k.updateTable("main.item_workflows").set({ state: "stopped", stopped_by: o.by, stopped_at: at, updated_at: at }).where("id", "=", w.id));
      await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: null }).where("workflow_id", "=", w.id));
      await addEvent(db, { workflowId: w.id, repo, number: w.number, login: o.by, via: "cli", kind: "stopped", at });
    }
    if (from !== o.to) await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: o.to }).where("name", "=", repo));
    await audit(db, o.by, "workflow-flip", repo, {
      from, to: o.to, started: report.started.map((s) => s.number), withdrawn: report.withdrawn.map((d) => d.id), stopped: report.stopped.map((w) => w.number),
    });
    report.applied = true;
    return report;
  };
  return o.apply ? await db.write(work) : await db.read(work);
}

/** The report as lines for the CLI. */
export function flipLines(r: FlipReport): string[] {
  const out: string[] = [];
  const verb = r.applied ? "" : " (dry run)";
  if (r.refused) out.push(`refused: ${r.refused}`);
  if (r.from === r.to && !r.started.length && !r.withdrawn.length && !r.stopped.length) return [...out, `${r.repo} already runs ${r.to}; nothing to change`];
  out.push(`${r.repo}: ${r.from} -> ${r.to}${verb}`);
  for (const s of r.started) {
    const approved = s.approvedBy ? `, approved by ${s.approvedBy}` : "";
    const extra = s.blocker ? `, blocker ${s.blocker}` : s.state === "recommending" ? ", recommending" : "";
    out.push(`  start #${s.number} ${s.kind} entry ${s.entry} weight ${s.weight ?? WEIGHT_NORMAL}${approved}${extra} (from ${s.from})`);
  }
  for (const d of r.withdrawn) out.push(`  withdraw ${d.kind} question ${d.id}`);
  for (const w of r.stopped) out.push(`  stop workflow ${w.id} on #${w.number}`);
  if (r.to === "legacy" && r.reasked) {
    out.push(`  ${r.reasked} question${r.reasked === 1 ? "" : "s"} the flip to new withdrew will be asked again: new decision rows and prepare calls;`
      + " their earlier discussion stays on the renamed rows");
  }
  return out;
}

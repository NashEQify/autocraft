// Moves a tracked repo between the decision pipeline (`legacy`) and the maintainer workflow (`new`), with its in-flight items.
//
// To `new`, each open item in flight gets a live workflow row, built from the legacy rows that stay in place:
//   fast_track on a PR with no pre-approval   -> entry fixup, not approved, weight kept
//   fast_track on an issue                    -> entry implement, approved by whoever fast-tracked it
//   live pre-approval (fixup|review|ci|queued) -> approved by its operator, legacy_preapproval_id set; the row finishes unchanged
//   pre-approval in `asked`                   -> blocked, blocker mapped from its reason, approval kept, recommendation from the
//                                                open Merge? question's pick
//   open Merge? or Hold on a started PR       -> recommending, from the question's pick; the question stays open
//   implement question or stuck decision      -> recommending on the issue's workflow; its options become numbered parts
// Open questions with no started item behind them: a Merge? or Hold question on an unstarted PR and every scope question are
// withdrawn (renamed and answered withdrawn by the pipeline, as src/merge/withdraw.ts sets a question aside), so the legacy
// planner can ask again after a rollback; duplicate and other questions stay. A flip writes nothing to GitHub.
//
// To `legacy` (rollback), the repo's live workflows stop. The legacy rows were kept current, so the old planner carries on.
//
// Idempotent, like src/db/fix-retire.ts: a repo already on the target model, with nothing left to stop, changes nothing.
// One audit row per flip that changed something. Refused to `new` while the GitHub identity is `box`, since merges and
// closes in the workflow are made as the person.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { BACKLOG, HANDLED, WITHDRAWN_OPTION, clearAskedStage, type Option } from "../decisions.ts";
import { githubIdentity } from "../github/identity.ts";
import { renameDecision, WITHDRAWN } from "../merge/withdraw.ts";
import { addEvent, insertWorkflow, liveWorkflows, repoWorkflow, type NewWorkflow, type RepoWorkflow } from "./store.ts";
import { WEIGHT_NORMAL, type Blocker, type ItemKind, type PlanPart, type Recommendation, type Surface } from "./types.ts";

const LIVE_PREAPPROVAL = ["fixup", "review", "ci", "queued"];
/** Keys every decision offers that are not a choice of work. */
const NOT_PARTS = new Set([BACKLOG.key, HANDLED.key, WITHDRAWN_OPTION.key]);
const IMPLEMENT_DECISION = /#\d+:implement(-q\d+-\d+|-limit-\d+)?$/;
export const FLIP_WITHDRAWN_NOTE = "withdrawn when the repo moved to the maintainer workflow";

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
  if (/too-large/.test(r)) return "large-fix";
  if (/new commits?|pushed after/.test(r)) return "author-commits";
  if (/the review says|\(unsure\)|asks for fixes|pre-merge review found|pre-merge review is unsure/.test(r)) return "major-finding";
  return "failed-twice";
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
    const p = p0 && (LIVE_PREAPPROVAL.includes(p0.state) || p0.state === "asked") ? p0 : undefined;
    const base = { repo, number: n, kind, weight: ft?.weight ?? WEIGHT_NORMAL, startedVia: "cli" as Surface };
    let s: FlipStart | undefined;
    if (p) {
      const via: Surface = queuedOnGithub.has(`${n}:${p.by.toLowerCase()}`) ? "github" : "dashboard";
      s = {
        ...base, entry: p.fix_id !== null ? "fixup" : "review", state: "running",
        startedBy: ft?.added_by ?? p.by, startedAt: ft && ft.added_at < p.at ? ft.added_at : p.at, baseHead: p.from_head,
        approvedBy: p.by, approvedAt: p.at, approvedVia: via, legacyPreapprovalId: p.id, preapprovalId: p.id, from: `pre-approval ${p.state}`,
      };
      if (p.state === "asked") {
        const d = latestOpen(n, (x) => x.kind === "merge");
        const rec = d ? recOfPick(d) : null;
        Object.assign(s, {
          state: "blocked", blocker: blockerOfReason(p.reason), blockerParams: { reason: p.reason, ...(d ? { decisionId: d.id } : {}) },
          ...(rec ? { rec, recAt: d!.asked_at, recHead: p.head ?? p.from_head } : {}),
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
export async function flipRepo(db: Db, repo: string, o: { to: RepoWorkflow; by: string; apply: boolean; at?: string }): Promise<FlipReport> {
  const at = o.at ?? new Date().toISOString();
  const work = async (): Promise<FlipReport> => {
    if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new FlipRefused(`${repo} is not tracked`);
    const from = await repoWorkflow(db, repo);
    const report: FlipReport = { repo, from, to: o.to, applied: false, refused: null, started: [], withdrawn: [], stopped: [] };
    if (o.to === "new") {
      if (from === "new") return report;
      if (await githubIdentity(db) === "box") report.refused = "the GitHub identity is box: switch it to the app first, so merges and closes are made as the person";
      Object.assign(report, await planToNew(db, repo, at));
    } else {
      report.stopped = (await liveWorkflows(db, repo)).map((w) => ({ id: w.id, number: w.number }));
      if (from === "legacy" && !report.stopped.length) return report;
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
      const to = `${d.id}~flip-${at}`;
      await renameDecision(db, d.id, to);
      await db.run(db.k.updateTable("main.decisions")
        .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: FLIP_WITHDRAWN_NOTE, adopted_opinion: null })
        .where("id", "=", to).where("answer", "is", null));
      if (d.kind === "scope") await clear(repo, d.number, d.id);
    }
    for (const w of report.stopped) {
      await db.run(db.k.updateTable("main.item_workflows").set({ state: "stopped", stopped_by: o.by, stopped_at: at, updated_at: at }).where("id", "=", w.id));
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
  return out;
}

// The PRs the fix-up and conflict steps work on: those whose Plan holds a `fixup` or `conflict` action.
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { PrFacts } from "../core/plan.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { type Carry, type FixCandidate, type FixSelection, parseFixes } from "./candidates.ts";
import { triesIn, type ConflictCandidate, type ConflictRow } from "./conflict-state.ts";
import { queuedOperatorFix } from "../preapproval/state.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** The queued carry-over jobs of a kept PR that have points to carry, in the order the facts list them. */
async function carriesOf(db: Db, f: PrFacts, head: string): Promise<FixCandidate[]> {
  const rows = await db.all(db.k.selectFrom("dupe_carries").select(["decision_id", "attempts"]).where("repo", "=", f.repo).where("number", "=", f.number).where("state", "=", "queued").orderBy("number"));
  const out: FixCandidate[] = [];
  for (const r of rows) {
    const sources = (await db.all(db.k.selectFrom("dupe_group_items").select(["number", "detail", "head"]).where("decision_id", "=", r.decision_id).where("kind", "=", "pr").where("role", "=", "close").orderBy("number")))
      .map((x) => {
        let pts: unknown = [];
        try { pts = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry ?? []; } catch { /* no points */ }
        // The head that was compared and closed, not the one the PR has now.
        return { number: x.number, head: x.head, points: Array.isArray(pts) ? pts.filter((p): p is string => typeof p === "string") : [] };
      }).filter((x) => x.points.length);
    if (!sources.length) continue;
    const suggestion = (await db.get(db.k.selectFrom("dupe_group_texts as t")
      .innerJoin("dupe_groups as g", (j) => j.onRef("g.decision_id", "=", "t.decision_id").onRef("g.applied_answer", "=", "t.option"))
      .select("t.text").where("t.decision_id", "=", r.decision_id).where("t.number", "=", f.number).where("t.step", "=", "suggestion")))?.text ?? null;
    const carry: Carry = { decisionId: r.decision_id, suggestion, sources };
    out.push({ repo: f.repo, number: f.number, head, reason: `Parts of ${sources.map((x) => `#${x.number}`).join(", ")}, closed as duplicates, to carry over.`, fixes: [], attempt: r.attempts + 1,
      model: (await db.get(db.k.selectFrom("decisions").select("summary_by").where("id", "=", r.decision_id)))?.summary_by ?? null, carry });
  }
  return out;
}

type FixReads = {
  titles: Map<string, string | null>;
  conflictRows: Map<string, (ConflictRow & { number: number })[]>;
  reviews: Map<string, { fixes: string | null; model: string | null }>;
};

/** The reads of selectFixups for the given candidates, keyed by `repo#number` (reviews by `repo#number@head`). */
async function fixReads(db: Db, conflicts: readonly { facts: { repo: string; number: number } }[], fixups: readonly { facts: { repo: string; number: number } }[]): Promise<FixReads> {
  const refs = (ps: readonly { facts: { repo: string; number: number } }[]): [string, number][] => ps.map((p) => [p.facts.repo, p.facts.number]);
  const at = (ps: readonly { facts: { repo: string; number: number } }[]) => kx.tupleIn(db, ["repo", "number"], refs(ps), ["text", "bigint"]);
  const titles = new Map(conflicts.length ? (await db.all(db.k.selectFrom("items").select(["repo", "number", "title"]).where(at(conflicts)))).map((r) => [`${r.repo}#${r.number}`, r.title]) : []);
  const conflictRows = new Map<string, (ConflictRow & { number: number })[]>();
  if (conflicts.length) for (const { repo, ...r } of await db.all(db.k.selectFrom("conflict_merges").select(["repo", "number", "from_head", "state", "created_at"]).where(at(conflicts)).orderBy(kx.rowid("conflict_merges"))))
    (conflictRows.get(`${repo}#${r.number}`) ?? conflictRows.set(`${repo}#${r.number}`, []).get(`${repo}#${r.number}`)!).push(r);
  const reviews = new Map<string, { fixes: string | null; model: string | null }>();
  if (fixups.length) for (const r of await db.all(db.k.selectFrom("final_reviews").select(["repo", "number", "head_oid", "fixes", "model"]).where("verdict", "=", "take-fix").where(at(fixups)).$narrowType<{ number: number; head_oid: string }>()))
    if (!reviews.has(`${r.repo}#${r.number}@${r.head_oid}`)) reviews.set(`${r.repo}#${r.number}@${r.head_oid}`, { fixes: r.fixes, model: r.model });
  return { titles, conflictRows, reviews };
}

/** fixReads for every repo's candidates of a planner pass's Plans, read on first use and kept with them. */
const passFixReads = new WeakMap<PlanSet, Promise<FixReads>>();
function passReads(db: Db, plans: PlanSet, run: string | null | undefined): Promise<FixReads> {
  let r = passFixReads.get(plans);
  if (!r) {
    const o = { ...(run !== undefined ? { run } : {}), plans };
    passFixReads.set(plans, (r = (async () => await fixReads(db, await planned(db, "conflict", o), await planned(db, "fixup", o)))()));
    void r.catch(() => { if (passFixReads.get(plans) === r) passFixReads.delete(plans); });
  }
  return r;
}

export async function selectFixups(db: Db, repo: string, run?: string | null, plans?: PlanSet): Promise<FixSelection> {
  const opts = { repo, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) };
  const out: FixSelection = { fix: [], cannotPush: [], ask: [], lint: [], conflictMerge: [], conflictAsk: [] };
  const conflicts = await planned(db, "conflict", opts), fixups = await planned(db, "fixup", opts);
  // Titles and conflict merge rows of the conflict candidates, and the reviews of the fix-up candidates: read once for the
  // repo, or with a planner pass's Plans once for every repo of the pass.
  const reads = plans ? await passReads(db, plans, run) : await fixReads(db, conflicts, fixups);
  const titles = new Map<number, string | null>(), conflictRowsOf = new Map<number, ConflictRow[]>();
  for (const { facts: f } of conflicts) {
    const t = reads.titles.get(`${repo}#${f.number}`), rows = reads.conflictRows.get(`${repo}#${f.number}`);
    if (t !== undefined) titles.set(f.number, t);
    if (rows) conflictRowsOf.set(f.number, rows);
  }
  const reviews = { get: (key: string) => reads.reviews.get(`${repo}#${key}`) };
  for (const { facts: f, action } of conflicts) {
    const c: ConflictCandidate = {
      repo, number: f.number, head: action.head!, base: f.conflict!.base, title: (titles.get(f.number) ?? "").slice(0, 300),
      reason: f.review!.reason, attempt: triesIn(conflictRowsOf.get(f.number) ?? [], action.head!) + 1, pushable: f.pushable,
    };
    (action.params?.bucket === "merge" ? out.conflictMerge : out.conflictAsk).push(c);
  }
  const carryFix: FixCandidate[] = [], carryAsk: FixCandidate[] = [], fix: FixCandidate[] = [];
  const carryIndex = new Map<string, number>();
  for (const { facts: f, action } of fixups) {
    const head = action.head!, bucket = action.params?.bucket;
    if (action.params?.source === "carry") {
      const ref = `${f.number}`;
      const i = carryIndex.get(ref) ?? 0;
      carryIndex.set(ref, i + 1);
      const c = (await carriesOf(db, f, head))[i];
      if (c) (bucket === "fix" ? carryFix : carryAsk).push(c);
    } else if (action.params?.source === "operator") {
      const o = await queuedOperatorFix(db, repo, f.number, head);
      if (o) fix.push({ repo, number: f.number, head, reason: "an operator's instructions", fixes: [], attempt: (f.operator?.fix?.attempts ?? 0) + 1, model: null, source: "operator", operator: { id: o.id, instructions: o.instructions } });
    } else if (action.params?.source === "premerge") {
      // Only a branch we may push to gets a pre-merge round; otherwise the step leaves it alone.
      if (!f.pushable || !f.repoFacts.pushApproved) continue;
      const row = await premergeAt(db, repo, f.number, head);
      const defects = findingsOf(row).filter((x) => x.severity === "defect");
      fix.push({ repo, number: f.number, head, reason: "pre-merge review", fixes: parseFixes(JSON.stringify(defects.map((x) => x.fix))), attempt: 1, model: row?.model ?? null, source: "premerge" });
    } else {
      const r = reviews.get(`${f.number}@${head}`);
      const c: FixCandidate = { repo, number: f.number, head, reason: f.review!.reason, fixes: parseFixes(r?.fixes ?? null), attempt: f.fixup!.attempts + 1, model: r?.model ?? null };
      if (bucket === "ask") out.ask.push(c);
      else if (bucket === "cannot-push") out.cannotPush.push(c);
      else if (bucket === "fix") fix.push(c);
    }
  }
  // Stored patches (review, pre-merge and carry-over sources) whose lint task ended. Their row is found by source; a carry-over's also by its decision.
  const seenLint = new Set<string>();
  for (const { facts: f, action } of await planned(db, "lint", { ...opts, bucket: "fixup" })) {
    const head = action.head!, source = String(action.params?.source ?? "review");
    // Several lint actions of one PR (one per stored row) would otherwise list every row of the key again.
    const key = `${f.number} ${head} ${source}`;
    if (seenLint.has(key)) continue;
    seenLint.add(key);
    for (const w of await db.all(db.k.selectFrom("fixups").select([kx.rowid("fixups").as("id"), "attempt", "patch", "lint_task", "lint_round", "lint_state", "carry_decision", "session", "operator_fix", "changes"])
      .where("repo", "=", repo).where("number", "=", f.number).where("from_head", "=", head)
      .where((eb) => eb(eb.fn.coalesce("source", eb.val("review")), "=", source)).where("state", "=", "linting").orderBy(kx.rowid("fixups")))) {
      if (!w.patch) continue;
      const lint = { rowid: w.id, round: w.lint_round ?? 1, task: w.lint_task, state: w.lint_state ?? "pending", patch: w.patch, session: w.session, changes: changesOf(w.changes) };
      if (source === "carry") {
        const c = (await carriesOf(db, f, head)).find((x) => x.carry!.decisionId === w.carry_decision);
        if (c) out.lint.push({ ...c, attempt: w.attempt, lint });
      } else if (source === "operator") {
        const o = await queuedOperatorFix(db, repo, f.number, head);
        if (o && w.operator_fix === o.id) out.lint.push({ repo, number: f.number, head, reason: "an operator's instructions", fixes: [], attempt: w.attempt, model: null, source: "operator", operator: { id: o.id, instructions: o.instructions }, lint });
      } else if (source === "premerge") {
        const pm = await premergeAt(db, repo, f.number, head);
        const defects = findingsOf(pm).filter((x) => x.severity === "defect");
        out.lint.push({ repo, number: f.number, head, reason: "pre-merge review", fixes: parseFixes(JSON.stringify(defects.map((x) => x.fix))), attempt: w.attempt, model: pm?.model ?? null, source: "premerge", lint });
      } else {
        const r = await db.get(db.k.selectFrom("final_reviews").select(["fixes", "model"]).where("repo", "=", repo).where("number", "=", f.number).where("head_oid", "=", head).where("verdict", "=", "take-fix"));
        if (f.review) out.lint.push({ repo, number: f.number, head, reason: f.review.reason, fixes: parseFixes(r?.fixes ?? null), attempt: w.attempt, model: r?.model ?? null, lint });
      }
    }
  }
  // Stored conflict resolutions whose lint task ended: collected by the conflict step.
  for (const { facts: f, action } of await planned(db, "lint", { ...opts, bucket: "conflict" })) {
    const head = action.head!;
    for (const w of await db.all(db.k.selectFrom("conflict_merges").select([kx.rowid("conflict_merges").as("id"), "attempt", "patch", "lint_task", "lint_round", "base_sha", "files", "session"])
      .where("repo", "=", repo).where("number", "=", f.number).where("from_head", "=", head).where("state", "=", "linting").orderBy(kx.rowid("conflict_merges")))) {
      if (!w.patch || !w.base_sha) continue;
      out.conflictMerge.unshift({
        repo, number: f.number, head, base: f.conflict!.base, title: ((await db.get(db.k.selectFrom("items").select("title").where("repo", "=", repo).where("number", "=", f.number)))?.title ?? "").slice(0, 300),
        reason: f.review!.reason, attempt: w.attempt, pushable: f.pushable,
        lint: { rowid: w.id, round: w.lint_round ?? 1, task: w.lint_task, baseSha: w.base_sha, resolved: w.patch, files: JSON.parse(w.files ?? "[]") as string[], session: w.session },
      });
    }
  }
  out.fix.push(...carryFix, ...fix);
  out.ask.unshift(...carryAsk);
  return out;
}

/** The stored list of changes of an operator fix-up row; empty when none or unreadable. */
function changesOf(json: string | null): string[] {
  try { const v = JSON.parse(json ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

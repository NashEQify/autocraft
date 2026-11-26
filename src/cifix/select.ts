// The PRs the CI fix step works on: those whose Plan holds a `cifix` action.
import { mayRun, permit, pushPermission } from "../core/authority.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import type { PrFacts } from "../core/plan.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { CifixCandidate, CifixSelection } from "./candidates.ts";
import { loadStoredPatches } from "../data/changes/index.ts";
import type { Db } from "../db/index.ts";

/** Nothing about a CI fix is posted on a quiet pull request. */
const mayComment = (f: PrFacts): boolean => !f.quiet && permit(f, { kind: "cifix", bucket: "ask" }).ok;

export async function selectCifix(db: Db, repo: string, run?: string | null, plans?: PlanSet, by: By = CLI_BY): Promise<CifixSelection> {
  const out: CifixSelection = { work: [], collect: [], rerun: [], capped: [], ask: [], lint: [], listed: [] };
  const opts = { repo, by, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) };
  for (const { facts: f, action } of await planned(db, "cifix", opts)) {
    const x = f.cifix!, r = f.review;
    const c: CifixCandidate = {
      repo, number: f.number, head: action.head!, verdict: r?.verdict === "take-fix" ? "take-fix" : "take", reason: r?.reason ?? "", attempt: x.tries + 1,
      route: f.pushable ? "branch" : "comment", mayPush: pushPermission(f, "cifix").ok, mayComment: mayComment(f), rerun: x.rerunAt !== null, rerunAt: x.rerunAt,
    };
    const bucket = action.params?.bucket;
    if (bucket === "work") out.work.push(c);
    else if (bucket === "capped") out.capped.push(c);
    else if (bucket === "ask") out.ask.push(c);
    else if (bucket === "rerun") out.rerun.push({ c, runs: x.infraRuns ?? [] });
    else if (bucket === "collect") out.collect.push({ c, task: x.formattingTask! });
  }
  const lints = await planned(db, "lint", { ...opts, bucket: "cifix", refused: true });
  const stored = await loadStoredPatches(db, lints.map((l) => ({ repo, number: l.facts.number })), ["cifix"]);
  const seen = new Set<number>();
  for (const { facts: f, action } of lints) {
    const head = action.head!, r = f.review;
    if (seen.has(f.number)) continue;
    // The newest stored row at the head.
    const w = stored.filter((x) => x.kind === "cifix" && x.number === f.number && x.head === head).at(-1);
    if (!w || w.kind !== "cifix") continue;
    seen.add(f.number);
    out.listed.push(w.id);
    if (!mayRun({ facts: f, action }, by).ok) continue;
    out.lint.push({ repo, number: f.number, head, verdict: r?.verdict === "take-fix" ? "take-fix" : "take", reason: r?.reason ?? "", attempt: w.attempt, route: f.pushable ? "branch" : "comment", mayPush: pushPermission(f, "cifix").ok, mayComment: mayComment(f), rerun: false, rerunAt: null,
      lint: { rowid: w.id, round: w.lintRound, task: w.lintTask, state: w.lintState, patch: w.patch, files: w.files, session: w.session } });
  }
  return out;
}

// The pre-merge review's findings as parts of an item's plan.
import { loadPremerge } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";
import { findingsOf, type PremergeRow } from "../premerge/store.ts";
import { followUpDefects, stoppingDefects } from "../premerge/types.ts";
import type { PlanPart } from "./types.ts";
import { droppedTitles } from "./work.ts";

/**
 * The findings at the PR's head that a fix-up is asked for, as plan parts numbered after `plan`'s: every defect that stops the merge, and
 * what has a fix. On a PR approved for merge (`approved`) the defects that do not stop it are filed as follow-ups instead.
 */
export async function premergeParts(db: Db, pr: { repo: string; number: number; head: string }, plan: readonly PlanPart[], approved: boolean): Promise<PlanPart[]> {
  return premergePartsOf((await loadPremerge(db, [pr])).get(`${pr.repo}#${pr.number}@${pr.head}`) ?? null, plan, approved);
}

/** `premergeParts` of a row already read: a finding a person dropped from the plan (same title) is no part again. Pure. */
export function premergePartsOf(row: PremergeRow | null, plan: readonly PlanPart[], approved: boolean): PlanPart[] {
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  const dropped = droppedTitles(plan);
  const all = findingsOf(row).filter((f) => !dropped.includes(f.title.toLowerCase()));
  const stops = new Set(stoppingDefects(all, approved)), filed = new Set(approved ? followUpDefects(all) : []);
  return all.filter((f) => !filed.has(f) && (f.fix || stops.has(f)))
    .map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(stops.has(f) ? { major: true } : {}), premerge: true as const, state: "planned" as const }));
}

// The pre-merge review's findings as parts of an item's plan.
import { loadPremerge } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";
import { findingsOf, type PremergeRow } from "../premerge/store.ts";
import type { PlanPart } from "./types.ts";

/** The findings at the PR's head that a fix-up is asked for, as plan parts numbered after `plan`'s: every defect, and what has a fix. */
export async function premergeParts(db: Db, pr: { repo: string; number: number; head: string }, plan: readonly PlanPart[]): Promise<PlanPart[]> {
  return premergePartsOf((await loadPremerge(db, [pr])).get(`${pr.repo}#${pr.number}@${pr.head}`) ?? null, plan);
}

/** `premergeParts` of a row already read. Pure. */
export function premergePartsOf(row: PremergeRow | null, plan: readonly PlanPart[]): PlanPart[] {
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  return findingsOf(row).filter((f) => f.fix || f.severity === "defect")
    .map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(f.severity === "defect" ? { major: true } : {}), state: "planned" as const }));
}

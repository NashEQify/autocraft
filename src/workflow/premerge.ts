// The pre-merge review's findings as parts of an item's plan.
import { loadPremerge } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";
import { findingsOf } from "../premerge/store.ts";
import type { PlanPart } from "./types.ts";

/** The findings at the PR's head, as plan parts numbered after `plan`'s: those with a fix, or every defect. */
export async function premergeParts(db: Db, pr: { repo: string; number: number; head: string }, plan: readonly PlanPart[], which: "fixable" | "defects"): Promise<PlanPart[]> {
  const row = (await loadPremerge(db, [pr])).get(`${pr.repo}#${pr.number}@${pr.head}`) ?? null;
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  return findingsOf(row).filter((f) => (which === "fixable" ? f.fix : f.severity === "defect"))
    .map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(f.severity === "defect" ? { major: true } : {}), state: "planned" as const }));
}

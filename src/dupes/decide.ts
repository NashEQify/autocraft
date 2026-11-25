// Duplicate group decisions are retired: duplicates are signals that hold nothing, and the group planning these decisions
// read (dupes/plan.ts) moved to the triage module. The entry points stay, inert, until R1 deletes this file with its callers.
import type { Db } from "../db/index.ts";

export const decisionId = (repo: string, x: number, y: number): string => `${repo}#${x}:duplicate@${y}`;

type Role = "keep" | "close" | "stay";
export type PlanItem = { number: number; kind: "pr" | "issue"; role: Role; target: number | null; detail: Record<string, unknown> | null };
export type GroupPlan = {
  repo: string; group: { members: number[] }; baseId: string; number: number; items: PlanItem[];
  closing: boolean; source: "model" | "closed" | "rule"; model: string | null; reasons: string[];
};

export async function groupPlans(_db: Db, _repo?: string): Promise<GroupPlan[]> {
  return [];
}

export async function askGroupDecisions(_db: Db, _repo: string | undefined, _at: string): Promise<string[]> {
  return [];
}

export async function groupsToAsk(_db: Db, _repo?: string): Promise<GroupPlan[]> {
  return [];
}

export async function answersToApply(_db: Db): Promise<{ id: string; refs: string[] }[]> {
  return [];
}

export async function resetGroupAnswer(_db: Db, _id: string): Promise<void> {}

export async function applyDuplicateAnswers(_db: Db, _at: string, _only?: ReadonlySet<string>): Promise<number> {
  return 0;
}

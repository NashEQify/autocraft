// Repo step approvals (M06 control-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { RepoGuard, RepoNeed, Step, StepApproval, StepApprovals } from "./types.ts";

/** Approval rows per repo. */
export async function loadStepApprovals(db: Db, repos: string[] | KeySource, steps?: Step[]): Promise<Map<string, StepApprovals>> {
  throw new Error("not built: control.loadStepApprovals");
}

/** One-line wrapper over the snapshot; outside a snapshot it runs `loadStepApprovals`. */
export async function repoStepApproval(db: Db, repo: string, step: Step): Promise<StepApproval | null> {
  throw new Error("not built: control.repoStepApproval");
}

/** The approvals and global switch a GitHub write is gated on, read now and never from the snapshot. */
export async function loadRepoGuards(db: Db, repos: string[] | KeySource, need?: RepoNeed): Promise<Map<string, RepoGuard>> {
  throw new Error("not built: control.loadRepoGuards");
}

/** Why Act cannot run for each repo: switch off or draining, repo out of scope, Act limit 0. */
export async function loadActBlocked(db: Db, repos: string[] | KeySource): Promise<Map<string, string | null>> {
  throw new Error("not built: control.loadActBlocked");
}

/** The writer behind the dashboard buttons and CLI: throws for an untracked repo, skips a row already at that state, audits each change with the old action names; returns the number changed. */
export async function setStepApproval(db: Db, rows: { repo: string; step: Step; on: boolean }[], by: string): Promise<number> {
  throw new Error("not built: control.setStepApproval");
}

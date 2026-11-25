import type { HiddenRepos } from "../control/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { HiddenRepos, RefKey };

export type HoldReason = "limit" | "surge";
export type Hold = { repo: string; number: number; author: string; kind: "pr" | "issue"; reason: HoldReason };
export type HoldInfo = { reason: HoldReason; author: string; kind: "pr" | "issue"; limit: number };
/** 0 means the protection is off. */
export type OutsideLimits = { prsPerDay: number; issuesPerDay: number; surgePerHour: number };
export type OutsideState = OutsideLimits & { heldByLimit: number; heldBySurge: number; authors: number; tripped: { reason: string; since: string } | null };
export type HoldStatus = { author: string; reason: HoldReason; releasedBy: null } | { author: null; reason: null; releasedBy: string } | null;
export type HeldRow = Hold & { title: string | null; created_at: string | null };
export type HeldAuthorRow = { author: string; count: number; prs: number; oldest: string | null; surge: boolean };
export type HoldCounts = { limit: number; surge: number; authors: number };
export type OutsideAuthorRow = { author: string | null; author_association: string | null; author_type: string | null };
export type HoldInput = {
  candidates: (Hold & { created_at: string; rank: number; windowCount: number; overLimit: boolean; inSurge: boolean; recent: boolean; released: boolean; admitted: boolean })[];
  limits: OutsideLimits; nowMs: number; surge: { active: boolean; since: string | null } | null; whitelisted: ReadonlySet<string>;
};
export type HoldResult = { holds: Hold[]; admissions: { repo: string; number: number }[]; tripSurge: boolean; wakeAt: number | null };
export class OutsideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

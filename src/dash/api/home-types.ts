// The problem rows of Home. The dashboard declares the same shape in web/src/api/types.ts.
import type { ItemPhase, ItemStatus } from "../../core/item-status.ts";

export type { ItemPhase, ItemStatus };

export type ProblemKind = "stopped" | "health" | "stuck" | "gave-up";
export interface HomeProblem { kind: ProblemKind; title: string; detail: string; to: string }

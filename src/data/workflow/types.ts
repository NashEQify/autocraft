import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { Blocker, Entry, ItemKind, ItemWorkflow, Parsed, PlanPart, Recommendation, Surface, WorkflowEventKind, WorkflowState } from "../../workflow/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { Blocker, Entry, ItemKind, ItemWorkflow, PlanPart, Recommendation, Surface, WorkflowEventKind, WorkflowState, RefKey };
export type EndedWorkflow = "done" | "stopped" | "closed" | "backlog";

/** Score at or above this means "started": `1e15 + weight * 1e12 - workflow.id`. */
export const FAST_FLOOR = 1e15 / 2;

export type WorkflowFact = {
  id: number; entry: Entry; approved: boolean; approvedBy: string | null; startedBy: string; startedAt: string;
  weight: number; state: WorkflowState; own: boolean;
};
/** Live workflows of PRs, by the PR. */
export type PrWorkflows = Map<RefKey, ItemWorkflow>;
/** `maker_checked_at`: when GitHub last confirmed the maker's write permission; the request counts until `HOLD_MAX` after it. */
export type OperatorWork = { requests: (FixupRequest & { maker_checked_at?: string | null })[]; legs: Preapproval[] };
export type WorkflowPassFacts = {
  live: Map<RefKey, WorkflowFact>;
  ofPr: Map<RefKey, WorkflowFact>;
  ended: Map<RefKey, EndedWorkflow>;
  holds: Set<RefKey>;
  operator: Map<RefKey, OperatorWork>;
};

export type NewWorkflow = {
  repo: string; number: number; kind: ItemKind; entry: Entry; weight: number; startedBy: string; startedVia: Surface; baseHead?: string | null;
  approvedBy?: string | null; approvedVia?: Surface | null; plan?: PlanPart[]; step?: string | null; at?: string;
};
/** The fields of `ItemWorkflow` except identity. */
export type WorkflowPatch = Partial<Omit<ItemWorkflow, "id" | "repo" | "number" | "kind" | "startedBy" | "startedAt" | "startedVia" | "updatedAt">>;
export type WorkflowFilter = { live?: boolean; ids?: number[]; repos?: string[]; refs?: { repo: string; number: number }[]; states?: WorkflowState[]; logins?: string[]; approved?: boolean; recAfter?: string };
/** `via` defaults to `cli` (the archived rows of retired decisions have no surface). */
export type WorkflowEvent = { workflowId: number | null; repo: string; number: number; login: string; kind: WorkflowEventKind | "archived"; via?: Surface | null; parsed?: Parsed | null; line?: string | null; at?: string };
export type StoredEvent = WorkflowEvent & { id: number; at: string };
/** A stored event of the maintainer workflow itself. */
export type SaidEvent = StoredEvent & { kind: WorkflowEventKind };
export type QueuePosition = { position: number; of: number; weight: number; startedBy: string };
export type StartedWork = {
  live: { repo: string; number: number; entry: Entry; state: WorkflowState; startedBy: string; approvedBy: string | null }[];
  prs: { repo: string; pr: number; startedBy: string; approvedBy: string | null }[];
};
export type StartedFilter = { /** Live states only. */ states?: WorkflowState[]; refs?: { repo: string; number: number }[]; login?: string; repos?: string[]; openOnly?: boolean };

export type LegState = "fixup" | "review" | "ci" | "queued" | "merged" | "cancelled" | "failed";
export type Preapproval = Omit<Selectable<DB["preapprovals"]>, "state"> & { state: LegState };
export type LegRow = Preapproval;
export type LegContext = { workflowId: number; entry: Entry; since: string; approvedBy: string | null };
/** `requests`: the queued requests of the active legs. */
export type LegPass = { rows: LegRow[]; context: Map<number, LegContext | "ended" | "unlinked">; requests: FixupRequest[] };
export type LegMove = { id: number; from: LegState; to: LegState; head?: string | null; reason?: string | null; by?: string; via?: string };
export type LegMoved = LegMove & { repo: string; number: number };
export type NewLeg = { repo: string; number: number; by: string; workflowId: number; head: string; state: "review" | "fixup"; instructions?: string; fixId?: number; via?: string };
export type FixupRequest = Omit<Selectable<DB["operator_fixups"]>, "state"> & { state: "queued" | "started" | "ended" };
export type NewFixupRequest = { repo: string; number: number; fromHead: string; instructions: string; by: string; merge?: boolean; workflowId?: number; at?: string };

export type MergeHold = { heldBy: string; heldAt: string };

export type CommandRow = Selectable<DB["github_commands"]>;
export type NewCommand = Pick<CommandRow, "comment_id" | "repo" | "number" | "pr" | "login" | "github_id" | "created_at" | "requested_at" | "parsed">;
export type CommandState = "done" | "refused" | "ignored" | "expired";
export type CommandSettle = { commentId: number; state: CommandState; result: string | null; reply: boolean; allowed: boolean; at: string };
export type CommandProgress = { commentId: number; triedAt?: string; retryInc?: boolean; reply?: "posted" | "failed" | "none" };

export type StatusRow = Selectable<DB["pr_status_comments"]>;

export type RepinState = string;
/** The request a row was read with: its pair, asker, and (to refuse a newer command by the same asker) the request time. */
export type RepinKey = { repo: string; number: number; refRepo: string; refNumber: number; login: string; requestedAt?: string };
export type RepinRow = Selectable<DB["autorepins"]>;
export type RepinRequest = { repo: string; number: number; refRepo: string; refNumber: number; refBranch: string | null; login: string; githubId: number; off?: boolean; at?: string };
export type RepinPatch = Partial<Pick<RepinRow, "state" | "sha" | "head" | "task_id" | "tries" | "tried_at" | "to_head" | "result" | "done_at" | "notice">>;

export type ActionKind = "close" | "comment-close" | "merge";
export type ActionState = "pending" | "waiting-token" | "waiting-permission" | "done" | "failed" | "stopped" | "skipped";
export type WorkflowAction = Omit<Selectable<DB["workflow_actions"]>, "kind" | "state"> & { kind: ActionKind; state: ActionState };
/** How a close ends the item, as `workflow_actions.close_as` stores it. */
export type CloseAs = "completed" | "not-planned" | `duplicate ${string}#${number}`;
export type NewAction = { workflowId: number; repo: string; number: number; kind: ActionKind; by: string; head: string | null; state?: ActionState; at?: string; closeAs?: CloseAs | null };
export type DueAction = WorkflowAction & { weight: number; itemState: string | null; itemHead: string | null };
export type Surface2 = Surface;

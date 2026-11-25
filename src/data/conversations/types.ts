import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { RefKey };

export type CardState = "proposed" | "queued" | "running" | "done" | "failed" | "dismissed" | "replaced";
/** `params` and `text` stay opaque JSON; feature code validates them. */
export type CardKind = "command" | "comment" | "label";
export type TurnKind = "operator" | "maintainer" | "opus" | "system";
export type HeldState = "held" | "filing" | "filed" | "failed" | "dropped" | "skipped";

export type ConversationRow = Selectable<DB["conversations"]>;
export type TurnRow = Omit<Selectable<DB["conversation_turns"]>, "kind"> & { kind: TurnKind };
export type CardRow = Omit<Selectable<DB["conversation_cards"]>, "kind" | "state" | "choice_id" | "dispute_by" | "dispute_reason" | "dispute_at"> & { kind: CardKind; state: CardState };
export type HeldRow = Omit<Selectable<DB["held_followups"]>, "choice_id" | "decision_id" | "answer_seq" | "preapproval_id" | "state"> & { workflow_id: number | null; approved_at: string | null; state: HeldState };
export type Thread = { conversation: ConversationRow; turns: TurnRow[]; cards: CardRow[]; waiting: TurnRow | null; queue?: Queue };
export type TurnTail = { maxSeq: number; waiting: TurnRow | null; heldIds: number[]; lastPersonBlock: string | null };
export type PendingTurn = { repo: string; number: number; turnId: number; kind: "operator" | "maintainer"; login: string };
export type GuidanceTurn = { kind: TurnKind; login: string; at: string; body: string };
export type TurnEvent = { id: number; repo: string; number: number; kind: TurnKind; login: string; at: string; len: number; status: string | null };
export type TurnDigest = { n: number; newest: number; states: string };

export type NewConversation = { repo: string; number: number; item_block: string; item_sig: string; created_by: string; created_at?: string };
export type NewCard = { kind: CardKind; params: string; text: string | null; description: string };
export type NewTurn = { ref: RefKey; kind: TurnKind; login: string; body: string; block: string; status?: string; notes?: string; cards?: NewCard[]; onlyIfThread?: boolean };
export type PostMessage = {
  ref: RefKey; by: { login: string; kind: "operator" | "maintainer" }; turn: NewTurn; ask: boolean; newConversation?: NewConversation;
  refresh?: { expectSig: string; sig: string; turn: NewTurn };
};
export type CardPatch = Partial<Pick<CardRow, "state" | "result" | "result_url" | "error" | "acted_by" | "acted_at" | "edited_by" | "edited_at" | "text" | "params" | "queued_at" | "queue_args">>;
export type QueuedCard = CardRow & { place: number };
export type Queue = { rows: QueuedCard[]; blocked: Set<string> };
export type ActRoom = { limit: number | null; used: number; reserve: number };

export type NewHeld = { card_id: number; workflow_id: number | null; approved_at: string | null; repo: string; number: number; issue_repo: string; title: string; body: string; by: string; at: string };
export type HeldPatch = Partial<Pick<HeldRow, "state" | "issue_number" | "url" | "reason" | "attempts" | "updated_at">>;
export type PathEnd = "merged" | "closed" | "stopped" | null;
export type HeldInput = HeldRow & { item: { state: string; merged_at: string | null } | null; path: PathEnd; filingAudit: { number: number; url: string } | null };
export type DueHeld = { rows: HeldInput[]; byRepo: Map<string, HeldInput[]> };

export type Statement = { id: number; repo: string; number: number | null; text: string };
export type StatementWork = Statement & { source_kind: string; source_id: string; embedded: boolean };
export type StatementVec = Statement & { model: string; vec: Uint8Array };
export type StatementView = Statement & { kind: string | null; state: string | null; title: string | null };

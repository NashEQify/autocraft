// Conversations and turns (M12 conversations).
import type { Db } from "../../db/index.ts";
import type { GuidanceTurn, NewConversation, NewTurn, PendingTurn, PostMessage, RefKey, ConversationRow, Thread, TurnDigest, TurnEvent, TurnKind, TurnRow, TurnTail } from "./types.ts";

/** Conversation, turns (display order), cards and the waiting turn in one wave; `block` only with `blocks`; `withQueue` adds the card queue snapshot. */
export async function loadThreads(db: Db, refs: RefKey[], o?: { blocks?: boolean; withQueue?: boolean }): Promise<Map<RefKey, Thread>> {
  throw new Error("not built: conversations.loadThreads");
}

/** Conversation rows. */
export async function loadConversations(db: Db, refs: RefKey[]): Promise<Map<RefKey, ConversationRow>> {
  throw new Error("not built: conversations.loadConversations");
}

/** Max seq, waiting turn, held ids and the newest person block per item; replaces `nextSeq`, `pendingTurn` and `seenSteps`. */
export async function loadTurnTails(db: Db, refs: RefKey[]): Promise<Map<RefKey, TurnTail>> {
  throw new Error("not built: conversations.loadTurnTails");
}

/** Operator and maintainer turns waiting for an answer, oldest first. */
export async function loadPending(db: Db, o: { now: Date; staleMs: number }): Promise<PendingTurn[]> {
  throw new Error("not built: conversations.loadPending");
}

/** Operator and maintainer turns by `at, id`. */
export async function loadGuidanceTurns(db: Db, refs: RefKey[]): Promise<Map<RefKey, GuidanceTurn[]>> {
  throw new Error("not built: conversations.loadGuidanceTurns");
}

/** For the activity feed and the item trace. */
export async function loadTurnEvents(db: Db, f: { refs?: RefKey[]; since?: string; kinds?: TurnKind[]; limit?: number }): Promise<TurnEvent[]> {
  throw new Error("not built: conversations.loadTurnEvents");
}

/** The trace signature. */
export async function loadTurnDigests(db: Db, refs: RefKey[]): Promise<Map<RefKey, TurnDigest>> {
  throw new Error("not built: conversations.loadTurnDigests");
}

/** `on conflict do nothing returning`; returns the refs created. */
export async function saveConversations(db: Db, rows: NewConversation[]): Promise<Set<RefKey>> {
  throw new Error("not built: conversations.saveConversations");
}

/** Assigns `seq` or the held and pending state as `appendTurn` does, supersedes the item's proposed cards when an `opus` turn arrives, inserts the cards; the one entry for system lines. A ref without a conversation is skipped when `onlyIfThread` is set. */
export async function addTurns(db: Db, turns: NewTurn[], deps?: { now?: () => Date }): Promise<number[]> {
  throw new Error("not built: conversations.addTurns");
}

/** One transaction: creates the conversation if absent, appends the refresh turn when `item_sig` still equals `expectSig`, appends the person's message as pending when `ask`; maps the `conversation_turns_waiting` unique violation to `ConversationError(409)`. */
export async function postMessage(db: Db, p: PostMessage): Promise<number> {
  throw new Error("not built: conversations.postMessage");
}

/** The Conversation step's refresh before a claim: compare-and-set on `item_sig`. */
export async function refreshSig(db: Db, ref: RefKey, p: { expectSig: string; sig: string; turn: NewTurn }): Promise<boolean> {
  throw new Error("not built: conversations.refreshSig");
}

/** Releases a stale claim, gives held turns a seq, claims the pending message `RETURNING`. */
export async function claimTurn(db: Db, ref: RefKey, o: { now: Date; staleMs: number }): Promise<{ turn: TurnRow; claim: string } | null> {
  throw new Error("not built: conversations.claimTurn");
}

/** Writes progress lines. */
export async function setProgress(db: Db, ref: RefKey, claim: string, lines: string[]): Promise<void> {
  throw new Error("not built: conversations.setProgress");
}

/** Returns a claimed turn to pending. */
export async function releaseTurn(db: Db, ref: RefKey, claim: string): Promise<boolean> {
  throw new Error("not built: conversations.releaseTurn");
}

/** Settles a claimed turn as failed. */
export async function failTurn(db: Db, ref: RefKey, claim: string, error: string): Promise<boolean> {
  throw new Error("not built: conversations.failTurn");
}

/** Settles the turn and inserts the reply with its cards. */
export async function storeReply(db: Db, ref: RefKey, claim: string, reply: { turn: NewTurn; seen: string | null }): Promise<number | null> {
  throw new Error("not built: conversations.storeReply");
}

/** Withdraws the waiting turn and calls `runners.withdrawCalls`. */
export async function withdrawTurn(db: Db, ref: RefKey, by: { login: string; operator: boolean }): Promise<void> {
  throw new Error("not built: conversations.withdrawTurn");
}

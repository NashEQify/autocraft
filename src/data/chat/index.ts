// Stand-in for the chat data module until it is merged: the same exports, read straight from the tables.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import type { ChatMessageRow, ConversationRow } from "./types.ts";

export * from "./types.ts";

export async function loadConversationsOfItem(db: Db, repo: string, number: number): Promise<ConversationRow[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.chat_conversations").selectAll().where("repo", "=", repo).where("number", "=", number).orderBy("id")) as Record<string, unknown>[];
  return rows.map((r) => ({ id: Number(r.id), repo: r.repo as string | null, number: r.number === null ? null : Number(r.number), title: String(r.title), createdAt: String(r.created_at), createdBy: String(r.created_by) }));
}

export async function loadMessages(db: Db, conversationIds: number[], sinceId?: number): Promise<Map<number, ChatMessageRow[]>> {
  const out = new Map<number, ChatMessageRow[]>();
  if (!conversationIds.length) return out;
  const q = queryDb(db);
  let qb = (q.k as any).selectFrom("main.chat_messages").selectAll().where("conversation_id", "in", conversationIds);
  if (sinceId !== undefined) qb = qb.where("id", ">", sinceId);
  const rows = await q.all(qb.orderBy("id")) as Record<string, unknown>[];
  for (const r of rows) {
    const m: ChatMessageRow = {
      id: Number(r.id), conversationId: Number(r.conversation_id), author: String(r.author), via: r.via as ChatMessageRow["via"], kind: r.kind as ChatMessageRow["kind"], body: String(r.body),
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? null, workflowEventId: r.workflow_event_id === null ? null : Number(r.workflow_event_id),
      turnId: r.turn_id === null ? null : Number(r.turn_id), at: String(r.at),
    };
    (out.get(m.conversationId) ?? out.set(m.conversationId, []).get(m.conversationId)!).push(m);
  }
  return out;
}

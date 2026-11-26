// Chat conversations and messages (`chat_conversations`, `chat_messages`).

export type ChatMessageVia = "dashboard" | "github" | "discord" | "agent" | "cli" | "autocraft";
export type ChatMessageKind = "said" | "recommended" | "finished";

export type ConversationRow = { id: number; repo: string | null; number: number | null; title: string; createdAt: string; createdBy: string };
export type ChatMessageRow = {
  id: number; conversationId: number; author: string; via: ChatMessageVia; kind: ChatMessageKind; body: string; payload: unknown;
  workflowEventId: number | null; turnId: number | null; at: string;
};

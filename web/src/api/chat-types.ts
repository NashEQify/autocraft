// The item conversation read, as the chat views use it. The server contract lives in the chat read API; these are the shapes the views take.

/** Where a person's message to AutoCraft was written. */
export type ChatVia = "dashboard" | "github" | "discord" | "agent" | "cli";
export interface ChatFinding { n: number; title: string; file: string | null; major: boolean }
/** One discord mention of the item: the link opens the message in Discord; `channel` is null for a channel the bot cannot name. */
export interface ChatDiscordLink { url: string; at: string; channel: string | null }
/**
 * One entry of an item conversation, oldest first. `work` is something AutoCraft did; `github` stands for GitHub activity not addressed
 * to AutoCraft (`count` can exceed `lines.length` when the lines are cut); `discord` for mentions of the item on Discord.
 */
export type ChatEntry =
  | { t: "said"; id: string; at: string; login: string; via: ChatVia; body: string; url: string | null; /** Waiting for AutoCraft's answer. */ pending?: boolean; /** Why the message was not acted on. */ refusal?: string | null }
  | { t: "reply"; id: string; at: string; body: string; findings: ChatFinding[]; ask: { to: string[]; question: string } | null }
  | { t: "work"; id: string; at: string; state: "done" | "running" | "failed"; title: string; model: string | null; seconds: number | null; costUsd: number | null; outcome: string | null; detail: [string, string][]; eventId: string | null }
  | { t: "github"; id: string; at: string; lines: string[]; count?: number; eventIds?: string[] }
  | { t: "discord"; id: string; at: string; links: ChatDiscordLink[] };
export interface ItemConversation {
  id: string;
  title: string;
  entries: ChatEntry[];
  /** The open question: who it asks. */
  open: { to: string[]; question: string } | null;
  canReply: boolean;
  /** AutoCraft is working: the running step's line. */
  working: string | null;
}
/** Where AutoCraft is with an item, for the item header. */
export type ItemChatState = "running" | "waiting" | "held" | "done" | "idle";
/** `status` is the one line the item header shows; `next` is what follows (null when nothing does). */
export interface ItemChat { repo: string; number: number; stamp?: string; status: string; state: ItemChatState; next: string | null; conversations: ItemConversation[] }

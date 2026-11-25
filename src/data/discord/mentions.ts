// Mention rows (`discord_mentions`).
import type { Db } from "../../db/index.ts";
import type { MentionChange, MentionRow, Ref } from "./types.ts";

/** The rows of each message. */
export async function loadMessageMentions(db: Db, msgHashes: string[]): Promise<Map<string, MentionRow[]>> { throw new Error("not built: discord.loadMessageMentions"); }
/** Rows per item for the item page. */
export async function loadMentionsOfItems(db: Db, refs: Ref[]): Promise<Map<Ref, MentionRow[]>> { throw new Error("not built: discord.loadMentionsOfItems"); }
/** Alias of `loadMentionsOfItems` for the item page and list. */
export async function loadItemDiscord(db: Db, refs: Ref[]): Promise<Map<Ref, MentionRow[]>> { throw new Error("not built: discord.loadItemDiscord"); }
/** Mention and signal counts per item, in one grouped statement. */
export async function loadMentionCounts(db: Db, refs: Ref[]): Promise<Map<Ref, { count: number; signals: number }>> { throw new Error("not built: discord.loadMentionCounts"); }
/** Deletes the named (message, ref) rows and inserts the rest multi-row `ON CONFLICT DO NOTHING`; returns rows newly added. */
export async function saveMessageMentions(db: Db, changes: MentionChange[]): Promise<number> { throw new Error("not built: discord.saveMessageMentions"); }
/** Sets the signal flag with `kx.updateFrom`. */
export async function setSignals(db: Db, rows: { msgHash: string; repo: string; number: number; signal: boolean }[]): Promise<number> { throw new Error("not built: discord.setSignals"); }
/** Deletes the mention rows of messages. */
export async function removeMentionsOfMessages(db: Db, msgHashes: string[]): Promise<number> { throw new Error("not built: discord.removeMentionsOfMessages"); }
/** Deletes replies and mentions of the channel hashes. */
export async function forgetChannels(db: Db, channelHashes: string[]): Promise<{ replies: number; mentions: number }> { throw new Error("not built: discord.forgetChannels"); }
/** Every row, for the deletion request `forgetAuthor` (the author is sealed); `alone`. */
export async function loadSealedMentions(db: Db): Promise<{ msgHash: string; repo: string; number: number; sealed: string }[]> { throw new Error("not built: discord.loadSealedMentions"); }
/** Deletes rows by (message, item); 1 statement per 10,000 rows. */
export async function removeMentionRows(db: Db, rows: { msgHash: string; repo: string; number: number }[]): Promise<number> { throw new Error("not built: discord.removeMentionRows"); }

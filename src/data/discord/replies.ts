// The bot's replies to pings (`discord_replies`).
import type { Db } from "../../db/index.ts";
import type { ReplyRow } from "./types.ts";

/** Replies whose ping or quoted message is any of the hashes, distinct by `ping_hash`. */
export async function loadRepliesOf(db: Db, msgHashes: string[]): Promise<ReplyRow[]> { throw new Error("not built: discord.loadRepliesOf"); }
/** Which pings already have a reply. */
export async function loadReplyPings(db: Db, pingHashes: string[]): Promise<Set<string>> { throw new Error("not built: discord.loadReplyPings"); }
/** Upserts replies. */
export async function saveReplies(db: Db, rows: (ReplyRow & { channelHash: string })[]): Promise<void> { throw new Error("not built: discord.saveReplies"); }
/** Deletes the replies to pings. */
export async function removeReplies(db: Db, pingHashes: string[]): Promise<number> { throw new Error("not built: discord.removeReplies"); }

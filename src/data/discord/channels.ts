// Channels, categories and gateway status (`discord_channels`, `discord_categories`, `discord_status`).
import type { Db } from "../../db/index.ts";
import type { CategoryRow, ChannelBrief, ChannelReport, ChannelRow, StatusRow } from "./types.ts";

/** Watched channels (a channel is watched when it or its parent is); absent otherwise. */
export async function loadWatchedChannels(db: Db, channelIds: string[]): Promise<Map<string, { guildId: string }>> { throw new Error("not built: discord.loadWatchedChannels"); }
/** Ids of channels under the parents or in the guild. */
export async function loadChannelTree(db: Db, f: { parentIds?: string[]; guildId?: string }): Promise<string[]> { throw new Error("not built: discord.loadChannelTree"); }
/** Top-level channels joined to their categories, viewable or watched, in the existing sort. */
export async function listChannelRows(db: Db): Promise<ChannelRow[]> { throw new Error("not built: discord.listChannelRows"); }
/** Channel list for the CLI. */
export async function listChannelBriefs(db: Db): Promise<ChannelBrief[]> { throw new Error("not built: discord.listChannelBriefs"); }
/** Each channel's default repo: its own, else its parent's. */
export async function loadChannelDefaults(db: Db, channelIds: string[]): Promise<Map<string, { defaultRepo: string | null }>> { throw new Error("not built: discord.loadChannelDefaults"); }
/** The panel message id per channel. */
export async function loadPanelMessages(db: Db, channelIds: string[]): Promise<Map<string, { panelMessage: string | null }>> { throw new Error("not built: discord.loadPanelMessages"); }
/** Upserts channels; `watched`, `default_repo` and `panel_message` are never overwritten, `viewable` changes only for rows that carry it. */
export async function saveChannels(db: Db, rows: ChannelReport[]): Promise<void> { throw new Error("not built: discord.saveChannels"); }
/** Upserts categories; joins the caller's transaction. */
export async function saveCategories(db: Db, rows: CategoryRow[]): Promise<void> { throw new Error("not built: discord.saveCategories"); }
/** Sets `viewable` with `kx.updateFrom`. */
export async function setViewable(db: Db, rows: { channelId: string; viewable: boolean }[]): Promise<number> { throw new Error("not built: discord.setViewable"); }
/** Watches or unwatches a channel; 0 rows changed means an unknown channel. */
export async function markWatched(db: Db, channelId: string, watched: boolean): Promise<number> { throw new Error("not built: discord.markWatched"); }
/** Sets or clears a channel's default repo. */
export async function setDefaultRepo(db: Db, channelId: string, repo: string | null): Promise<number> { throw new Error("not built: discord.setDefaultRepo"); }
/** Stores the panel message id. */
export async function setPanelMessage(db: Db, channelId: string, messageId: string): Promise<void> { throw new Error("not built: discord.setPanelMessage"); }
/** Deletes channels and categories of a channel tree or a guild. */
export async function removeChannelTree(db: Db, f: { channelOrParentId: string } | { guildId: string }): Promise<void> { throw new Error("not built: discord.removeChannelTree"); }
/** Stores the gateway status. */
export async function saveStatus(db: Db, state: string, detail: string | null, at: string): Promise<void> { throw new Error("not built: discord.saveStatus"); }
/** The gateway status. */
export async function loadStatus(db: Db): Promise<StatusRow | null> { throw new Error("not built: discord.loadStatus"); }

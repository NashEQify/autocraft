// Usage counters (`discord_events`).
import type { Db } from "../../db/index.ts";
import type { EventCounts, EventKind } from "./types.ts";

/** Inserts events. */
export async function addEvents(db: Db, rows: { kind: EventKind; atIso: string }[]): Promise<void> { throw new Error("not built: discord.addEvents"); }
/** Deletes events before a time; called at bot start and by the hourly status tick. */
export async function pruneEvents(db: Db, beforeIso: string): Promise<number> { throw new Error("not built: discord.pruneEvents"); }
/** Counts per kind over the last 24 hours and 7 days in one grouped statement. */
export async function countEvents(db: Db, nowMs: number): Promise<EventCounts> { throw new Error("not built: discord.countEvents"); }

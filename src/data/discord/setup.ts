// The Discord admin page's read model.
import type { Db } from "../../db/index.ts";
import type { DiscordSetupData } from "./types.ts";

/** Status, channels, filing, hidden, recent filed and event counts: 6 statements in 1 round trip; the page composes the rest in the same wave. */
export async function loadDiscordSetup(db: Db, o: { nowMs: number }): Promise<DiscordSetupData> { throw new Error("not built: discord.loadDiscordSetup"); }

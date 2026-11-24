// Adds a 🤖 reaction to a message the bot has just recorded against items, so people see it was picked up.
// The gateway handler stays free of network calls: it hands the message here and this fires the request without waiting.
import { RestError, type RestClient } from "./rest.ts";
import type { Db } from "../db/index.ts";

type ReactRest = Pick<RestClient, "addReaction">;

export const REACTION = "🤖";

/** The operators' switch on the Discord page; on unless switched off. */
export const reactOn = async (db: Db): Promise<boolean> =>
  (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "discord_react")))?.value !== "off";

export class Reactor {
  #d: { db: Db; rest: ReactRest; log: (l: string) => void };
  #logged = new Set<string>();

  constructor(d: { db: Db; rest: ReactRest; log: (l: string) => void }) {
    this.#d = d;
  }

  /** Fire and forget. A refusal is logged once per channel and status and never retried. */
  async recorded(channelId: string, messageId: string): Promise<void> {
    if (!await reactOn(this.#d.db)) return;
    void this.#d.rest.addReaction(channelId, messageId, REACTION).catch((e: unknown) => {
      const status = e instanceof RestError ? e.status : 0;
      const kind = status === 403 ? "missing the Add Reactions permission" : status === 404 ? "message no longer exists" : (e as Error).message;
      const key = `${channelId}|${status || kind}`;
      if (this.#logged.has(key)) return;
      this.#logged.add(key);
      this.#d.log(`runner: Discord reaction in channel ${channelId} failed: ${kind}`);
    });
  }
}

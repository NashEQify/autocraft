// The bot's replies to pings. A reply row is found by the ping's or the quoted message's keyed hash; deleting a reply
// deletes the Discord message first and the row after, so a failed delete leaves the row for a later request.
import type { DiscordKeys } from "./keys.ts";
import type { DiscordRest } from "./rest.ts";
import type { Db } from "../db/index.ts";

/** Deletes the replies whose ping or quoted message is one of `ids`. Returns how many rows were removed. */
export async function deleteRepliesOf(db: Db, keys: DiscordKeys, rest: DiscordRest, ids: string[], log: (line: string) => void): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const h = keys.hash("message", id);
    for (const r of await db.all(db.k.selectFrom("discord_replies").select(["ping_hash", "sealed"]).where((eb) => eb.or([eb("ping_hash", "=", h), eb("quoted_hash", "=", h)])))) {
      const ref = keys.open(r.sealed, r.ping_hash);
      try {
        if (ref) await rest.deleteMessage(ref.channelId, ref.messageId);
      } catch (e) {
        log(`discord: deleting a reply failed: ${(e as Error).message}`);
        continue;
      }
      n += Number((await db.run(db.k.deleteFrom("discord_replies").where("ping_hash", "=", r.ping_hash))).changes);
    }
  }
  return n;
}

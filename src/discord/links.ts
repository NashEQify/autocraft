// Links between a Discord account and a dashboard login. The Discord user id is never stored: a link holds its keyed hash.
// A signed-in dashboard user asks for a short single-use code and types it into the bot in Discord (`/autocraft link`), so
// the link is always made by the person who controls both accounts. Codes are stored as keyed hashes and expire.
import { randomInt } from "node:crypto";
import type { DiscordKeys } from "./keys.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export const CODE_TTL_MS = 10 * 60_000;
const CODE_LENGTH = 8;
/** No 0/O, 1/I/L: a code is read off one screen and typed into another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const userHash = (keys: DiscordKeys, discordUserId: string): string => keys.hash("author", discordUserId);
const codeHash = (keys: DiscordKeys, code: string): string => keys.sign("link-code", code.toUpperCase().replace(/[^A-Z0-9]/g, ""));

/** A new code for `login`; an earlier unused code of the login stops working. */
export async function createLinkCode(db: Db, keys: DiscordKeys, login: string, now = Date.now()): Promise<{ code: string; expiresAt: string }> {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  await db.write(async () => {
    await db.run(db.k.deleteFrom("discord_link_codes").where((eb) => eb.or([eb("login", "=", login), eb("expires_at", "<=", new Date(now).toISOString())])));
    await db.run(db.k.insertInto("discord_link_codes").values({ code_hash: codeHash(keys, code), login, expires_at: expiresAt }));
  });
  return { code, expiresAt };
}

/** Spends a code and links `discordUserId` to the login the code was made for. Returns the login, or null for a wrong, used or expired code. A Discord account has one login, so an earlier link of it is replaced. */
export async function redeemLinkCode(db: Db, keys: DiscordKeys, code: string, discordUserId: string, now = Date.now()): Promise<string | null> {
  const h = codeHash(keys, code);
  return await db.write(async () => {
    const row = await db.get(db.k.selectFrom("discord_link_codes").select(["login", "expires_at as expiresAt"]).where("code_hash", "=", h));
    if (!row) return null;
    await db.run(db.k.deleteFrom("discord_link_codes").where("code_hash", "=", h));
    if (Date.parse(row.expiresAt) <= now) return null;
    await db.run(db.k.insertInto("discord_links").values({ user_hash: userHash(keys, discordUserId), login: row.login, linked_at: new Date(now).toISOString() })
      .onConflict((oc) => oc.column("user_hash").doUpdateSet(excluded(["login", "linked_at"]))));
    return row.login;
  });
}

/** The dashboard login linked to a Discord user, or null. */
export const loginOf = async (db: Db, keys: DiscordKeys, discordUserId: string): Promise<string | null> =>
  (await db.get(db.k.selectFrom("discord_links").select("login").where("user_hash", "=", userHash(keys, discordUserId))))?.login ?? null;

/** Removes every link of a login; returns how many. */
export const unlinkLogin = async (db: Db, login: string): Promise<number> =>
  Number((await db.run(db.k.deleteFrom("discord_links").where("login", "=", login))).changes);

/** Removes one link by its row id (the keyed hash); returns the login it belonged to, or null. */
export async function unlinkRow(db: Db, id: string): Promise<string | null> {
  const row = await db.get(db.k.selectFrom("discord_links").select("login").where("user_hash", "=", id));
  if (!row) return null;
  await db.run(db.k.deleteFrom("discord_links").where("user_hash", "=", id));
  return row.login;
}

/** Part of a deletion request by Discord user id. */
export const forgetLink = async (db: Db, keys: DiscordKeys, discordUserId: string): Promise<number> =>
  Number((await db.run(db.k.deleteFrom("discord_links").where("user_hash", "=", userHash(keys, discordUserId)))).changes);

export type LinkRow = { id: string; login: string; linkedAt: string };
export const listLinks = async (db: Db): Promise<LinkRow[]> =>
  await db.all(db.k.selectFrom("discord_links").select(["user_hash as id", "login", "linked_at as linkedAt"]).orderBy("login").orderBy("linked_at"));

export const linkedSince = async (db: Db, login: string): Promise<string | null> =>
  (await db.get(db.k.selectFrom("discord_links").select((eb) => eb.fn.min<string | null>("linked_at").as("at")).where("login", "=", login)))!.at;

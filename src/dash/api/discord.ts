// Discord mentions: the admin page's data and writes, and what the item page shows. The channel list and the
// connection state are written by the runner's gateway client (src/discord/); this file only reads them.
import type { DiscordAccount, DiscordLinkCode, DiscordInfo, DiscordSetup } from "../../../web/src/api/types.ts";
import { envVar } from "../../env.ts";
import { excluded } from "../../db/kx.ts";
import { audit } from "../audit.ts";
import { isPublicRepo, publicRepoNames } from "../../public/status.ts";
import { HttpError } from "../server/util.ts";
import { DISCORD_PRIVACY_PATH } from "../server/discord-privacy.ts";
import { readKeyFile, type DiscordKeys } from "../../discord/keys.ts";
import { countOf, linksOf } from "../../discord/store.ts";
import { reactOn } from "../../discord/react.ts";
import { signalCountOf, signalLinks } from "../../discord/signals.ts";
import { createLinkCode, linkedSince, listLinks, unlinkLogin, unlinkRow } from "../../discord/links.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

const PRIVACY_PATH = DISCORD_PRIVACY_PATH;

let cached: { file: string; keys: DiscordKeys } | null = null;
/** The key file's keys, when this process has AUTOCRAFT_DISCORD_KEY_FILE and the file is sound; message links need them. */
export function discordKeys(): DiscordKeys | null {
  const file = envVar("DISCORD_KEY_FILE");
  if (!file) return null;
  if (cached?.file === file) return cached.keys;
  try {
    cached = { file, keys: readKeyFile(file) };
    return cached.keys;
  } catch {
    // Not cached: a file that is fixed later works at the next request. The page shows counts without links meanwhile.
    return null;
  }
}

export const contactOf = async (db: Db): Promise<string> =>
  (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "discord_contact")))?.value ?? "";

/** Count for everyone who sees the item; message links only with the key. */
export async function discordOf(db: Db, repo: string, n: number): Promise<DiscordInfo> {
  const keys = discordKeys();
  return { count: await countOf(db, repo, n), links: await linksOf(db, keys, repo, n), signals: await signalCountOf(db, repo, n), signalLinks: await signalLinks(db, keys, repo, n) };
}

const operator = (req: Req): void => {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators use the Discord settings");
};
const body = (req: Req): Record<string, unknown> => (req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {});

async function setupOf(db: Db): Promise<DiscordSetup> {
  const st = await db.get(db.k.selectFrom("discord_status").select(["state", "detail", "at"]).where("id", "=", 1).$narrowType<{ state: DiscordSetup["state"] }>());
  const channels = await db.all(db.k.selectFrom("discord_channels as c")
    .leftJoin("discord_categories as k", (j) => j.onRef("k.category_id", "=", "c.category_id").onRef("k.guild_id", "=", "c.guild_id"))
    .select(["c.channel_id as channelId", "c.guild_id as guildId", "c.guild_name as guildName", "c.name", "c.watched", "c.default_repo as defaultRepo", "k.name as category"])
    .where("c.parent_id", "is", null)
    .orderBy("c.guild_name", (o) => o.asc().nullsFirst()).orderBy("c.guild_id")
    .orderBy((eb) => eb("k.category_id", "is not", null)).orderBy((eb) => eb("k.position", "is", null))
    .orderBy("k.position", (o) => o.asc().nullsFirst()).orderBy("k.category_id", (o) => o.asc().nullsFirst())
    .orderBy((eb) => eb("c.position", "is", null)).orderBy("c.position", (o) => o.asc().nullsFirst()).orderBy("c.channel_id"));
  return {
    state: st?.state ?? "off", detail: st?.detail ?? null, at: st?.at ?? null,
    channels: channels.map((c) => ({ ...c, watched: !!c.watched })),
    repos: await publicRepoNames(db),
    contact: await contactOf(db), reactOn: await reactOn(db), privacyPath: PRIVACY_PATH, links: await listLinks(db),
  };
}

export async function setup(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  return await setupOf(db);
}

export async function putChannel(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).channelId, watched = body(req).watched;
  if (typeof id !== "string" || typeof watched !== "boolean") throw new HttpError(400, "channelId and watched are required");
  const r = await db.run(db.k.updateTable("discord_channels").set({ watched: watched ? 1 : 0 }).where("channel_id", "=", id));
  if (!r.changes) throw new HttpError(404, "the bot has not reported that channel");
  await audit(db, req.user.login, watched ? "discord-watch" : "discord-unwatch", id);
  return await setupOf(db);
}

export async function putChannelRepo(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).channelId, repo = body(req).repo;
  if (typeof id !== "string" || (repo !== null && typeof repo !== "string")) throw new HttpError(400, "channelId and repo (a tracked repo or null) are required");
  if (repo !== null && !await isPublicRepo(db, repo)) throw new HttpError(400, "repo is not a public tracked repo");
  const r = await db.run(db.k.updateTable("discord_channels").set({ default_repo: repo }).where("channel_id", "=", id));
  if (!r.changes) throw new HttpError(404, "the bot has not reported that channel");
  await audit(db, req.user.login, "discord-default-repo", id, { repo });
  return await setupOf(db);
}

export async function putContact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const c = body(req).contact;
  if (typeof c !== "string" || c.length > 300) throw new HttpError(400, "contact must be text of at most 300 characters");
  await db.run(db.k.insertInto("settings").values({ key: "discord_contact", value: c.trim() }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await audit(db, req.user.login, "discord-contact", null);
  return await setupOf(db);
}

export async function putReact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const on = body(req).on;
  if (typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
  await db.run(db.k.insertInto("settings").values({ key: "discord_react", value: on ? "on" : "off" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await audit(db, req.user.login, on ? "discord-react-on" : "discord-react-off", null);
  return await setupOf(db);
}

/** Whether the signed-in user has a Discord account linked, and whether this server can make link codes (it has the key file). */
export const account = async (db: Db, req: Req): Promise<DiscordAccount> => {
  const at = await linkedSince(db, req.user.login);
  return { linked: at !== null, at, configured: discordKeys() !== null };
};

/** A single-use code, valid for 10 minutes, that links a Discord account to the signed-in login when typed into the bot's `/autocraft link`. */
export async function linkCode(db: Db, req: Req): Promise<DiscordLinkCode> {
  const keys = discordKeys();
  if (!keys) throw new HttpError(503, "Discord is not set up on this server");
  const c = await createLinkCode(db, keys, req.user.login);
  await audit(db, req.user.login, "discord-link-code", req.user.login);
  return c;
}

export async function unlinkOwn(db: Db, req: Req): Promise<DiscordAccount> {
  const n = await unlinkLogin(db, req.user.login);
  if (n) await audit(db, req.user.login, "discord-unlink", req.user.login, { links: n });
  return await account(db, req);
}

export async function removeLink(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).id;
  if (typeof id !== "string") throw new HttpError(400, "id is required");
  const login = await unlinkRow(db, id);
  if (login === null) throw new HttpError(404, "no such link");
  await audit(db, req.user.login, "discord-unlink", login, { by: "operator" });
  return await setupOf(db);
}

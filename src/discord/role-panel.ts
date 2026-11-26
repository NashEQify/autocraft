// The contributor role panel: one bot message with a Verify button in the channel an operator chooses. Pressing it
// gives the presser the configured role when the GitHub login linked to their Discord account (the `/autocraft link`
// flow, or a GitHub sign-in made for filing) has authored a merged pull request in a repo of the tracked owner. A typed
// GitHub name is never asked for. The channel and role are instance settings (Discord admin page or
// `autocraft-server discord role-panel`); the guild is the channel's. The runner posts the panel when the settings
// change, edits it in place at start, and deletes the old message when the channel moves or the feature is turned off.
import { execFile } from "node:child_process";
import { LOGIN } from "../access.ts";
import { exclusive } from "../async-seq.ts";
import { audit } from "./audit.ts";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { loginOf } from "./links.ts";
import { RestError, type MessageBody } from "./rest.ts";
import { WindowLimits } from "./window-limit.ts";
import { deleteSetting, setting, settings, writeSetting } from "../data/control/index.ts";
import { loadChannelGuilds } from "../data/discord/index.ts";
import { loadAuthorHistory } from "../data/mirror/index.ts";
import { loadReporterSealed } from "../data/access/index.ts";
import { AppReadError, readEnv, trackedOwner } from "../github/read.ts";
import { ownerOf } from "../owners.ts";
import { t } from "../i18n/index.ts";
import type { Db } from "../db/index.ts";

export const ROLE_CHANNEL_KEY = "discord_role_channel";
export const ROLE_ID_KEY = "discord_role_id";
/** Where the runner keeps the posted panel (a bookkeeping setting: writing it wakes no page and no planner). */
export const ROLE_PANEL_KEY = "discord_role_panel";

const SNOWFLAKE = /^\d{15,22}$/;
/** Verify presses per person, and for everyone together (each may cost one GitHub search). */
const PER_USER = { n: 3, ms: 10 * 60_000 };
const ALL_USERS = { n: 20, ms: 60_000 };
/** A failed post is tried again after this long, or at the next settings change. */
const RETRY_MS = 5 * 60_000;
const POLL_MS = 2000;

export type RoleConfig = { channelId: string; guildId: string; roleId: string };
/** The posted panel as the runner last left it; `error` when posting or editing failed. */
export type RolePanelState = { channelId: string; messageId: string | null; error: string | null; at: string };

export class RoleConfigError extends Error {}

/** The configured channel (with its guild) and role, or null when either is unset or the channel is unknown. */
export async function roleConfig(db: Db): Promise<RoleConfig | null> {
  const s = await settings(db, [ROLE_CHANNEL_KEY, ROLE_ID_KEY]);
  const channelId = s.get(ROLE_CHANNEL_KEY), roleId = s.get(ROLE_ID_KEY);
  if (!channelId || !roleId) return null;
  const ch = (await loadChannelGuilds(db, [channelId])).get(channelId);
  return ch ? { channelId, guildId: ch.guildId, roleId } : null;
}

export async function rolePanelState(db: Db): Promise<RolePanelState | null> {
  const v = await setting(db, ROLE_PANEL_KEY);
  if (!v) return null;
  try {
    const s = JSON.parse(v) as RolePanelState;
    return typeof s.channelId === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Sets the channel and role (`cfg`), or turns the feature off (null). Refuses a channel the bot has not reported and ids that are not Discord ids. */
export async function setRoleConfig(db: Db, actor: string, cfg: { channelId: string; roleId: string } | null): Promise<RoleConfig | null> {
  if (!cfg) {
    await db.write(async () => {
      await deleteSetting(db, ROLE_CHANNEL_KEY);
      await deleteSetting(db, ROLE_ID_KEY);
      await audit(db, actor, "discord-role-panel", null, { on: false });
    });
    return null;
  }
  const channelId = cfg.channelId.trim(), roleId = cfg.roleId.trim();
  if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(roleId)) throw new RoleConfigError("channel and role must be Discord ids (digits only)");
  const ch = (await loadChannelGuilds(db, [channelId])).get(channelId);
  if (!ch) throw new RoleConfigError("the bot has not reported that channel");
  if (roleId === ch.guildId) throw new RoleConfigError("that is the server's @everyone role");
  await db.write(async () => {
    await writeSetting(db, ROLE_CHANNEL_KEY, channelId);
    await writeSetting(db, ROLE_ID_KEY, roleId);
    await audit(db, actor, "discord-role-panel", channelId, { on: true, role: roleId });
  });
  return { channelId, guildId: ch.guildId, roleId };
}

export function rolePanelMessage(): MessageBody {
  return {
    content: t("**Contributor role**\nHave a merged pull request in one of our repositories? Press Verify to get the contributor role. AutoCraft checks the GitHub account linked to your Discord account."),
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [{ type: 2, style: 1, label: t("Verify"), custom_id: "rolecheck:verify" }] }],
  };
}

/** What the panel needs from Discord; the REST client, or a fake in tests. */
export type RoleRest = {
  createMessage(channelId: string, body: MessageBody): Promise<{ id: string }>;
  editMessage(channelId: string, messageId: string, body: MessageBody): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  addMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
};

const saveState = async (db: Db, s: Omit<RolePanelState, "at">): Promise<RolePanelState> => {
  const state = { ...s, at: new Date().toISOString() };
  await writeSetting(db, ROLE_PANEL_KEY, JSON.stringify(state));
  return state;
};

/**
 * Makes Discord match the settings: the panel stays (edited in place) in the configured channel, is posted and pinned
 * there when missing, and is deleted from a channel that is no longer configured. Returns the state it stored.
 */
export async function ensureRolePanel(db: Db, rest: RoleRest, log: (l: string) => void): Promise<RolePanelState | null> {
  const [cfg, st] = await Promise.all([roleConfig(db), rolePanelState(db)]);
  if (st?.messageId && st.channelId !== cfg?.channelId) {
    await rest.deleteMessage(st.channelId, st.messageId).catch((e: Error) => log(`discord: removing the old contributor role panel failed: ${e.message}`));
  }
  if (!cfg) {
    if (st) await deleteSetting(db, ROLE_PANEL_KEY);
    return null;
  }
  const body = rolePanelMessage();
  try {
    if (st?.channelId === cfg.channelId && st.messageId) {
      try {
        await rest.editMessage(cfg.channelId, st.messageId, body);
        return await saveState(db, { channelId: cfg.channelId, messageId: st.messageId, error: null });
      } catch (e) {
        if (!(e instanceof RestError && e.status === 404)) throw e;
      }
    }
    const { id } = await rest.createMessage(cfg.channelId, body);
    await rest.pinMessage(cfg.channelId, id).catch((e: Error) => log(`discord: pinning the contributor role panel failed: ${e.message}`));
    return await saveState(db, { channelId: cfg.channelId, messageId: id, error: null });
  } catch (e) {
    log(`discord: posting the contributor role panel in ${cfg.channelId} failed: ${(e as Error).message}`);
    return await saveState(db, { channelId: cfg.channelId, messageId: st?.channelId === cfg.channelId ? st.messageId : null, error: (e as Error).message.slice(0, 300) });
  }
}

/** Runs ensureRolePanel at start and whenever the channel or role setting changes; a failed post is tried again after RETRY_MS. */
export function watchRolePanel(db: Db, rest: RoleRest, log: (l: string) => void, signal: AbortSignal): void {
  let seq = -1, last: string | null = null, retryAt = 0;
  const poll = exclusive(async () => {
    try {
      const s = (await db.seqs(["settings"])).settings ?? 0;
      if (s === seq && Date.now() < retryAt) return;
      seq = s;
      const v = await settings(db, [ROLE_CHANNEL_KEY, ROLE_ID_KEY]);
      const sig = `${v.get(ROLE_CHANNEL_KEY) ?? ""}|${v.get(ROLE_ID_KEY) ?? ""}`;
      if (sig === last && Date.now() < retryAt) return;
      last = sig;
      const st = await ensureRolePanel(db, rest, log);
      retryAt = st?.error ? Date.now() + RETRY_MS : Infinity;
    } catch (e) {
      log(`discord: contributor role panel check failed: ${(e as Error).message}`);
      retryAt = Date.now() + RETRY_MS;
    }
  });
  void poll.skip();
  const timer = setInterval(() => void poll.skip(), POLL_MS);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

/** `merged` is null when GitHub could not be asked and the mirror has none. */
export type MergedAnswer = { merged: boolean | null; via: "cache" | "mirror" | "search" };
export type MergedCheck = (db: Db, login: string) => Promise<MergedAnswer>;

/** Total count of `is:pr is:merged author:<login> org:<owner>` through the read path; throws when GitHub cannot be asked. */
async function searchMerged(login: string, owner: string): Promise<number> {
  const env = await readEnv(owner).catch(async (e: unknown) => { if (e instanceof AppReadError && e.notInstalled) return await readEnv(); throw e; });
  const args = ["api", "-X", "GET", "search/issues", "-f", `q=is:pr is:merged author:${login} org:${owner}`, "-f", "per_page=1", "--jq", ".total_count"];
  return await new Promise<number>((resolve, reject) => execFile("gh", args, { timeout: 30_000, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
    // GitHub answers 422 for a login that does not exist: no merged pull request.
    if (err) return /HTTP 422/.test(String(stderr)) ? resolve(0) : reject(new Error(String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 200)));
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? resolve(n) : reject(new Error("GitHub sent an unreadable answer"));
  }));
}

/**
 * Asks the mirror first (merged pull requests of tracked repos of the owner), then GitHub's search, which also covers the
 * owner's untracked repos. A yes is cached for the life of the process.
 */
export function mergedCheck(search: (login: string, owner: string) => Promise<number> = searchMerged): MergedCheck {
  const yes = new Set<string>();
  return async (db, login) => {
    const key = login.toLowerCase();
    if (yes.has(key)) return { merged: true, via: "cache" };
    const owner = (await trackedOwner(db)).toLowerCase();
    const hist = await loadAuthorHistory(db, { logins: [login] });
    if (hist.some((h) => h.merged > 0 && h.repos.some((r) => ownerOf(r).toLowerCase() === owner))) {
      yes.add(key);
      return { merged: true, via: "mirror" };
    }
    try {
      const n = await search(login, owner);
      if (n > 0) yes.add(key);
      return { merged: n > 0, via: "search" };
    } catch {
      return { merged: null, via: "search" };
    }
  };
}

export type RolePanelDeps = { db: Db; keys: DiscordKeys; rest: RoleRest; log: (l: string) => void; check?: MergedCheck; baseUrl?: string | null; now?: () => number };

/** The login proven for a Discord user: the dashboard link, else a GitHub sign-in made for filing from Discord. */
async function provenLogin(db: Db, keys: DiscordKeys, userId: string): Promise<string | null> {
  const linked = await loginOf(db, keys, userId);
  if (linked) return linked;
  return (await loadReporterSealed(db, keys.hash("author", userId)))?.login ?? null;
}

export function installRolePanel(ix: Interactions, deps: RolePanelDeps): void {
  const { db, keys, rest, log } = deps;
  const check = deps.check ?? mergedCheck();
  const limits = new WindowLimits();
  ix.component("rolecheck", async (call: Call) => {
    const cfg = await roleConfig(db);
    if (!cfg || call.interaction.guild_id !== cfg.guildId || !call.userId) return void (await call.edit({ content: t("The contributor role is not set up on this server.") }));
    const userId = call.userId, user = keys.hash("author", userId);
    const record = async (login: string | null, result: string, via?: string): Promise<void> =>
      await audit(db, login ?? "discord", "discord-role-verify", login, { result, user, ...(via && { via }) });
    if (!limits.allow((deps.now ?? Date.now)(), [{ key: `user:${user}`, ...PER_USER }, { key: "all", ...ALL_USERS }])) {
      return void (await call.edit({ content: t("Too many tries just now. Try again in a few minutes.") }));
    }
    const login = await provenLogin(db, keys, userId);
    if (!login || !LOGIN.test(login)) {
      await record(null, "unlinked");
      const where = deps.baseUrl ? t("Sign in to AutoCraft at {url} and open the Runner page.", { url: deps.baseUrl }) : t("Sign in to the AutoCraft dashboard and open the Runner page.");
      return void (await call.edit({ content: [
        t("Link your GitHub account first, so AutoCraft knows which pull requests are yours:"),
        `1. ${where}`,
        `2. ${t("Under Link Discord, get a code.")}`,
        `3. ${t("Type /autocraft link with that code in this server.")}`,
        `4. ${t("Press Verify again.")}`,
      ].join("\n") }));
    }
    if (call.interaction.member?.roles?.includes(cfg.roleId)) {
      await record(login, "had");
      return void (await call.edit({ content: t("You already have the contributor role.") }));
    }
    const m = await check(db, login);
    if (m.merged === null) {
      await record(login, "unchecked", m.via);
      return void (await call.edit({ content: t("GitHub could not be checked just now. Try again in a few minutes.") }));
    }
    if (!m.merged) {
      await record(login, "no-merge", m.via);
      return void (await call.edit({ content: t("No merged pull request by {login} was found in our repositories.", { login }) }));
    }
    try {
      await rest.addMemberRole(cfg.guildId, userId, cfg.roleId, `Contributor verification: ${login} has a merged pull request`);
    } catch (e) {
      const forbidden = e instanceof RestError && e.status === 403;
      log(forbidden
        ? `discord: the bot may not give role ${cfg.roleId}: it needs Manage Roles, and its highest role must sit above that role`
        : `discord: giving the contributor role failed: ${(e as Error).message}`);
      await record(login, forbidden ? "forbidden" : "failed", m.via);
      return void (await call.edit({ content: forbidden
        ? t("AutoCraft can't give the contributor role yet. A server admin needs to let it manage that role.")
        : t("Discord did not accept the change. Try again in a few minutes.") }));
    }
    await record(login, "granted", m.via);
    await call.edit({ content: t("Done: you have the contributor role. AutoCraft found a merged pull request by {login}.", { login }) });
  });
}

// `/autocraft link`, `unlink`, `optout`, `optin`, `stats`, `status`, `do` and `help`. Replies are visible to the caller only. Everything
// they say about items and counts comes from the public status layer (src/public/status.ts).
import { audit } from "./audit.ts";
import { publicRepoNames, publicStats, publicStatus, type PublicStats, type PublicStatus } from "../public/status.ts";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { forgetReporter } from "./file-issue.ts";
import { forgetLink, loginOf, redeemLinkCode } from "./links.ts";
import { t } from "../i18n/index.ts";
import type { ReadDeps } from "../workflow/read.ts";
import { prepareDo, runDo } from "./do.ts";
import { COMMANDS, WEIGHT_HELP } from "../workflow/vocab.ts";
import { plain } from "./reply.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { DISCORD_PRIVACY_PATH } from "../dash/server/discord-privacy.ts";
import { DISCORD_TERMS_PATH } from "../dash/server/discord-terms.ts";
import { optIn, optOut } from "./store.ts";

const ATTEMPTS = { n: 5, ms: 60_000 };
const READ_LIMIT = { n: 10, ms: 60_000 };
const REF = /^\s*([\w.-]+)#(\d+)\s*$/;

export function formatStats(s: PublicStats): string {
  const median = s.medianOpenToMergeHours30Days === null ? "no merges" : `${s.medianOpenToMergeHours30Days} h`;
  return [
    `Public repos: ${s.repo ?? "all"}`,
    `Open issues: ${s.openIssues}, open pull requests: ${s.openPrs}`,
    `Merged in the last 7 days: ${s.mergedLast7Days} (${s.mergedByAutoCraftLast7Days} by AutoCraft)`,
    `Reviews posted in the last 7 days: ${s.reviewsPostedLast7Days}`,
    `Median open-to-merge time, last 30 days: ${median}`,
    `Merge queue: ${s.queueLength}`,
  ].join("\n");
}

export function formatStatus(s: PublicStatus): string {
  const place = s.queue ? ` (#${s.queue.position} of ${s.queue.of})` : "";
  return `${s.ref} ${plain(s.title).slice(0, 100)}\n${s.step}${place}`;
}

/** The command words and weight words of Help, generated from the command vocabulary. */
export function doHelp(): string[] {
  return [
    t("Command words: {commands}", { commands: COMMANDS.map((c) => `\`${c.usage.replace(/\s*\[.*\]$/, "")}\``).join(" · ") }),
    t("Weight words: {words}", { words: WEIGHT_HELP.map((w) => `${w.word.startsWith("(") ? t("none") : `\`${w.word}\``} (${t(w.weight)})`).join(" · ") }),
  ];
}

/** The lines of Help on sending commands: privately, in a channel, as a reply, and in the thread AutoCraft answers in. */
export function atHelp(): string[] {
  return [
    t("`/autocraft do text:merge: photocraft#123 photocraft#456` sends it privately"),
    t("`@AutoCraft review photocraft#123` in a watched channel sends it in public"),
    t("Reply to a message that names items with `@AutoCraft review` for all of them, or name one"),
    t("AutoCraft answers in a thread and posts each item's status and result there"),
    t("In that thread, `@AutoCraft fix-up and merge` or a reply to AutoCraft acts on the thread's items"),
  ];
}

/** `/autocraft help`: short sections for scanning, under Discord's 2,000-character limit. The links show only when the public base URL is known. */
export function helpText(baseUrl: string | null): string {
  const base = baseUrl?.replace(/\/+$/, "");
  return [
    `**${t("Find issues")}**`,
    t("`/autocraft search` searches existing issues by a few words"),
    t("`/autocraft report` reports a bug or requests a feature; AutoCraft helps write the issue"),
    t("Right-click a message › Apps › Find issue searches with its text"),
    t("`@AutoCraft <question>` in a watched channel replies with matching issues, in public"),
    t("Reply to a message with `@AutoCraft` to search with that message's text"),
    "",
    `**${t("Status")}**`,
    t("`/autocraft status item:photocraft#123` shows where an issue or pull request is"),
    t("`/autocraft stats` shows counts for the public repos"),
    "",
    `**${t("Commands")}** ${t("(linked account with write access)")}`,
    ...atHelp(),
    ...doHelp(),
    "",
    `**${t("Your account")}**`,
    t("`/autocraft link code:<code>` links your AutoCraft login (code: Link Discord in the dashboard menu)"),
    t("`/autocraft unlink` removes the link"),
    t("`/autocraft alerts on|off` sends direct messages when a workflow needs your answer"),
    t("`/autocraft optout` stops recording your messages and deletes the records; commands still work"),
    t("`/autocraft optin` records them again"),
    "",
    `**${t("Privacy")}**`,
    t("AutoCraft's reaction means it counted the message for the items it names"),
    t("Deleting a message deletes its record"),
    ...(base ? [`[${t("Privacy notice")}](<${base}${DISCORD_PRIVACY_PATH}>) · [${t("Terms")}](<${base}${DISCORD_TERMS_PATH}>)`] : []),
  ].join("\n");
}

export function installAccountCommands(ix: Interactions, deps: { db: Db; keys: DiscordKeys; now?: () => number; read?: ReadDeps; baseUrl?: string | null }): void {
  const { db, keys } = deps;
  const help = helpText(deps.baseUrl === undefined ? envVar("BASE_URL") ?? null : deps.baseUrl);
  const tries = new Map<string, number[]>();
  /** Sliding window per key: false when `lim.n` uses are already inside it. Keys whose uses have all expired are dropped. */
  const allow = (key: string, lim: { n: number; ms: number }): boolean => {
    const now = (deps.now ?? Date.now)();
    for (const [k, v] of tries) if (now - v[v.length - 1]! >= (k.startsWith("read:") ? READ_LIMIT.ms : ATTEMPTS.ms)) tries.delete(k);
    const live = (tries.get(key) ?? []).filter((t) => now - t < lim.ms);
    if (live.length >= lim.n) return false;
    tries.set(key, [...live, now]);
    return true;
  };
  /** Code entries per Discord user, so a code cannot be guessed by repeating the command. */
  const mayTry = (user: string): boolean => allow(`link:${user}`, ATTEMPTS);
  /** Stats and status lookups per Discord user. */
  const mayRead = (call: Call): boolean => allow(`read:${keys.hash("author", call.userId ?? "?")}`, READ_LIMIT);
  const TOO_MANY = "Too many requests just now. Try again in a minute.";
  const def = {
    name: "autocraft", type: 1 as const, description: "AutoCraft", dm_permission: false,
    options: [
      { type: 1, name: "link", description: "Link this Discord account to your dashboard login", options: [{ type: 3, name: "code", description: "The code from Link Discord in the dashboard menu", required: true, max_length: 20 }] },
      { type: 1, name: "unlink", description: "Remove the link between this Discord account and your dashboard login" },
      { type: 1, name: "alerts", description: "Direct messages about workflows that need your answer", options: [{ type: 3, name: "state", description: "on or off", required: true, choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }] }] },
      { type: 1, name: "stats", description: "Counts for the public repos", options: [{ type: 3, name: "repo", description: "One repo; all public repos when left out", autocomplete: true }] },
      { type: 1, name: "status", description: "Where an issue or pull request is in AutoCraft", options: [{ type: 3, name: "item", description: "For example photocraft#123", required: true, max_length: 100 }] },
      { type: 1, name: "do", description: "Send a command to AutoCraft, for example: merge: photocraft#123", options: [{ type: 3, name: "text", description: "The command, then a colon and the items: review, urgent: photocraft#123 photocraft#456", required: true, max_length: 1000 }] },
      { type: 1, name: "optout", description: "Stop recording your messages and delete their records" },
      { type: 1, name: "optin", description: "Record your messages again after an opt-out" },
      { type: 1, name: "help", description: "What the AutoCraft bot can do" },
    ],
  };
  ix.command("autocraft link", def, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    if (!mayTry(keys.hash("author", call.userId))) return void (await call.edit({ content: "Too many tries. Wait a minute." }));
    const login = await redeemLinkCode(db, keys, call.option("code") ?? "", call.userId);
    if (!login) return void (await call.edit({ content: "That code is not valid, was already used, or has expired." }));
    await audit(db, login, "discord-link", login);
    await call.edit({ content: `Linked to ${plain(login)}` });
  });
  ix.command("autocraft unlink", null, async (call) => {
    const n = call.userId ? await forgetLink(db, keys, call.userId) : 0;
    const signedIn = call.userId ? await forgetReporter(db, keys.hash("author", call.userId)) : false;
    if (n || signedIn) await audit(db, "discord", "discord-unlink", null, { by: "discord", link: n > 0, signedIn });
    await call.edit({ content: n || signedIn ? "Unlinked." : "This Discord account is not linked." });
  });
  ix.command("autocraft stats", null, async (call: Call) => {
    if (!mayRead(call)) return void (await call.edit({ content: TOO_MANY }));
    const repo = call.option("repo")?.trim();
    const s = await publicStats(db, repo || undefined);
    await call.edit({ content: s ? formatStats(s) : "No public repo by that name." });
  });
  ix.autocomplete("autocraft stats", async (call) => {
    const typed = (call.focused()?.value ?? "").toLowerCase();
    return (await publicRepoNames(db)).filter((r) => r.toLowerCase().includes(typed)).map((r) => ({ name: r, value: r }));
  });
  ix.command("autocraft do", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const login = await loginOf(db, keys, call.userId);
    if (!login) return void (await call.edit({ content: t("Link your account first with /autocraft link.") }));
    // Discord has no item the text was written on, so the items come from the list in the text.
    const result = await runDo(db, keys, prepareDo(call.option("text") ?? ""), { userId: call.userId, login }, deps.read);
    await call.edit({ content: result.lines.join("\n").slice(0, 1990) || t("Nothing ran.") });
  });
  ix.command("autocraft help", null, async (call) => {
    await call.edit({ content: help });
  });
  ix.command("autocraft optout", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    // Each opt-out opens every mention row to find the caller's: limited like code entries.
    if (!allow(`opt:${keys.hash("author", call.userId)}`, ATTEMPTS)) return void (await call.edit({ content: TOO_MANY }));
    const r = await optOut(db, keys, call.userId);
    if (r.changed || r.rows) await audit(db, "discord", "discord-optout", null, { rows: r.rows });
    const deleted = r.rows === 1 ? t("Deleted the record of 1 message that named an issue or pull request.") : t("Deleted {n} records of your messages that named issues or pull requests.", { n: r.rows });
    await call.edit({ content: [
      r.changed ? t("You are opted out. AutoCraft no longer records your messages, flags them or reacts to them.") : t("You were already opted out."),
      deleted,
      t("Commands and searches you send to AutoCraft still work. `/autocraft optin` turns recording back on."),
    ].join("\n") });
  });
  ix.command("autocraft optin", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const changed = await optIn(db, keys, call.userId);
    if (changed) await audit(db, "discord", "discord-optin", null);
    await call.edit({ content: changed ? t("You are opted in. AutoCraft records your new messages that name issues or pull requests again.") : t("You are not opted out.") });
  });
  ix.command("autocraft status", null, async (call) => {
    if (!mayRead(call)) return void (await call.edit({ content: TOO_MANY }));
    const m = REF.exec(call.option("item") ?? "");
    const s = m ? await publicStatus(db, m[1]!, Number(m[2])) : null;
    if (!s) return void (await call.edit({ content: "No item found. Use the form repo#123." }));
    await call.edit({ content: formatStatus(s), components: [{ type: 1, components: [{ type: 2, style: 5, label: s.ref.slice(0, 80), url: s.url }] }] });
  });
}

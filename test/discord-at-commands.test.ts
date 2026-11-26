// @AutoCraft commands in a channel: a reply to a message that names items acts on all of them or on the one named, answers in a
// thread, and a sender with no linked login runs nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AtCommands } from "../src/discord/at-commands.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import { Pings } from "../src/discord/pings.ts";
import type { CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import type { Search } from "../src/discord/search.ts";
import { handleDispatch } from "../src/discord/store.ts";
import { followOf, threadTarget } from "../src/discord/threads.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-at-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeRest implements DiscordRest {
  sent: { channelId: string; body: MessageBody }[] = [];
  threads: { channelId: string; messageId: string; name: string; id: string }[] = [];
  async createMessage(channelId: string, body: MessageBody) { this.sent.push({ channelId, body }); return { id: `r${this.sent.length}` }; }
  async startThread(channelId: string, messageId: string, name: string) { const id = `t${this.threads.length + 1}`; this.threads.push({ channelId, messageId, name, id }); return { id }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback() {}
  async editInteractionResponse(_a: string, _t: string, _b: EditBody) {}
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const pings = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l) }) });
const say = async (id: string, user: string, content: string, repliesTo?: { id: string; author: string }) => {
  const m = {
    id, channel_id: "c1", guild_id: "g1", content, type: repliesTo ? 19 : 0, author: { id: user },
    ...(repliesTo ? { message_reference: { message_id: repliesTo.id }, referenced_message: { author: { id: repliesTo.author } } } : {}),
  };
  await handleDispatch(db, keys, "MESSAGE_CREATE", m);
  await pings.dispatch("MESSAGE_CREATE", m);
  await pings.idle();
};
const started = async (): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.item_workflows").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`).sort();

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("discord_channels").values([{ channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1 }]));
  for (const n of [4, 7]) {
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "pr", state: "OPEN", title: `Fix ${n}`, body: "", url: `https://github.com/storytold/photocraft/pull/${n}` }));
  }
  await db.run(db.k.insertInto("main.access").values({ login: "nora", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  const { code } = await createLinkCode(db, keys, "nora");
  assert.equal(await redeemLinkCode(db, keys, code, "u70"), "nora");
  await pings.dispatch("READY", { user: { id: "100" } });
  await say("m1", "u2", "both of these: photocraft#4 and photocraft#7");
});

test("a reply to a message that names items runs on the one named, then on all of them, and answers in a thread", async () => {
  await say("c-one", "u70", "<@100> review photocraft#7", { id: "m1", author: "u2" });
  assert.deepEqual(await started(), ["photocraft#7"]);
  assert.equal(rest.threads.at(-1)!.messageId, "c-one");
  assert.match(rest.threads.at(-1)!.name, /^review · photocraft#7$/);

  await say("c-all", "u70", "<@100> review all", { id: "m1", author: "u2" });
  assert.deepEqual(await started(), ["photocraft#4", "photocraft#7"]);
  const thread = rest.threads.at(-1)!;
  assert.equal(thread.messageId, "c-all");
  // The confirmation lines go into the thread, mention nobody, and the thread follows the items that ran.
  const posted = rest.sent.filter((s) => s.channelId === thread.id);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.body.allowed_mentions, { parse: [] });
  assert.ok((await followOf(db, keys, threadTarget(keys, thread.id)))!.items.some((i) => i.number === 4));
});

test("a sender with no linked login gets one short reply and nothing runs", async () => {
  const before = await started();
  const sent = rest.sent.length;
  await say("u-1", "u99", "<@100> merge photocraft#4");
  await say("u-2", "u99", "<@100> merge photocraft#4");
  assert.deepEqual(await started(), before);
  assert.equal(rest.sent.length, sent + 1);
  assert.match(rest.sent.at(-1)!.body.content!, /\/autocraft link/);
});

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { itemChat } from "../src/dash/api/item-chat.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import type { Req } from "../src/dash/types.ts";
import type { ChatEntry, ItemChat } from "../web/src/api/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

const SECRET = "s".repeat(40);
mkdirSync(SCRATCH, { recursive: true });
const keyFile = join(mkdtempSync(join(SCRATCH, "chat-")), "key");
writeFileSync(keyFile, SECRET);
chmodSync(keyFile, 0o600);
process.env.AUTOCRAFT_DISCORD_KEY_FILE = keyFile;

const req = (role: "operator" | "viewer", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: { repo: "photocraft", n: "7" }, query: new URLSearchParams(query), form: new URLSearchParams(),
  user: { login: role === "operator" ? "op" : "guest", role, canWrite: async () => role === "operator", canRead: async () => true }, csrf: "", nonce: "",
});
const read = async (db: Db, role: "operator" | "viewer" = "operator") => (await itemChat(db, req(role))) as ItemChat;
const at = (h: number, m = 0, s = 0) => `2026-01-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;

/** The chat tables as the plan defines them, for a database built before their migration. */
const CHAT_TABLES = `
CREATE TABLE IF NOT EXISTS chat_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, number INTEGER, title TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, author TEXT NOT NULL, via TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, payload TEXT, workflow_event_id INTEGER, turn_id INTEGER, at TEXT NOT NULL);`;

async function seed(): Promise<Db> {
  const db = await connectDb(":memory:");
  await db.script(CHAT_TABLES);
  const k = db.k as any;
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "pr", state: "OPEN", author: "dev", created_at: at(0), head_oid: "a".repeat(40) }));
  await db.run(db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }));
  const comment = (id: string, author: string, h: number, m: number, body: string) =>
    db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 7, id, kind: "comment", author, created_at: at(h, m), body, commit_oid: null }));
  await comment("c1", "maint", 1, 0, "@autocraft review");
  await comment("c4", "bot", 2, 30, "AutoCraft's status comment");
  await comment("c2", "kiri", 3, 0, "Nice catch on the zoom case.");
  await comment("c3", "dev", 3, 10, "Thanks, fixes are welcome.");

  const rec = { text: "The fix is right, but one problem is left.", parts: { fix: [1], drop: [] }, merges: true };
  const plan = [{ n: 1, title: "Handles snap past the edge when zoomed out.", source: "review", file: "src/crop.rs:142", major: false, state: "planned" }];
  await db.run(db.k.insertInto("item_workflows").values({
    repo: "photocraft", number: 7, kind: "pr", entry: "review", state: "recommending", started_by: "maint", started_at: at(1, 0, 5), started_via: "github",
    rec: JSON.stringify(rec), rec_at: at(2, 20), plan: JSON.stringify(plan), updated_at: at(2, 20),
  }));
  await db.run(db.k.insertInto("workflow_events").values([
    { workflow_id: 1, repo: "photocraft", number: 7, login: "maint", via: "github", kind: "started", line: "Reviewing photocraft#7, then I'll come back with the result.", at: at(1, 0, 5) },
    { workflow_id: 1, repo: "photocraft", number: 7, login: "op", via: "dashboard", kind: "weighted", line: "Weight set to high.", at: at(4, 0, 1) },
  ]));

  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "review.opus", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "photocraft", number: 7 }], prompt: "p" });
  await db.run(db.k.updateTable("agent_runs").set({ started_at: at(1, 30) }));
  await finishRun(db, run, { state: "done", output: "o", costUsd: 0.4 });
  await db.run(db.k.insertInto("opus_review_history").values({ repo: "photocraft", number: 7, head_oid: "a".repeat(40), at: at(2), model: "opus", mode: "full", verdict: "take", sure: 1, reason: "one fix" }));
  await db.run(db.k.insertInto("audit").values({ at: at(2, 10), login: "bot", action: "review-post", target: "photocraft#7", details: JSON.stringify({ head: "a".repeat(40), state: "done", text: "review text" }) }));

  await db.run(k.insertInto("chat_conversations").values({ repo: "photocraft", number: 7, title: "Review", created_at: at(1), created_by: "maint" }));
  await db.run(k.insertInto("chat_messages").values([
    { conversation_id: 1, author: "maint", via: "github", kind: "said", body: "@autocraft review", payload: JSON.stringify({ githubCommentId: "c1", url: "https://github.com/x/photocraft/pull/7#c1" }), workflow_event_id: 1, turn_id: null, at: at(1) },
    { conversation_id: 1, author: "autocraft", via: "autocraft", kind: "recommended", body: rec.text, payload: JSON.stringify({ workflowId: 1, rec, parts: plan }), workflow_event_id: null, turn_id: null, at: at(2, 20) },
    { conversation_id: 1, author: "op", via: "dashboard", kind: "said", body: "weight high", payload: null, workflow_event_id: 2, turn_id: null, at: at(4) },
  ]));

  const keys = new DiscordKeys(SECRET);
  await db.run(db.k.insertInto("discord_channels").values({ channel_id: "ch1", guild_id: "g1", guild_name: "Guild", name: "dev", watched: 1 }));
  const mention = (id: string, sealed: string | null, h: number, m: number) => {
    const msgHash = keys.hash("message", id);
    return { msg_hash: msgHash, channel_hash: keys.hash("channel", "ch1"), repo: "photocraft", number: 7, signal: 0,
      sealed: sealed ?? keys.seal({ guildId: "g1", channelId: "ch1", messageId: id, at: at(h, m) }, msgHash) };
  };
  await db.run(db.k.insertInto("discord_mentions").values([mention("m1", null, 3, 20), mention("m2", null, 3, 25), mention("m3", "not-sealed-with-this-key", 3, 22)]));
  return db;
}

const kinds = (es: ChatEntry[]) => es.map((e) => e.t);

test("the chat tells an item as bubbles, replies, work and folded GitHub and Discord lines; a viewer of a quiet PR gets who and when only", async () => {
  const db = await seed();
  const chat = await read(db);
  const [conv] = chat.conversations;
  assert.equal(chat.conversations.length, 1);
  const es = conv!.entries;
  assert.deepEqual(kinds(es), ["github", "said", "reply", "work", "work", "reply", "github", "discord", "said", "reply"]);

  const said = es.filter((e) => e.t === "said");
  assert.deepEqual(said.map((e) => [e.login, e.via, e.body]), [["maint", "github", "@autocraft review"], ["op", "dashboard", "weight high"]]);
  const replies = es.filter((e) => e.t === "reply");
  assert.equal(replies[0]!.body, "Reviewing photocraft#7, then I'll come back with the result.", "the confirmation follows the command it answers");
  assert.equal(replies[2]!.body, "Weight set to high.");
  const recommendation = replies[1]!;
  assert.deepEqual(recommendation.findings.map((f) => f.n), [1]);
  assert.deepEqual(recommendation.ask?.to, ["maint"], "the question goes to who started the work");
  assert.deepEqual(conv!.open?.to, ["maint"]);

  const work = es.filter((e) => e.t === "work");
  assert.equal(work.filter((e) => e.eventId?.startsWith("review:")).length, 1, "the review is shown once");
  assert.ok(!work.some((e) => e.eventId?.startsWith("run:")), "its model call is inside the review, not a row of its own");

  const github = es.filter((e) => e.t === "github");
  const folded = github[1]!;
  assert.equal(folded.count, 2, "the two plain comments fold into one line");
  assert.ok(folded.lines.some((l) => l.includes("Nice catch")) && folded.lines.some((l) => l.includes("Thanks")));
  assert.ok(!JSON.stringify(github).includes("status comment"), "AutoCraft's own comments are not GitHub activity");
  assert.ok(!JSON.stringify(github).includes("@autocraft review"), "a command comment is a bubble, not GitHub activity");

  const discord = es.find((e) => e.t === "discord");
  assert.equal(discord?.t === "discord" && discord.links.length, 2, "two mentions close together collapse into one line; a row the key cannot open is left out");
  assert.ok(discord?.t === "discord" && discord.links.every((l) => l.channel === "dev" && l.url.startsWith("https://discord.com/channels/g1/ch1/")));
  assert.equal(conv!.canReply, true);
  assert.equal(chat.state, "waiting");

  assert.deepEqual(await itemChat(db, req("operator", { since: chat.stamp })), { unchanged: true, stamp: chat.stamp });
  await db.run((db.k as any).insertInto("chat_messages").values({ conversation_id: 1, author: "op", via: "dashboard", kind: "said", body: "looks good", payload: null, workflow_event_id: null, turn_id: null, at: at(5) }));
  assert.notEqual((await itemChat(db, req("operator", { since: chat.stamp }))).stamp, chat.stamp, "a new message changes the stamp");

  await db.run(db.k.insertInto("security_findings").values({ repo: "photocraft", number: 1, scan_id: 1, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "f", fix_pr: 7, created_at: at(0), updated_at: at(0) }));
  const veiled = await read(db, "viewer");
  const v = veiled.conversations[0]!;
  assert.equal(v.canReply, false);
  for (const e of v.entries) {
    if (e.t === "said") assert.ok(e.login && e.at && e.body === "", "who and when stay, the words go");
    if (e.t === "reply") assert.ok(e.body === "" && e.findings.length === 0 && (e.ask === null || e.ask.question === ""));
    if (e.t === "work") assert.ok(e.outcome === null && e.costUsd === null && e.detail.length === 0);
  }
  assert.ok(v.entries.some((e) => e.t === "work"), "the work rows stay, without their outcomes");
  assert.ok(!JSON.stringify(v).includes("one problem is left") && !JSON.stringify(v).includes("weight high"));
});

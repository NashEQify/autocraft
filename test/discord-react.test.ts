// The bot reacts once to a message it newly records against items, and only while the operators' switch is on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DiscordKeys } from "../src/discord/keys.ts";
import { dispatcher } from "../src/discord/index.ts";
import { Reactor } from "../src/discord/react.ts";
import { RestError } from "../src/discord/rest.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-react-"));
const db = await connectDb(join(dir, "d.db"));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

test("one reaction per newly recorded message", async () => {
  await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("discord_channels").values([{ channel_id: "c1", guild_id: "g1", watched: 1 }, { channel_id: "c2", guild_id: "g1", watched: 0 }]));
  const calls: string[][] = [];
  let fail: RestError | null = null;
  const logs: string[] = [];
  const rest = { addReaction: async (...a: string[]) => { calls.push(a); if (fail) throw fail; } };
  const dispatch = dispatcher(db, new DiscordKeys("k".repeat(40)), { dispatch() {} } as never, { dispatch() {} } as never, undefined, new Reactor({ db, rest, log: (l) => logs.push(l) }));
  const msg = (id: string, content: string, channel = "c1") => ({ id, channel_id: channel, guild_id: "g1", content, timestamp: "2026-01-01T00:00:00Z", author: { id: "u1" } });
  const settle = () => new Promise((r) => setTimeout(r, 5));

  await dispatch("MESSAGE_CREATE", msg("m1", "see photocraft#1"));
  await dispatch("MESSAGE_UPDATE", msg("m1", "see photocraft#1 (edited)"));
  await dispatch("MESSAGE_CREATE", msg("m2", "no items here"));
  await dispatch("MESSAGE_CREATE", msg("m3", "photocraft#1", "c2"));
  await settle();
  assert.deepEqual(calls, [["c1", "m1", "✅"]]);

  await db.run(db.k.insertInto("settings").values({ key: "discord_react", value: "off" }));
  await dispatch("MESSAGE_CREATE", msg("m4", "photocraft#2"));
  await settle();
  assert.equal(calls.length, 1);

  await db.run(db.k.updateTable("settings").set({ value: "on" }).where("key", "=", "discord_react"));
  fail = new RestError(403, "forbidden");
  await dispatch("MESSAGE_CREATE", msg("m5", "photocraft#3"));
  await dispatch("MESSAGE_CREATE", msg("m6", "photocraft#4"));
  await settle();
  assert.equal(logs.length, 1);
});

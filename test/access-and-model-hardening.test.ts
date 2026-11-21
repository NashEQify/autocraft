// Removing a login from the access list ends everything that lets a Discord account act as it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { addLogin, removeLogin } from "../src/access.ts";
import { alertsOn, setAlerts } from "../src/discord/alerts.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, loginOf, redeemLinkCode } from "../src/discord/links.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a Discord link and alert opt-in do not survive removal and re-adding of the login", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "access-hardening-")), "t.db"));
  const keys = new DiscordKeys("k".repeat(40));
  await addLogin(db, "root", "root", "operator", null);
  await addLogin(db, "root", "dana", "operator", null);
  const { code } = await createLinkCode(db, keys, "dana");
  assert.equal(await redeemLinkCode(db, keys, code, "u1"), "dana");
  await setAlerts(db, keys, "u1", "chan");
  const pending = (await createLinkCode(db, keys, "dana")).code;
  await removeLogin(db, "root", "dana");
  await addLogin(db, "root", "dana", "operator", null);
  assert.equal(await loginOf(db, keys, "u1"), null);
  assert.equal(await alertsOn(db, keys, "u1"), false);
  assert.equal(await redeemLinkCode(db, keys, pending, "u2"), null);
});

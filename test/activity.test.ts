import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun } from "../src/agents/runs.ts";
import { activity } from "../src/dash/api/activity.ts";
import type { Req } from "../src/dash/types.ts";
import type { ActivityPage } from "../web/src/api/types.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";

const as = (role: "viewer" | "operator", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "u", role, canWrite: async () => true, canRead: async (r: string) => r !== "secret" },
});
const get = async (db: Db, role: "viewer" | "operator", q: Record<string, string> = {}) => (await activity(db, as(role, q))) as ActivityPage;

test("the stream merges the sources of every item newest first, pages by cursor and hides what the viewer may not see", async () => {
  const db = await connectDb(":memory:");
  await db.script("INSERT INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('secret', 'private'); INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft'), ('secret')");
  for (const [repo, n] of [["photocraft", 1], ["photocraft", 2], ["secret", 3]] as const)
    await db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at) VALUES (?, ?, 'pr', 'OPEN', ?, 'dev', '2026-01-01T00:00:00Z')").run(repo, n, `Item ${n}`);
  await db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 1, 'c1', 'comment', 'dev', '2026-01-01T01:00:00Z', 'hi')").run();
  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 2 }, { repo: "photocraft", number: 1 }], prompt: "p" });
  await db.run(db.k.updateTable("agent_runs").set({ started_at: "2026-01-01T02:00:00Z" }));
  await db.prepare("INSERT INTO opus_review_history (repo, number, head_oid, at, model, mode, verdict, sure, reason) VALUES ('photocraft', 2, ?, '2026-01-01T03:00:00Z', 'opus', 'full', 'take', 1, 'ok')").run("a".repeat(40));
  await db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES ('2026-01-01T04:00:00Z', 'bot', 'review-post', 'photocraft#1', '{}')").run();
  await db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES ('2026-01-01T05:00:00Z', 'maint', 'set-priority', 'photocraft#2', '{}')").run();
  await db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES ('2026-01-01T06:00:00Z', 'bot', 'review-post', 'secret#3', '{}')").run();
  await db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('secret', 3, 'c2', 'comment', 'dev', '2026-01-01T07:00:00Z', 'hidden')").run();

  const op = await get(db, "operator");
  const ids = op.events.map((e) => e.id);
  assert.deepEqual(ids.slice(0, 7), ["comment:c2", "audit:3", "audit:2", "audit:1", "review:opus:1", `run:${run}`, "comment:c1"]);
  assert.deepEqual(op.events.find((e) => e.id === `run:${run}`)!.item, { repo: "photocraft", number: 1, kind: "pr", state: "open", title: "Item 1" }, "a run over two items shows once, at its first item");
  assert.equal(ids.filter((i) => i === `run:${run}`).length, 1);

  const first = await get(db, "operator", { limit: "3" });
  assert.deepEqual(first.events.map((e) => e.id), ids.slice(0, 3));
  assert.ok(first.nextCursor);
  const second = await get(db, "operator", { limit: "3", cursor: first.nextCursor! });
  assert.deepEqual(second.events.map((e) => e.id), ids.slice(3, 6));
  assert.deepEqual((await activity(db, as("operator", { since: op.stamp }))), { unchanged: true, stamp: op.stamp });

  const own = await get(db, "operator", { autocraftOnly: "1", limit: "2" });
  assert.deepEqual(own.events.map((e) => e.id), ["review:opus:1", `run:${run}`], "Only AutoCraft fills the page from AutoCraft's own rows, past newer people's events");

  const viewer = await get(db, "viewer");
  assert.deepEqual(viewer.events.filter((e) => e.item.repo === "secret").map((e) => e.id), [], "a hidden repo's events are left out");
  assert.ok(!viewer.events.some((e) => e.id === "audit:2"), "a dashboard action is not a GitHub write");
  assert.ok(viewer.events.some((e) => e.id === "audit:1"));
  assert.ok(!(await get(db, "operator", { kinds: "plan" })).events.length, "plan events show only when asked for");
});

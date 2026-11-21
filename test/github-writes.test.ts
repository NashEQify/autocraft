import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pushedByAutoCraft, writesOf } from "../src/dash/api/github-writes.ts";

test("writes match their comment by url, review id, then by time when the url is missing", async () => {
  const db = new DatabaseSync(":memory:");
  await db.script("CREATE TABLE audit (at TEXT, login TEXT, action TEXT, target TEXT, details TEXT); CREATE TABLE comments (id TEXT, repo TEXT, number INT, kind TEXT, url TEXT, created_at TEXT, author TEXT); CREATE TABLE settings (key TEXT, value TEXT); INSERT INTO settings VALUES ('pipeline_login', 'bot')");
  const a = db.prepare("INSERT INTO audit VALUES (?,?,?,?,?)");
  await a.run("2026-01-01T10:00:00Z", "x", "act-comment", "r#1", JSON.stringify({ state: "done", url: "u1", identity: "app", jobId: 7 }));
  await a.run("2026-01-01T11:00:00Z", "x", "review-post", "r#1", JSON.stringify({ state: "done", review: "R1" }));
  await a.run("2026-01-01T12:00:00Z", "x", "act-comment", "r#1", JSON.stringify({ state: "done" }));
  await a.run("2026-01-01T14:00:00Z", "x", "fixup-comment-edit", "r#1", JSON.stringify({ state: "done" }));
  await a.run("2026-01-01T13:00:00Z", "x", "fixup-push", "r#1", JSON.stringify({ state: "done", commit: "abc" }));
  const c = db.prepare("INSERT INTO comments VALUES (?,?,?,?,?,?,?)");
  await c.run("C1", "r", 1, "comment", "u1", "2026-01-01T10:00:30Z", "bot");
  await c.run("R1", "r", 1, "review", null, "2026-01-01T11:00:10Z", "bot");
  await c.run("C3", "r", 1, "comment", "u3", "2026-01-01T12:01:00Z", "bot");
  await c.run("C5", "r", 1, "comment", null, "2026-01-01T12:00:30Z", "someone");
  await c.run("C4", "r", 1, "comment", null, "2026-01-01T12:30:00Z", "bot");
  await c.run("C6", "r", 1, "comment", null, "2026-01-01T14:00:20Z", "bot");
  const w = await writesOf(db, "r", 1);
  assert.deepEqual(w.map((x) => x.comment?.id ?? null), ["C1", "R1", "C3", null, null]);
  assert.equal(w[0]!.jobId, 7);
  assert.equal(await pushedByAutoCraft(db, "r", 1, "abc"), true);
  assert.equal(await pushedByAutoCraft(db, "r", 1, "zzz"), false);
});

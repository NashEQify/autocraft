import assert from "node:assert/strict";
import { test } from "node:test";
import { needs } from "../src/dash/api/needs.ts";
import type { Req } from "../src/dash/types.ts";
import type { NeedsPage } from "../web/src/api/types.ts";
import { connectDb } from "../src/db/open.ts";

const as = (role: "viewer" | "operator", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(),
  user: { login: "u", role, canWrite: async () => true, canRead: async (r: string) => r !== "secret" }, csrf: "", nonce: "",
});

test("needs lists feedback newest first with handled state, shows a tripped breaker, and hides a private repo from a viewer", async () => {
  const db = await connectDb(":memory:");
  const now = Date.now();
  const at = (h: number) => new Date(now - h * 3600_000).toISOString();
  for (const [name, vis] of [["photocraft", "public"], ["secret", "private"]]) {
    await db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES (?)").run(name);
    await db.prepare("INSERT INTO repos (name, visibility) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET visibility = excluded.visibility").run(name, vis);
  }
  await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
  for (const [repo, n] of [["photocraft", 1], ["photocraft", 2], ["photocraft", 4], ["secret", 3]] as const)
    await db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES (?, ?, 'pr', 'OPEN', ?)").run(repo, n, `Title ${n}`);
  // Item 1: a comment that mentions AutoCraft, answered by AutoCraft later. Item 2: a reply to an AutoCraft comment, unanswered.
  const c = db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES (?, ?, ?, 'comment', ?, ?, ?)");
  await c.run("photocraft", 1, "c1", "dev", at(10), "@bot please recheck");
  await c.run("photocraft", 1, "c2", "bot", at(9), "Rechecked");
  await c.run("photocraft", 2, "c3", "bot", at(8), "Review");
  await c.run("photocraft", 2, "c4", "dev", at(2), "I disagree");
  await c.run("photocraft", 2, "c5", "other", at(1), "unrelated chatter after a person");
  // The comment text was recorded with CRLF line endings; a review we posted is recorded by its node id only.
  await c.run("photocraft", 4, "R_node1", "bot", at(8), "A review");
  await c.run("photocraft", 4, "c7", "dev", at(3), "I disagree with the review");
  const au = db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, 'bot', ?, ?, ?)");
  await au.run(at(8), "act-comment", "photocraft#2", JSON.stringify({ url: "https://example.test/c3", text: "Review\r\n" }));
  await au.run(at(8), "review-post", "photocraft#4", JSON.stringify({ review: "R_node1" }));
  await c.run("secret", 3, "c6", "dev", at(3), "@bot hidden one");
  await db.prepare("UPDATE comments SET mentions_pipeline = 1 WHERE body LIKE '@bot%'").run(); // what the mirror sets when it writes the comment
  await db.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_at) VALUES ('d1', 'scope', 'photocraft', 2, 'Q?', '[]', ?, 'yes', ?)").run(at(20), at(5));
  await db.prepare("INSERT INTO decision_comments (id, decision_id, login, at, body) VALUES ('dc1', 'd1', 'maint', ?, 'before the answer')").run(at(6));
  await db.prepare("INSERT INTO stage_trips (stage, active, reason, evidence, tripped_at) VALUES ('merge', 1, 'two merges broke main', '[]', ?)").run(at(1));

  const op = (await needs(db, as("operator", { feedback: "1" }))) as NeedsPage;
  assert.deepEqual(op.feedback!.rows.map((r) => [r.id, r.handled]), [["comment:c4", false], ["comment:c7", false], ["comment:c6", false], ["decision-comment:dc1", true], ["comment:c1", true]]);
  assert.equal(op.feedback!.rows[0]!.href, "/items/photocraft/2#event=comment%3Ac4");
  assert.equal(op.counts.feedback, 3);
  assert.equal(op.feedback!.rows.find((r) => r.id === "decision-comment:dc1")!.href, "/needs/decisions/d1", "the decision is opened by its id");
  assert.equal(op.counts.decisions, 0);
  assert.deepEqual(op.stopped.map((s) => [s.id, s.resume]), [["breaker:merge", { type: "trip", stage: "merge" }]]);

  const paged = (await needs(db, as("operator", { feedback: "1", limit: "3" }))) as NeedsPage;
  const next = (await needs(db, as("operator", { feedback: "1", limit: "3", cursor: paged.feedback!.nextCursor! }))) as NeedsPage;
  assert.deepEqual([...paged.feedback!.rows, ...next.feedback!.rows].map((r) => r.id), op.feedback!.rows.map((r) => r.id));

  const viewer = (await needs(db, as("viewer", { feedback: "1" }))) as NeedsPage;
  assert.ok(!viewer.feedback!.rows.some((r) => r.item?.repo === "secret"));
  assert.equal(viewer.counts.feedback, 2);
});

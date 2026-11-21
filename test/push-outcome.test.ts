import { test } from "node:test";
import assert from "node:assert/strict";
import { breakerTripped, classifyPush, requiredResult } from "../src/core/push-outcome.ts";
import { join } from "node:path";
import { tmpdir } from "./world-db.ts";
import { pushesUnsettled, recordPush, resolvePushes } from "../src/push-outcomes.ts";
import { connectDb } from "../src/db/open.ts";

test("push outcome: green to red is broke, red to green is fixed, optional checks are ignored", () => {
  const green = [{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }];
  const red = [{ name: "gate", state: "failure" }, { name: "sonar", state: "success" }];
  const optional = ["sonar"];
  assert.equal(requiredResult(green, optional), "green");
  assert.equal(requiredResult(red, optional), "red");
  assert.equal(requiredResult([{ name: "gate", state: "pending" }], optional), "pending");
  assert.equal(classifyPush(requiredResult(green, optional), requiredResult(red, optional)), "broke");
  assert.equal(classifyPush(requiredResult(red, optional), requiredResult(green, optional)), "fixed");
  assert.equal(classifyPush("red", "red"), "still-red");
  assert.equal(classifyPush("green", "green"), "kept-green");
  assert.equal(classifyPush("unknown", "red"), "unknown");
  assert.equal(classifyPush("green", "pending"), null);
  assert.equal(classifyPush("green", "none"), null, "no required check yet is not final");
  // A red optional check alone is no break.
  assert.equal(classifyPush("green", requiredResult([{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }], optional)), "kept-green");
  assert.equal(breakerTripped(["broke", "fixed", null, "broke"]), true);
  assert.equal(breakerTripped(["broke", ...Array(9).fill("fixed"), "broke"]), false);
});

test("a new branch takes the CI result of its base commit, not the latest main CI", async () => {
  const db = await connectDb(join(tmpdir("push-base"), "t.db"));
  const ci = async (sha: string, state: string, at: string) => await db.prepare("INSERT INTO main_ci (repo, head_sha, branch, state, failing, checks, committed_at, first_seen_at, state_changed_at, updated_at) VALUES ('o/r', ?, 'main', ?, '[]', '[]', ?, ?, ?, ?)").run(sha, state, at, at, at, at);
  await ci("base", "red", "2026-11-01T00:00:00Z");
  await ci("latest", "green", "2026-11-02T00:00:00Z");
  const before = async () => (await db.prepare("SELECT before_res FROM push_outcomes ORDER BY id DESC LIMIT 1").get() as { before_res: string }).before_res;
  await recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c1", base: "base" });
  assert.equal(await before(), "red");
  await recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c2", base: "gone" });
  assert.equal(await before(), "green", "no row for the base: the latest main CI");
  await recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c3" });
  assert.equal(await before(), "green");
  const rows = [{ repo: "o/r", number: 5, head_oid: "c1", checks: [{ name: "gate", state: "failure" }] }];
  await resolvePushes(db, rows);
  assert.equal((await db.prepare("SELECT outcome FROM push_outcomes WHERE to_oid = 'c1'").get() as { outcome: string }).outcome, "still-red");
});

test("the unsettled-push gate counts only recent pushes whose PR is open at the pushed head", async () => {
  const db = await connectDb(join(tmpdir("push-gate"), "t.db"));
  const now = new Date("2026-11-07T12:00:00Z");
  const item = async (n: number, state: string, head: string) => await db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES ('app', ?, 'pr', ?, 't', 'a', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(n, state, head);
  const push = async (n: number | null, to: string, at: string) => await db.prepare("INSERT INTO push_outcomes (at, stage, action, repo, number, from_oid, to_oid, before_res) VALUES (?, 'fixup', 'fixup-push', 'app', ?, 'old', ?, 'green')").run(at, n, to);
  const checks = async (n: number, head: string) => await db.prepare("INSERT INTO pr_checks (repo, number, head_oid, overall, checks, fetched_at) VALUES ('app', ?, ?, 'pending', ?, '2026-11-07T11:50:00Z')").run(n, head, JSON.stringify([{ name: "gate", state: "pending" }]));
  // Orphans: PR merged, head moved on, no number.
  await item(1, "MERGED", "h1"); await push(1, "h1", "2026-11-07T11:30:00Z");
  await item(2, "OPEN", "other"); await push(2, "h2", "2026-11-07T11:30:00Z");
  await push(null, "h3", "2026-11-07T11:30:00Z");
  for (const n of [4, 5, 6]) { await item(n, "OPEN", `h${n}`); await checks(n, `h${n}`); }
  await push(4, "h4", "2026-11-07T11:30:00Z"); await push(5, "h5", "2026-11-07T11:30:00Z");
  assert.equal(await pushesUnsettled(db, "app", () => {}, now), false);
  await push(6, "h6", "2026-11-07T11:40:00Z");
  assert.equal(await pushesUnsettled(db, "app", () => {}, now), true);
  assert.equal(await pushesUnsettled(db, "app", () => {}, new Date("2026-11-07T14:00:00Z")), false, "pushes older than 2 hours no longer count");
});

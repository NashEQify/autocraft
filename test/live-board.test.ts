import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKind, live } from "../src/dash/api/live.ts";
import { now } from "../src/dash/api/now.ts";
import { insertRun } from "../src/agents/runs.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";
import { setupBox } from "./accounts-fixture.ts";
import { syncAccounts } from "../src/agents/accounts.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";

const req = { query: new URLSearchParams(), user: { role: "operator", login: "o", canRead: async () => true } } as unknown as Req;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("the live board shows a running job with its call and build steps, an estimate from earlier runs, and drops idle ended jobs", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Fix the thing", updated_at: ago(1) }));
  const job = async (step: string, requested_at: string, state: string, started_at: string, ended_at: string | null, progress: string | null, summary: string | null) =>
    (await db.get(db.k.insertInto("jobs").values({ step, params: "{}", requested_by: "pipeline", requested_at, state, started_at, ended_at, progress, summary }).returning("id")))!.id;
  // Earlier review jobs of 10, 12, 14 and 30 minutes and the 1-minute one below give the estimate.
  for (const m of [10, 12, 14, 30]) await job("review", ago(200), "done", ago(200), ago(200 - m), null, "old");
  const running = await job("review", ago(5), "running", ago(5), null, "Reviewing app#7", null);
  await job("review", ago(3), "done", ago(4), ago(3), null, "nothing to do");
  await db.run(db.k.insertInto("job_items").values({ job_id: running, repo: "app", number: 7, at: ago(5) }));
  await db.run(db.k.insertInto("agent_runs").values({ job_id: running, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "opus", items: "[]", item_count: 1, state: "done", started_at: ago(5), ended_at: ago(4) }));
  await db.run(db.k.insertInto("build_tasks").values({ job_id: running, step: "verify", repo: "app", number: 7, head_sha: "abc", requires: "{}", plan: "[]", state: "done", queued_at: ago(4), started_at: ago(4), ended_at: ago(2),
    results: JSON.stringify([{ step: "install", exitCode: 0, durationMs: 30_000, timedOut: false }, { step: "test", exitCode: 1, durationMs: 60_000, timedOut: false }]) }));

  const { lanes } = await live(db, req);
  const lane = lanes.find((l) => l.key === `job:${running}`)!;
  assert.equal(lane.state, "running");
  assert.equal(lane.line, "Reviewing app#7");
  assert.equal(lane.item?.title, "Fix the thing");
  assert.deepEqual(lane.estimate && { median: Math.round(lane.estimate.median / 60_000), samples: lane.estimate.samples }, { median: 12, samples: 5 });
  assert.deepEqual(lane.ops.map((o) => [o.kind, o.label, !!o.failed]), [["model", "opus", false], ["setup", "install", false], ["tests", "test", true]]);
  // The ended job touched no item: it is left out.
  assert.equal(lanes.length, 1);
});

test("build steps are sorted into kinds by name", () => {
  assert.deepEqual(["npm ci", "cargo build", "cargo test", "clippy", "tsc", "deploy"].map(buildKind), ["setup", "build", "tests", "lint", "lint", "other"]);
});

test("viewers see no account label and no progress line that names a repo hidden from them, on the Live board and the Now feed", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values([{ name: "app", visibility: "public" }, { name: "secret", visibility: "private" }]));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "app" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("claude_accounts").values({ id: "acc", label: "Team account B" }));
  const job = (await db.get(db.k.insertInto("jobs").values({ step: "review", params: "{}", requested_by: "pipeline", requested_at: ago(5), state: "running", started_at: ago(5), progress: "Reviewing app#7" }).returning("id")))!.id;
  await db.run(db.k.insertInto("job_items").values({ job_id: job, repo: "app", number: 7, at: ago(5) }));
  const run = async (jobId: number | null, progress: string) => {
    const id = await insertRun(db, { jobId, step: "review", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: "acc", items: [{ repo: "app", number: 7 }], prompt: "p" });
    await db.run(db.k.updateTable("agent_runs").set({ state: "running", started_at: ago(4), progress }).where("id", "=", id));
  };
  await run(job, "Reading app/src/main.rs");
  await run(null, "Comparing with secret#3");
  const as = (role: "viewer" | "maintainer" | "operator") => ({ query: new URLSearchParams(), user: { role, login: "u", canRead: async (r: string) => r !== "secret" } }) as unknown as Req;

  const board = (await live(db, as("viewer"))).lanes;
  assert.deepEqual(board.flatMap((l) => l.ops.map((o) => o.detail)), ["Review", "Review"]);
  assert.equal(board.find((l) => l.key.startsWith("run:"))?.line, null);
  const feed = (await now(db, as("viewer"))).entries.flatMap((e) => [e, ...e.children]).filter((e) => e.kind === "call");
  assert.deepEqual(feed.map((e) => [e.what, e.progress]), [["opus", null], ["opus", "Reading app/src/main.rs"]]);
  // Operators see the account.
  assert.match((await live(db, as("operator"))).lanes[0]!.ops[0]!.detail ?? "", /on Team account B$/);
  assert.doesNotMatch((await live(db, as("maintainer"))).lanes[0]!.ops[0]!.detail ?? "", / on /);
});

test("the worker view gives each Task Runner and account a row with the calls it ran in the last hour, for staff only, accounts for operators only", async () => {
  const db = await connectDb(":memory:");
  setupBox(["acc"]);
  await syncAccounts(db);
  await db.script("UPDATE claude_accounts SET enabled = 1, label = 'Box account' WHERE id = 'acc'");
  await db.script("INSERT INTO repos (name, visibility) VALUES ('app', 'public'), ('secret', 'private'); INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app'), ('secret')");
  const token = async (login: string, label: string) => Number((await db.prepare("INSERT INTO mcp_tokens (login, token_hash, label, kind, can_run, created_at, expires_at) VALUES (?, ?, ?, 'runner', 1, ?, ?) RETURNING id")
    .get(login, `h-${label}`, label, ago(600), new Date(Date.now() + 86400_000).toISOString()) as { id: number }).id);
  const alice = await token("alice", "alice laptop");
  const idle = await token("bob", "bob desktop");
  await storeStatus(db, alice, "alice", parseStatus({ slots: 2, busy: 1, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await storeStatus(db, idle, "bob", parseStatus({ slots: 1, busy: 0, readiness: "paused", reason: "paused by the user", harness: "codex", models: { top: "gpt" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const call = async (o: { account?: string; runner?: { token: number; login: string }; repo?: string; started: number; ended?: number }) => {
    const id = await insertRun(db, { jobId: null, step: "review", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: o.account ?? null, items: [{ repo: o.repo ?? "app", number: 7 }], prompt: "p" });
    await db.prepare("UPDATE agent_runs SET state = ?, started_at = ?, ended_at = ?, input_tokens = 100, user_login = ? WHERE id = ?")
      .run(o.ended === undefined ? "running" : "done", ago(o.started), o.ended === undefined ? null : ago(o.ended), o.runner?.login ?? null, id);
    if (o.runner) await db.prepare(`INSERT INTO remote_calls (step, stage, run_id, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, since, seen_at, max_attempts, timeout_ms, token_id, user_login, ended_at)
      VALUES ('review', 1, ?, 'p', '1', 'top', 'high', 'opus', '{}', ?, 0, 0, 1, 60000, ?, ?, ?)`).run(id, o.ended === undefined ? "leased" : "done", o.runner.token, o.runner.login, o.ended === undefined ? null : Date.now() - o.ended * 60_000);
    return id;
  };
  const running = await call({ runner: { token: alice, login: "alice" }, started: 3 });
  const done = await call({ runner: { token: alice, login: "alice" }, started: 20, ended: 12 });
  await call({ runner: { token: alice, login: "alice" }, started: 300, ended: 200 }); // before the window
  await call({ runner: { token: alice, login: "alice" }, repo: "secret", started: 9, ended: 8 });
  await call({ account: "acc", started: 30, ended: 25 });
  const as = (role: "viewer" | "maintainer" | "operator") => ({ query: new URLSearchParams(), user: { role, login: "u", canRead: async (r: string) => r !== "secret" } }) as unknown as Req;

  assert.equal((await live(db, as("viewer"))).workers, undefined);
  const rows = (await live(db, as("maintainer"))).workers!;
  const a = rows.find((w) => w.key === `runner:${alice}`)!;
  assert.deepEqual([a.login, a.name, a.status, a.busy], ["alice", "alice laptop", "online", 1]);
  assert.deepEqual(a.calls.map((c) => c.id), [done, running], "the window's calls, oldest first, without the hidden repo's");
  assert.equal(a.calls[1]!.end, null);
  const b = rows.find((w) => w.key === `runner:${idle}`)!;
  assert.deepEqual([b.status, b.note, b.calls.length], ["held", "paused by the user", 0]);
  assert.ok(!rows.some((w) => w.kind === "account"), "maintainers get no box account rows");
  const acc = (await live(db, as("operator"))).workers!.find((w) => w.key === "account:acc")!;
  assert.deepEqual([acc.name, acc.calls.length], ["Box account", 1]);
});

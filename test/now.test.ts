import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun } from "../src/agents/runs.ts";
import { now, nowFeed } from "../src/dash/api/now.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";
import * as kx from "../src/db/kx.ts";

const req = (role: "operator" | "viewer"): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(),
  user: { login: role, role, canWrite: async () => false, canRead: async () => false }, csrf: "", nonce: "",
} as unknown as Req);

test("Now lists running work with its items, reports a failing sync, and hides a private repo from a viewer", async () => {
  const db = await connectDb(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "secretcraft", visibility: "private" }]).onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility"]))));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "secretcraft" }]).onConflict((oc) => oc.doNothing()));
  for (const [repo, n] of [["photocraft", 1], ["secretcraft", 2]] as const) {
    await db.run(db.k.insertInto("items").values({ repo, number: n, kind: "pr", state: "OPEN", title: `Title ${n}`, author: "dev" }));
  }
  const job = async (repo: string, n: number) => {
    const id = (await db.get(db.k.insertInto("jobs").values({ step: "opus-review", params: "{}", requested_by: "pipeline", requested_at: at(5), state: "running", started_at: at(5), progress: "reviewing 1 of 1", repo }).returning("id")))!.id;
    await db.run(db.k.insertInto("job_items").values({ job_id: id, repo, number: n, at: at(4) }));
    return id;
  };
  const pj = await job("photocraft", 1);
  await job("secretcraft", 2);
  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 1 }], prompt: "x" });
  await db.run(db.k.updateTable("agent_runs").set({ job_id: pj }).where("id", "=", run));
  await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "secretcraft", number: 2 }], prompt: "x" });
  const sync = async (started_at: string, ended_at: string, error: string | null) => await db.run(db.k.insertInto("sync_runs").values({ started_at, ended_at, mode: "full", items: 0, error }));
  await sync(at(40), at(39), null);
  for (const m of [30, 20, 10]) await sync(at(m), at(m - 1), "HTTP 502 from GitHub");

  const op = await now(db, req("operator"));
  const jobs = op.entries.filter((e) => e.kind === "job");
  assert.equal(jobs.length, 2);
  const j = jobs.find((e) => e.items[0]?.repo === "photocraft")!;
  assert.deepEqual(j.items.map((i) => `${i.repo}#${i.number}`), ["photocraft#1"]);
  assert.match(j.event!, /^job:\d+$/);
  assert.equal(j.progress, "reviewing 1 of 1");
  assert.equal(j.state, "running");
  const call = j.children.find((r) => r.key === `run:${run}`)!;
  assert.ok(!op.entries.some((r) => r.key === `run:${run}`), "the call is nested under its job, not listed twice");
  assert.equal(call.event, `run:${run}`);
  assert.equal(call.detail, `/agents/${run}`);
  const sy = op.health.problems.find((p) => p.area === "sync")!;
  assert.equal(sy.tone, "bad");
  assert.match(sy.text, /HTTP 502/);

  const viewer = await now(db, req("viewer"));
  assert.ok(!JSON.stringify(viewer).includes("secretcraft"), "nothing of the private repo");
  assert.deepEqual(viewer.entries.map((r) => [r.kind, r.children.length]), [["job", 1]], "the visible job with its call nested");

  // A failed job and a failed model call: staff read the error text, viewers only that it failed.
  await db.run(db.k.insertInto("jobs").values({ step: "opus-review", params: "{}", requested_by: "pipeline", requested_at: at(4), state: "failed", started_at: at(4), ended_at: at(2), error: "exit 1: token ghp_xyz leaked", repo: "photocraft" }));
  const bad = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 1 }], prompt: "x" });
  await db.run(db.k.updateTable("agent_runs").set({ state: "failed", ended_at: at(1), error: "stack: boom in /srv/app" }).where("id", "=", bad));
  const texts = (n: Awaited<ReturnType<typeof now>>) => JSON.stringify(n.entries.filter((e) => e.state === "failed").map((e) => [e.title, e.summary]));
  const staff = texts(await now(db, req("operator")));
  assert.ok(staff.includes("ghp_xyz") && staff.includes("boom"), staff);
  const plain = texts(await now(db, req("viewer")));
  assert.ok(!/ghp_xyz|boom/.test(plain) && /failed/.test(plain), plain);
});

test("Now attaches a job's writes to it, groups the other writes, leaves out housekeeping, and reports red mains only for pipeline repos", async () => {
  const db = await connectDb(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "wordcraft", visibility: "public" }]).onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility"]))));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "wordcraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.updateTable("tracked_repos").set({ pipeline: 1 }).where("name", "=", "photocraft"));
  const audit = async (at: string, action: string, target: string) => await db.run(db.k.insertInto("audit").values({ at, login: "autocraft", action, target, details: "{}" }));
  for (let n = 1; n <= 5; n++) await audit(at(10 - n), "review-post", `photocraft#${n}`);
  for (let n = 1; n <= 20; n++) await audit(at(3), "unassign", `photocraft#${n}`);
  await audit(at(2), "ci-run-approve", "photocraft#1");
  await audit(at(30), "act-close", "photocraft#9");
  const id = (await db.get(db.k.insertInto("jobs").values({ step: "opus-review", params: "{}", requested_by: "pipeline", requested_at: at(60), state: "done", started_at: at(60), ended_at: at(50), summary: "Reviewed 1 PR: 1 take", repo: "photocraft", items: 1, acted: 0 }).returning("id")))!.id;
  await db.run(db.k.insertInto("job_items").values({ job_id: id, repo: "photocraft", number: 7, at: at(55) }));
  await audit(at(55), "review-post", "photocraft#7");

  const op = await now(db, req("operator"));
  assert.deepEqual(op.entries.map((e) => e.title), ["Posted 5 reviews", "Closed", "Review pull requests"], "no assign, unassign or CI approval rows; the job's review is on the job");
  const g = op.entries[0]!;
  assert.equal(g.items.length, 5);
  assert.equal(g.itemCount, 5);
  const job = op.entries[2]!;
  assert.equal(job.summary, "Reviewed 1 PR: 1 take");
  assert.deepEqual(job.writes.map((w) => w.summary), ["Posted review"]);

  for (const repo of ["photocraft", "wordcraft"]) await db.run(db.k.insertInto("main_ci").values({ repo, head_sha: "abc", branch: "main", state: "red", failing: "[]", checks: "[]", first_seen_at: at(5), state_changed_at: at(5), updated_at: at(1), committed_at: at(6) }));
  const mains = (await now(db, req("operator"))).health.problems.filter((p) => p.area === "main-ci").map((p) => p.id);
  assert.deepEqual(mains, ["main-ci:photocraft"], "a repo with the pipeline off is not reported");
});

test("Now leaves out empty and idle jobs and lists running housekeeping jobs on one line", async () => {
  const db = await connectDb(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const job = async (step: string, requested_at: string, state: string, started_at: string, ended_at: string | null, progress: string | null, items: number | null, acted: number | null) =>
    await db.run(db.k.insertInto("jobs").values({ step, params: "{}", requested_by: "pipeline", requested_at, state, started_at, ended_at, progress, items, acted }));
  await job("unassign", at(1), "running", at(1), null, null, null, null);
  await job("rank", at(1), "running", at(1), null, null, null, null);
  await job("embed", at(9), "running", at(9), null, "embedding", null, null);
  await job("fixup", at(30), "done", at(30), at(29), null, 0, 0);
  const r = await now(db, req("operator"));
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.alsoRunning, ["Embed items", "Rank open items"]);
});

test("Now pages the feed by time without repeating or skipping an entry", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "photocraft", visibility: "public" }).onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility"]))));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));
  // 40 minutes apart: far enough that no two rows group.
  for (let n = 1; n <= 40; n++) await db.run(db.k.insertInto("audit").values({ at: new Date(Date.UTC(2026, 0, 1) + n * 40 * 60_000).toISOString(), login: "autocraft", action: "act-close", target: `photocraft#${n}`, details: "{}" }));
  const seen: string[] = [];
  let page: { entries: { key: string }[]; nextCursor: string | null } = await now(db, req("operator"));
  seen.push(...page.entries.map((e) => e.key));
  for (let guard = 0; page.nextCursor && guard < 10; guard++) {
    page = await nowFeed(db, { ...req("operator"), query: new URLSearchParams({ before: page.nextCursor }) } as Req);
    seen.push(...page.entries.map((e) => e.key));
  }
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen).size, 40);
});

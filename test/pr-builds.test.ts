import assert from "node:assert/strict";
import { test } from "node:test";
import { claim } from "../src/build/tasks.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { setFeature } from "../src/build/features.ts";
import { collectPrBuilds, prBuildDue, runPrBuilds } from "../src/prbuild/index.ts";
import { selectPrBuilds, setPerDay, setScope } from "../src/prbuild/select.ts";
import { prBuildView } from "../src/prbuild/view.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";

const sha = (c: string) => c.repeat(40);
const noFetch = { baseOf: async () => "b".repeat(40), fetchCrates: async () => ({ ok: true as const, rust: true, crates: [] }) };

async function setup() {
  const db = await connectDb(":memory:");
  await db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public'), ('vault', 'private')").run();
  for (const r of ["app", "vault"]) await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(r);
  const add = async (repo: string, number: number, author: string, assoc: string, head: string) =>
    await db.prepare("INSERT INTO items (repo, number, kind, state, author, author_association, head_oid, is_draft, created_at) VALUES (?, ?, 'pr', 'OPEN', ?, ?, ?, 0, ?)")
      .run(repo, number, author, assoc, head, `2026-11-0${number}T00:00:00Z`);
  await add("app", 1, "stranger", "NONE", sha("a"));
  await add("app", 2, "regular", "MEMBER", sha("b"));
  await add("app", 3, "held-one", "NONE", sha("c"));
  await add("vault", 4, "stranger", "NONE", sha("d"));
  await db.prepare("INSERT INTO outside_holds (repo, number, author, kind, reason) VALUES ('app', 3, 'held-one', 'pr', 'limit')").run();
  const rust = () => true;
  const tasks = async () => await db.prepare("SELECT number, step, priority, plan, warm_role FROM build_tasks ORDER BY id").all() as { number: number; step: string; priority: number; plan: string; warm_role: string }[];
  return { db, add, rust, tasks };
}

test("nothing is queued while the switch is off; on, only the outside PR of a public repo is built, and scope all adds the insider's", async () => {
  const { db, tasks } = await setup();
  assert.equal(await prBuildDue(db, "app"), false);
  assert.equal((await runPrBuilds(db, "app", () => {}, noFetch)).queued, 0);
  assert.equal((await tasks()).length, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pr_builds").get())!.n, 0);

  await setFeature(db, "pr-builds", true, "op");
  assert.equal(await prBuildDue(db, "app"), false, "the repo's own switch is still off");
  await setFeature(db, "pr-builds", true, "op", "app");
  await setFeature(db, "pr-builds", true, "op", "vault");
  assert.equal(await prBuildDue(db, "app"), true);
  assert.equal((await runPrBuilds(db, "vault", () => {}, noFetch)).queued, 0, "private repo");
  assert.equal((await runPrBuilds(db, "app", () => {}, noFetch)).queued, 1);
  const [t, ...rest] = await tasks();
  assert.equal(rest.length, 0);
  assert.deepEqual([t!.number, t!.step, t!.priority, t!.warm_role], [1, "pr-build", -5, "use"]);
  assert.ok((JSON.parse(t!.plan) as { cmd: string[] }[]).every((s) => s.cmd.includes("--workspace") || s.cmd[0] === "sh"));
  assert.equal((await runPrBuilds(db, "app", () => {}, noFetch)).queued, 0, "one build per head");

  await setScope(db, "app", "all");
  assert.deepEqual((await selectPrBuilds(db, "app", { rust: () => true })).map((c) => c.number), [2], "held PR 3 stays out");
  await setPerDay(db, 1);
  assert.deepEqual(await selectPrBuilds(db, "app", { rust: () => true }), [], "daily cap reached");
});

test("collect: pass, a failure where CI passed is noted without a hold, a moved head is stale", async () => {
  const { db, add, tasks } = await setup();
  await setFeature(db, "pr-builds", true, "op");
  await setFeature(db, "pr-builds", true, "op", "app");
  await setScope(db, "app", "all");
  await add("app", 5, "stranger", "NONE", sha("e"));
  await runPrBuilds(db, "app", () => {}, noFetch);
  assert.deepEqual((await tasks()).map((t) => t.number), [1, 2, 5]);
  const id = async (n: number) => (await db.prepare("SELECT id FROM build_tasks WHERE number = ?").get(n) as { id: number }).id;
  const result = async (n: number, steps: [string, number][]) => {
    const plan = JSON.parse((await db.prepare("SELECT plan FROM build_tasks WHERE number = ?").get(n) as { plan: string }).plan) as { name: string }[];
    const done = steps.map(([step, exitCode]) => ({ step, exitCode, durationMs: 1, timedOut: false }));
    await db.prepare("UPDATE build_tasks SET state = ?, results = ? WHERE number = ?").run(done.every((r) => r.exitCode === 0) && done.length === plan.length ? "done" : "failed", JSON.stringify(done), n);
  };
  await result(1, [["fetch deps", 0], ["build", 0], ["test", 0]]);
  await result(2, [["fetch deps", 0], ["build", 0], ["test", 101]]);
  await db.prepare("INSERT INTO pr_checks (repo, number, head_oid, overall, checks, fetched_at) VALUES ('app', 2, ?, 'success', '[]', '2099-01-01T00:00:00Z')").run(sha("b"));
  await db.prepare("UPDATE items SET head_oid = ? WHERE repo = 'app' AND number = 5").run(sha("f"));
  const verifsBefore = JSON.stringify(await db.prepare("SELECT * FROM verifications").all());

  const s = await collectPrBuilds(db, "app", () => {});
  assert.deepEqual([s.passed, s.failed, s.disagreements, s.stale], [1, 1, 1, 1]);
  const state = async (n: number) => await db.prepare("SELECT state, disagree, summary FROM pr_builds WHERE number = ?").get(n) as { state: string; disagree: number; summary: string | null };
  assert.equal((await state(1)).state, "passed");
  assert.deepEqual([(await state(2)).state, (await state(2)).disagree, (await state(2)).summary], ["failed", 1, "test failed with exit code 101"]);
  assert.equal((await state(5)).state, "stale");
  assert.equal((await db.prepare("SELECT state FROM build_tasks WHERE id = ?").get(await id(5)) as { state: string }).state, "cancelled");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM stages WHERE stage = 'pr-build-disagree'").get() as { n: number }).n, 0, "the note never becomes the item's latest stage");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM stages WHERE stage = 'hold'").get() as { n: number }).n, 0);
  assert.equal(JSON.stringify(await db.prepare("SELECT * FROM verifications").all()), verifsBefore);
  assert.equal((await prBuildView(db, "app", 2, sha("b"), true))?.disagree, true);
  assert.equal((await prBuildView(db, "app", 2, sha("b"), false))?.summary, null, "viewers get the state only");
  await setFeature(db, "pr-builds", false, "op", "app");
  assert.equal(await prBuildView(db, "app", 2, sha("b"), true), null, "hidden while the switch is off");
});

const claimer = async (db: Db) => {
  await createEnv(db, { id: "env-one", label: "env-one", kind: "local-sandbox", slots: 4 }, "op");
  await hello(db, "env-one", { version: "1", capabilities: { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] }, slots: 4 });
  return async () => (await claim(db, "env-one", 4)).tasks.map((t) => t.repo);
};

test("switching off stops queued builds, and the worker does not claim them while it is off", async () => {
  const { db, tasks } = await setup();
  await setFeature(db, "pr-builds", true, "op");
  await setFeature(db, "pr-builds", true, "op", "app");
  await runPrBuilds(db, "app", () => {}, noFetch);
  assert.equal((await tasks()).length, 1);
  // Off by the settings alone (as a stale row would be): the claim skips it.
  await db.prepare("UPDATE settings SET value = 'off' WHERE key = 'build_feature:pr-builds:app'").run();
  assert.deepEqual(await (await claimer(db))(), []);
  await db.prepare("UPDATE settings SET value = 'on' WHERE key = 'build_feature:pr-builds:app'").run();
  await setFeature(db, "pr-builds", false, "op", "app");
  assert.equal((await db.prepare("SELECT state FROM build_tasks").get() as { state: string }).state, "cancelled");
  assert.equal((await db.prepare("SELECT state FROM pr_builds").get() as { state: string }).state, "stale");
});

test("an operator's cancel is not retried; a lost task is retried once", async () => {
  const { db, tasks } = await setup();
  await setFeature(db, "pr-builds", true, "op");
  await setFeature(db, "pr-builds", true, "op", "app");
  await runPrBuilds(db, "app", () => {}, noFetch);
  await db.prepare("UPDATE build_tasks SET state = 'cancelled'").run();
  await collectPrBuilds(db, "app", () => {});
  assert.equal((await tasks()).length, 1);
  assert.deepEqual({ ...(await db.prepare("SELECT state, summary FROM pr_builds").get() as object) }, { state: "error", summary: "the build task was cancelled" });

  const t2 = await setup();
  await setFeature(t2.db, "pr-builds", true, "op");
  await setFeature(t2.db, "pr-builds", true, "op", "app");
  await runPrBuilds(t2.db, "app", () => {}, noFetch);
  await t2.db.prepare("UPDATE build_tasks SET state = 'lost'").run();
  assert.equal((await collectPrBuilds(t2.db, "app", () => {})).retried, 1);
  assert.equal((await t2.tasks()).length, 2);
});

test("a failure that CI later contradicts is noted once, when CI turns green", async () => {
  const { db } = await setup();
  await setFeature(db, "pr-builds", true, "op");
  await setFeature(db, "pr-builds", true, "op", "app");
  await runPrBuilds(db, "app", () => {}, noFetch);
  await db.prepare("UPDATE build_tasks SET state = 'failed', results = ?").run(JSON.stringify([{ step: "fetch deps", exitCode: 0, durationMs: 1, timedOut: false }, { step: "build", exitCode: 1, durationMs: 1, timedOut: false }]));
  assert.equal((await collectPrBuilds(db, "app", () => {})).disagreements, 0);
  await db.prepare("INSERT INTO pr_checks (repo, number, head_oid, overall, checks, fetched_at) VALUES ('app', 1, ?, 'success', '[]', '2099-01-01T00:00:00Z')").run(sha("a"));
  assert.equal(await prBuildDue(db, "app"), true);
  assert.equal((await collectPrBuilds(db, "app", () => {})).disagreements, 1);
  assert.equal((await collectPrBuilds(db, "app", () => {})).disagreements, 0);
  assert.equal((await prBuildView(db, "app", 1, sha("a"), true))?.disagree, true);
});

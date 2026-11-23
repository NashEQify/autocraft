import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BUILD_FEATURES, featureOn, featureStates, setFeature } from "../src/build/features.ts";
import { INPUT_TOPICS } from "../src/runner/autopilot.ts";
import { readSeqs } from "../src/live.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { rowid } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const fresh = async () => await connectDb(join(mkdtempSync(join(SCRATCH, "bf-")), "t.db"));

test("every feature is off until switched on", async () => {
  const db = await fresh();
  for (const f of BUILD_FEATURES) assert.equal(await featureOn(db, f, "app"), false);
  assert.ok((await featureStates(db)).every((s) => !s.on && s.repos.length === 0));
});

test("a repo-scoped feature needs the global switch and the repo's own; scan-tests ignores the repo", async () => {
  const db = await fresh();
  await setFeature(db, "screenshots", true, "op", "app");
  assert.equal(await featureOn(db, "screenshots", "app"), false, "repo on, global off");
  await setFeature(db, "screenshots", true, "op");
  assert.equal(await featureOn(db, "screenshots", "app"), true);
  assert.equal(await featureOn(db, "screenshots", "other"), false);
  assert.equal(await featureOn(db, "screenshots"), true);
  assert.deepEqual((await featureStates(db)).find((s) => s.feature === "screenshots"), { feature: "screenshots", on: true, repos: ["app"] });
  await setFeature(db, "scan-tests", true, "op", "app");
  assert.equal(await featureOn(db, "scan-tests", "other"), true);
  const row = (await db.get(db.k.selectFrom("audit").select(["login", "target", "details"]).where("action", "=", "build-feature").orderBy(rowid("audit")).limit(1)))!;
  assert.deepEqual([row.login, row.target, JSON.parse(row.details ?? "null")], ["op", "screenshots", { feature: "screenshots", on: true, repo: "app" }]);
});

test("a switch change is not planner input", async () => {
  const db = await fresh();
  assert.ok(!INPUT_TOPICS.includes("build-features" as never));
  const before = await readSeqs(db);
  await setFeature(db, "nightly", true, "op");
  const after = await readSeqs(db);
  assert.equal(after["build-features"], (before["build-features"] ?? 0) + 1);
  assert.equal(after.settings, before.settings);
});

test("the Implement switch is planner input", async () => {
  const db = await fresh();
  const before = await readSeqs(db);
  await setFeature(db, "implement", true, "op", "app");
  const after = await readSeqs(db);
  const woke = INPUT_TOPICS.filter((t) => after[t] !== before[t]);
  assert.ok(woke.length > 0, "no planner input topic moved");
  assert.equal(after.settings, before.settings, "the settings topic keeps its own trigger");
});

test("a maintainer with write access to a repo switches its Implement feature, not another repo's, and a viewer cannot", async () => {
  const { postFeature } = await import("../src/dash/api/build.ts");
  const db = await fresh();
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "x" }, { name: "y" }]).onConflict((oc) => oc.doNothing()));
  const as = (role: string, writes: string[], json: unknown) => ({ params: {}, query: new URLSearchParams(), json, user: { login: "u", role, canWrite: async (r: string) => writes.includes(r), canRead: async () => true } }) as never;
  await postFeature(db, as("maintainer", ["x"], { feature: "implement", on: true, repo: "x" }));
  assert.equal((await featureStates(db)).find((s) => s.feature === "implement")!.repos.includes("x"), true);
  await assert.rejects(postFeature(db, as("maintainer", ["x"], { feature: "implement", on: true, repo: "y" })), /write access/);
  await assert.rejects(postFeature(db, as("maintainer", ["x"], { feature: "implement", on: true })), /operator/);
  await assert.rejects(postFeature(db, as("maintainer", ["x"], { feature: "nightly", on: true, repo: "x" })), /operator/);
  await assert.rejects(postFeature(db, as("viewer", ["x"], { feature: "implement", on: true, repo: "x" })), /write access/);
});

test("a write-maintainer approves issue implementations for their repo only", async () => {
  const { fixIssueApproval } = await import("../src/dash/api/admin.ts");
  const db = await fresh();
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "x" }, { name: "y" }]).onConflict((oc) => oc.doNothing()));
  const as = (role: string, name: string) => ({ params: {}, query: new URLSearchParams(), json: { name }, user: { login: "u", role, canWrite: async (r: string) => r === "x", canRead: async () => true } }) as never;
  assert.equal((await fixIssueApproval(db, as("maintainer", "x"), true)).fixing?.approved, true);
  await assert.rejects(fixIssueApproval(db, as("maintainer", "y"), true), /write access/);
  await assert.rejects(fixIssueApproval(db, as("viewer", "x"), false), /write access/);
});

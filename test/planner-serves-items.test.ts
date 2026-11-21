// User-local mode: a job that serves every repo is proposed only for items it can work now. Items whose model call no Task
// Runner takes would leave it handling nothing, and the planner would queue it again on every change of its input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setJevEnabled } from "../src/agents/jev.ts";
import { plannedItems } from "../src/core/select-items.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { excluded } from "../src/db/kx.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { noRunnerFor } from "../src/runner/concurrency.ts";
import { detectAutopilot, LANES } from "../src/runner/autopilot.ts";
import { OPERATOR, T0, world } from "./world-db.ts";

test("prioritize waits for a Task Runner or Jev while its items need one", async () => {
  const w = await (await (await world()).repo()).issue(1);
  await fillEmbedHashes(w.db);
  await setInferenceMode(w.db, "user-local", "test");
  await setJevEnabled(w.db, false, "test");
  assert.equal((await plannedItems(w.db, "prioritize")).length, 1, "the item has no priority");
  const lanes = LANES.filter((l) => l.name === "priority");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  const idle = await detectAutopilot(w.db, { lanes });
  assert.deepEqual(idle.proposals, [], "no Task Runner and no Jev: a job would rate nothing");
  assert.equal(idle.status?.prioritize, noRunnerFor("app"), "the stage names the wait");
  await setJevEnabled(w.db, true, "test");
  await w.db.run(w.db.k.insertInto("settings").values({ key: "jev_unavailable", value: JSON.stringify({ kind: "account", reason: "out of credit", since: new Date().toISOString(), at: new Date().toISOString() }) })
    .onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  assert.deepEqual(await proposed(), [], "Jev's account failed a moment ago");

  const token = (await createToken(w.db, OPERATOR, "helper", { kind: "runner" })).row.id;
  await storeStatus(w.db, token, OPERATOR, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserRepos(w.db, OPERATOR, ["app"]);
  assert.deepEqual(await proposed(), ["prioritize"], "a Task Runner takes the repo");
});

test("dupes-compare runs without a Task Runner only for a set settled by rule", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  await fillEmbedHashes(w.db);
  const hash = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9, created_at: T0, verdict: "duplicate" }));
  await setInferenceMode(w.db, "user-local", "test");
  const lanes = LANES.filter((l) => l.name === "dupes-compare");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  assert.equal((await plannedItems(w.db, "dupes-compare")).length, 2, "both open members wait for the comparison");
  assert.deepEqual(await proposed(), [], "two open members need a model call no Task Runner takes");
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 2));
  assert.deepEqual(await proposed(), ["dupes-compare"], "a closed member wins by rule, without a model");
});

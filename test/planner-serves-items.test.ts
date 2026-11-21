// User-local mode: a job that serves every repo is proposed only for items it can work now. Items whose model call no Task
// Runner takes would leave it handling nothing, and the planner would queue it again on every change of its input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setJevEnabled } from "../src/agents/jev.ts";
import { plannedItems } from "../src/core/select-items.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { noRunnerFor } from "../src/runner/concurrency.ts";
import { detectAutopilot, LANES } from "../src/runner/autopilot.ts";
import { OPERATOR, T0, world } from "./world-db.ts";

test("prioritize waits for a Task Runner or Jev while its items need one", async () => {
  const w = world().repo().issue(1);
  fillEmbedHashes(w.db);
  setInferenceMode(w.db, "user-local", "test");
  setJevEnabled(w.db, false, "test");
  assert.equal(plannedItems(w.db, "prioritize").length, 1, "the item has no priority");
  const lanes = LANES.filter((l) => l.name === "priority");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  const idle = await detectAutopilot(w.db, { lanes });
  assert.deepEqual(idle.proposals, [], "no Task Runner and no Jev: a job would rate nothing");
  assert.equal(idle.status?.prioritize, noRunnerFor("app"), "the stage names the wait");
  setJevEnabled(w.db, true, "test");
  w.db.prepare("INSERT INTO settings (key, value) VALUES ('jev_unavailable', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ kind: "account", reason: "out of credit", since: new Date().toISOString(), at: new Date().toISOString() }));
  assert.deepEqual(await proposed(), [], "Jev's account failed a moment ago");

  const token = createToken(w.db, OPERATOR, "helper", { kind: "runner" }).row.id;
  storeStatus(w.db, token, OPERATOR, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  setUserRepos(w.db, OPERATOR, ["app"]);
  assert.deepEqual(await proposed(), ["prioritize"], "a Task Runner takes the repo");
});

test("dupes-compare runs without a Task Runner only for a set settled by rule", async () => {
  const w = world().repo().issue(1, { title: "crash on open" }).issue(2, { title: "crashes when opening" });
  fillEmbedHashes(w.db);
  const hash = (n: number) => (w.db.prepare("SELECT embed_hash FROM items WHERE repo = 'app' AND number = ?").get(n) as { embed_hash: string }).embed_hash;
  w.db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at, verdict) VALUES ('app', 1, 2, ?, ?, 0.9, ?, 'duplicate')").run(hash(1), hash(2), T0);
  setInferenceMode(w.db, "user-local", "test");
  const lanes = LANES.filter((l) => l.name === "dupes-compare");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  assert.equal(plannedItems(w.db, "dupes-compare").length, 2, "both open members wait for the comparison");
  assert.deepEqual(await proposed(), [], "two open members need a model call no Task Runner takes");
  w.db.prepare("UPDATE items SET state = 'CLOSED' WHERE repo = 'app' AND number = 2").run();
  assert.deepEqual(await proposed(), ["dupes-compare"], "a closed member wins by rule, without a model");
});

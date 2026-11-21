// The labels stage is not queued for a repo whose GitHub write budget is used up: its writes would be refused as paced and the
// job would label nothing. The stage says until when, and the planner wakes then.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setApproval } from "../src/labels/approval.ts";
import { detectAutopilot, LANES } from "../src/runner/autopilot.ts";
import { world } from "./world-db.ts";

test("labels-apply waits while the repo's write budget is used up", async () => {
  const w = world().repo().issue(1, { label: "bugfix" });
  setApproval(w.db, "op", "app", true);
  const lanes = LANES.filter((l) => l.name === "labels");
  assert.deepEqual((await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step), ["labels-apply"]);

  const add = w.db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, 'pipeline', 'comment', 'app#2', ?)");
  const now = Date.now();
  for (let i = 0; i < 60; i++) add.run(new Date(now - 30_000 + i * 100).toISOString(), JSON.stringify({ identity: "legacy", paceOwner: "", state: "done" }));
  const held = await detectAutopilot(w.db, { lanes });
  assert.deepEqual(held.proposals, []);
  assert.match(held.status?.["labels-apply"] ?? "", /write budget for app is used up until/);
  assert.ok((held.wakeAt ?? 0) > now, "the planner wakes when the window moves");
});

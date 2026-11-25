// The planner wakes on its own only for waits that end by themselves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LANES, detectAutopilot, pauseOf, setLimit } from "../src/runner/autopilot.ts";
import { OPERATOR, world } from "./world-db.ts";

test("a step paused until an operator acts sets no wake time", async () => {
  const w = await (await (await world()).repo()).issue(1);
  const lanes = LANES.filter((l) => l.name === "priority");
  await setLimit(w.db, "prioritize", { perDay: 0 }, OPERATOR);
  assert.equal((await pauseOf(w.db, "prioritize"))?.wakeAt, null);
  const r = await detectAutopilot(w.db, { lanes });
  assert.equal(r.wakeAt ?? null, null, "only a write lifts a limit of 0");
});

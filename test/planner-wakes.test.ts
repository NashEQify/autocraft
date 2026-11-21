// The planner wakes on its own only for waits that end by themselves, and the flow summary it triggers does not feed it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintOf, INPUT_TOPICS, LANES, detectAutopilot, pauseOf, setLimit } from "../src/runner/autopilot.ts";
import { readSeqs } from "../src/live.ts";
import { OPERATOR, world } from "./world-db.ts";

test("a step paused until an operator acts sets no wake time", async () => {
  const w = world().repo().issue(1);
  const lanes = LANES.filter((l) => l.name === "priority");
  setLimit(w.db, "prioritize", { perDay: 0 }, OPERATOR);
  assert.equal(pauseOf(w.db, "prioritize")?.wakeAt, null);
  const r = await detectAutopilot(w.db, { lanes });
  assert.equal(r.wakeAt ?? null, null, "only a write lifts a limit of 0");
});

test("a write to flow_summary leaves the planner's input unchanged", () => {
  const w = world().repo().issue(1);
  const fp = () => fingerprintOf(w.db, { topics: INPUT_TOPICS }, "prioritize", {}, readSeqs(w.db));
  const before = fp();
  const flow = readSeqs(w.db).flow;
  w.db.prepare("INSERT INTO flow_summary (repo, counts, counted_at, stale, decisions_sig) VALUES ('app', '{}', 'now', 0, '')").run();
  assert.notEqual(readSeqs(w.db).flow, flow, "the flow topic moved");
  assert.equal(fp(), before);
});

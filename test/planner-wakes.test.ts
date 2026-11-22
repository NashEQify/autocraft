// The planner wakes on its own only for waits that end by themselves, and the flow summary it triggers does not feed it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintOf, INPUT_TOPICS, LANES, detectAutopilot, pauseOf, setLimit } from "../src/runner/autopilot.ts";
import { readSeqs } from "../src/live.ts";
import { OPERATOR, world } from "./world-db.ts";

test("a step paused until an operator acts sets no wake time", async () => {
  const w = await (await (await world()).repo()).issue(1);
  const lanes = LANES.filter((l) => l.name === "priority");
  await setLimit(w.db, "prioritize", { perDay: 0 }, OPERATOR);
  assert.equal((await pauseOf(w.db, "prioritize"))?.wakeAt, null);
  const r = await detectAutopilot(w.db, { lanes });
  assert.equal(r.wakeAt ?? null, null, "only a write lifts a limit of 0");
});

test("a write to flow_summary leaves the planner's input unchanged", async () => {
  const w = await (await (await world()).repo()).issue(1);
  const fp = async () => await fingerprintOf(w.db, { topics: INPUT_TOPICS }, "prioritize", {}, await readSeqs(w.db));
  const before = await fp();
  const flow = (await readSeqs(w.db)).flow;
  await w.db.run(w.db.k.insertInto("flow_summary").values({ repo: "app", counts: "{}", counted_at: "now", stale: 0, decisions_sig: "" }));
  assert.notEqual((await readSeqs(w.db)).flow, flow, "the flow topic moved");
  assert.equal(await fp(), before);
});

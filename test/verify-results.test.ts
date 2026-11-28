import assert from "node:assert/strict";
import { test } from "node:test";
import { verdictOf } from "../src/verify/results.ts";
import { loadMergeFacts, saveVerifications, settleVerifications, type HeadRef } from "../src/data/merge/index.ts";
import { headOf } from "../src/data/merge/read.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("a passing head marks only a regression comparison whose base result shows nothing as inconclusive", () => {
  const head = { kind: "pass" } as const;
  const failedTest = { kind: "fail", step: "test", exitCode: 1, timedOut: false } as const;
  const shown = verdictOf(head, failedTest);
  assert.equal(shown.state, "passed");
  assert.notEqual(shown.inconclusive, true, "the base failed the test: the regression is shown");
  assert.notEqual(verdictOf(head, null).inconclusive, true, "no base run: no comparison to call inconclusive");
  for (const base of [{ ...failedTest, timedOut: true }, { ...failedTest, step: "build" }]) {
    const v = verdictOf(head, base);
    assert.equal(v.state, "passed");
    assert.equal(v.inconclusive, true, JSON.stringify(base));
    assert.ok(v.note, "the note says what the comparison does not show");
  }
});

test("the inconclusive flag is stored with the settled verification and cleared when the head is planned again", async () => {
  const db = await connectDb(":memory:");
  const row = { repo: "app", number: 7, headSha: "h7", baseSha: "b7", kind: "regression", reason: "r", plan: null, model: null, headTaskId: null, baseTaskId: null, summary: null, note: null, at: "2026-11-28T00:00:00Z", finishedAt: null };
  const key = headOf("app", 7, "h7") as HeadRef;
  const stored = async () => (await loadMergeFacts(db, [{ repo: "app", number: 7 }])).verifications.get(key);
  await saveVerifications(db, [{ ...row, state: "planned" }]);
  await settleVerifications(db, [{ key, from: ["planned"], set: { state: "passed", note: "the base did not build", inconclusive: true } }]);
  assert.equal((await stored())?.inconclusive, true);
  await saveVerifications(db, [{ ...row, state: "planned" }]);
  assert.equal((await stored())?.inconclusive, false, "a new plan for the head starts without the earlier result's flag");
});

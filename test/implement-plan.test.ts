// The plan step's reply handling: a plan that is not ready asks its author question and leaves the attempt waiting on it;
// a reply that breaks the format is refused rather than guessed at.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanReply, recordPlan } from "../src/implement/plan.ts";
import { currentImplementation, roundsOf, startImplementation } from "../src/implement/store.ts";
import type { PlanReply, QuestionRound } from "../src/implement/types.ts";
import { join } from "node:path";
import { connectDb } from "../src/db/open.ts";
import { tmpdir } from "./world-db.ts";

const notReady: PlanReply = {
  ready: false, kind: "bugfix", summary: "The export dialog should reopen in the last folder.", plan: "Found the dialog in src/export.rs; the folder is not stored.",
  acceptance: [], verification: { tests: [], app: null }, size: "S", risks: [],
  questions: [{ audience: "author", text: "Which version shows this, and does it happen with every file type?", options: [], recommended: null }],
};

test("a plan with an author question posts it once and leaves the attempt asked on that question", async () => {
  const db = await connectDb(join(tmpdir("implement-plan"), "t.db"));
  try {
    const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: "maint", textHash: "h" });
    const posted: string[] = [];
    const state = await recordPlan(db, impl, { callId: 41, reply: notReady }, {
      commentsApproved: true, postComment: async (text) => { posted.push(text); return "123"; }, log: () => {},
    });
    assert.equal(state, "asked");
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.includes(notReady.questions[0]!.text));
    const row = await currentImplementation(db, "app", 7);
    assert.equal(row?.state, "asked");
    assert.equal(row?.plan?.ready, false);
    const qs = (await roundsOf(db, impl.id)).filter((r) => r.kind === "question").map((r) => r.result as QuestionRound);
    assert.deepEqual(qs.map((q) => [q.audience, q.commentId]), [["author", "123"]]);
  } finally {
    await db.close();
  }
});

test("a malformed plan reply is refused with what is wrong", () => {
  const ok = JSON.stringify(notReady);
  assert.equal(parsePlanReply(`Here it is:\n\`\`\`json\n${ok}\n\`\`\``).ready, false);
  assert.throws(() => parsePlanReply(JSON.stringify({ ...notReady, questions: [] })), /questions/);
  assert.throws(() => parsePlanReply(JSON.stringify({ ...notReady, questions: [{ ...notReady.questions[0], audience: "maintainer" }] })), /options/);
  assert.throws(() => parsePlanReply(`${ok.slice(0, -1)}`), /JSON/);
  assert.throws(() => parsePlanReply(ok, true), /assume/);
});

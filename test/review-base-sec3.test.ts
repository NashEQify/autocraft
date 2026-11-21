// A review binds the base branch its diff was read against; a Merge answer carried across a base merge covers no fix-up.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { recordLiveBase } from "../src/merge/base.ts";
import { premergeAt } from "../src/premerge/store.ts";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { markedStaleSince, staleReviews } from "../src/review/discussion.ts";
import { reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());
const answerOf = async (w: World, n: number, head: string) => await w.rows("SELECT answer FROM decisions WHERE id = ?", mergeDecisionId("app", n, head));

test("a retarget makes the review stale like a push, and the re-review against the new base voids the old base's answer and pre-merge review", async () => {
  const w = (current = await (await (await (await (await (await world()).repo()).pr(1)).review(1)).answer(1, "merge")).premerge(1, "clean"));
  await w.db.run(w.db.k.updateTable("items").set({ base_ref: "release" }).where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ base_ref: "release" }).where("number", "=", 1));
  assert.equal((await staleReviews(w.db, "app")).size, 0);

  // The PR author retargets to the default branch; a live read before the merge records it.
  await recordLiveBase(w.db, "app", 1, "sha1", "main");
  assert.ok((await staleReviews(w.db, "app")).has("app#1@sha1"));
  assert.equal(await markedStaleSince(w.db, "app", 1, ""), false);
  const today = new Date().toISOString();
  for (let i = 0; i < 3; i++) await w.db.run(w.db.k.insertInto("opus_review_history").values({ repo: "app", number: 1, head_oid: "sha1", at: today, model: "m", mode: "full", verdict: "take", sure: 1, reason: "r" }));
  assert.equal((await reviewHold(w.db, "app", 1, "sha1"))?.kind, "cap");

  await saveOpus(w.db, "rv2", { repo: "app", number: 1, head_oid: "sha1" }, {
    mode: "full", base: null, baseRef: "main", model: "m",
    review: { ref: "app#1", verdict: "take", sure: true, reason: "fine", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] },
  });
  assert.equal((await staleReviews(w.db, "app")).size, 0);
  assert.deepEqual(await answerOf(w, 1, "sha1"), []);
  assert.equal(await premergeAt(w.db, "app", 1, "sha1"), null);
  assert.equal((await w.rows("SELECT trigger FROM opus_review_history WHERE number = 1 ORDER BY rowid DESC LIMIT 1"))[0]!.trigger, "base");
});

test("a Merge answer carried across a clean base merge ends when the review there asks for fixes", async () => {
  const w = (current = await (await (await (await (await world()).repo()).pr(30)).review(30, { verdict: "take" })).answer(30, "merge"));
  await w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number: 30, from_head: "sha30", to_head: "sha30m", state: "merged", attempt: 1, created_at: T0, own_diff: "same" }));
  await w.synced(30, "sha30m");
  await advancePreapprovals(w.db);
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "review");

  await w.review(30, { head: "sha30m", verdict: "take-fix" });
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "asked");
  assert.deepEqual(await answerOf(w, 30, "sha30m"), [{ answer: null }]);

  // The review's fix-up pushes model-written code: nothing answers Merge there in the operator's name.
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 30, from_head: "sha30m", to_head: "sha30f", state: "pushed", attempt: 1, created_at: T0 }));
  await (await w.synced(30, "sha30f")).review(30, { head: "sha30f" });
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  assert.equal((await w.rows("SELECT 1 FROM preapprovals WHERE number = 30 AND state NOT IN ('asked', 'cancelled')")).length, 0);
  assert.deepEqual(await answerOf(w, 30, "sha30f"), []);
});

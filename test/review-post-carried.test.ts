import { test } from "node:test";
import assert from "node:assert/strict";
import { postCandidates } from "../src/review/post.ts";
import { T0, T1, world } from "./world-db.ts";

test("a review carried over our fix-up is posted with the source review's points, naming both heads", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { head: "bbbbbbb2222" })).review(1, { head: "aaaaaaa1111", verdict: "take-fix" });
  const pub = JSON.stringify({ summary: "The change is right; one call can fail.", points: ["`src/net.rs:42`: send() unwraps the result."] });
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ public_review: pub, model: "claude-opus-5-5" }).where("repo", "=", "app").where("number", "=", 1));
  await w.db.run(w.db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "bbbbbbb2222", at: T1, model: "carried", mode: "carried", base_head: "aaaaaaa1111", verdict: "take", sure: 1, reason: "carried" }));
  assert.ok(T0 < T1);
  const c = await postCandidates(w.db, "app");
  assert.equal(c.length, 1);
  assert.equal(c[0]!.head_oid, "bbbbbbb2222");
  assert.equal(c[0]!.model, "claude-opus-5-5");
  assert.equal(c[0]!.opusAt, T1);
  const body = c[0]!.body;
  assert.match(body, /^Small fixes needed, made in bbbbbbb:/);
  assert.match(body, /send\(\) unwraps the result/);
  assert.match(body, /Recommendation: (merge|wait)/);
  assert.doesNotMatch(body, /after the fixes above/);
  assert.match(body, /Reviewed at aaaaaaa\. Fixes pushed in bbbbbbb\.\n\nRecommendation: [^\n]+$/);
});

test("a review posted by the box account is not edited once the repo writes as the app", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { head: "bbbbbbb2222" })).review(1, { head: "bbbbbbb2222", verdict: "take" });
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ public_review: JSON.stringify({ summary: "Fine.", points: [] }) }).where("repo", "=", "app").where("number", "=", 1));
  await w.db.run(w.db.k.insertInto("review_posts").values({ repo: "app", number: 1, review_id: "R1", head_oid: "aaaaaaa1111", posted_at: T0 }));
  assert.equal((await postCandidates(w.db, "app"))[0]!.editId, "R1");
  await w.db.run(w.db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }));
  assert.equal((await postCandidates(w.db, "app"))[0]!.editId, null);
});

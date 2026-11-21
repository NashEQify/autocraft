import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "./world-db.ts";
import { decidePr } from "../src/core/decide.ts";
import type { PlanSet } from "../src/core/plan-set.ts";
import { planned } from "../src/core/select.ts";
import { carriedReview } from "../src/review/carry.ts";
import { prFacts } from "./world.ts";
import { connectDb } from "../src/db/open.ts";

test("selection order: our broken push, then work in flight, then score", async () => {
  const mk = (n: number, over: Parameters<typeof prFacts>[0]) => { const facts = prFacts({ number: n, review: { head: "old" }, head: "h", ...over }); return { facts, plan: decidePr(facts) }; };
  const plans: PlanSet = {
    run: null, now: 0, pass: { rereadPaceAt: 0 }, items: [],
    prs: [mk(1, { score: 900 }), mk(2, { score: 10, inFlight: true }), mk(3, { score: 5, brokeByUs: true, inFlight: true }), mk(4, { score: 500, inFlight: true, mergeHeld: true })],
  };
  const order = (await planned(new DatabaseSync(":memory:"), "review", { plans })).map((p) => p.facts.number);
  assert.deepEqual(order, [3, 2, 1, 4]);
});

test("a verdict carries over only a single checked fix-up of ours", async () => {
  const db = await connectDb(join(tmpdir("carry"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, at, model, mode, verdict, sure, reason, why, seen_at) VALUES ('app', 1, 'E', ?, 'opus', 'full', 'take-fix', 1, 'r', 'needs a one-line fix', ?)`).run(at, at);
  await db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'E', 'H', 'pushed', 1, ?)").run(at);
  const c = { repo: "app", number: 1, head_oid: "H" };
  assert.equal(await carriedReview(db, c), null, "no approved patch check yet");
  await db.prepare("INSERT INTO patch_checks (kind, repo, number, subject, patch_hash, round, verdict, reasons, problems, model, created_at) VALUES ('fixup', 'app', 1, 'E', 'x', 1, 'approve', '', '[]', 'm', ?)").run(at);
  const k = await carriedReview(db, c);
  assert.equal(k?.review.verdict, "take");
  assert.deepEqual(k?.review.fixes, []);
  assert.equal(k?.review.why, null, "the take-fix reason described the fixes, now made");
  assert.equal(k?.review.reason, "carried from E: the only change is our checked fix-up");
  assert.equal(await carriedReview(db, { ...c, head_oid: "H2" }), null, "a contributor commit after ours");
});

test("a carried verdict is not carried again after new discussion or at a head that has a review", async () => {
  const db = await connectDb(join(tmpdir("carry2"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, at, model, mode, verdict, sure, reason, why, seen_at) VALUES ('app', 1, 'E', ?, 'opus', 'full', 'take-fix', 1, 'r', 'needs a one-line fix', ?)`).run(at, at);
  await db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'E', 'H', 'pushed', 1, ?)").run(at);
  await db.prepare("INSERT INTO patch_checks (kind, repo, number, subject, patch_hash, round, verdict, reasons, problems, model, created_at) VALUES ('fixup', 'app', 1, 'E', 'x', 1, 'approve', '', '[]', 'm', ?)").run(at);
  const c = { repo: "app", number: 1, head_oid: "H" };
  assert.ok(await carriedReview(db, c));
  assert.equal(await carriedReview(db, c, new Set(["app#1@E"])), null, "the earlier review has not read the discussion as it is now");
  await db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, at, model, mode, verdict, sure, reason) VALUES ('app', 1, 'H', ?, 'carried', 'carried', 'take', 1, 'r')`).run(at);
  assert.equal(await carriedReview(db, c), null, "a head with a review is reviewed, not carried, again");
});

test("with Claude paused, the carry step carries a review to our checked fix-up and the review step leaves the head alone", async () => {
  const { world } = await import("./world-db.ts");
  const { pauseReason } = await import("../src/runner/autopilot.ts");
  const { runCarry } = await import("../src/review/carry-step.ts");
  const { selectOpusCandidates } = await import("../src/review/opus-candidates.ts");
  const w = await (await world()).repo();
  try {
    const at = "2026-11-04T10:00:00.000Z";
    await (await (await w.pr(1)).review(1, { verdict: "take-fix" })).synced(1, "H");
    await w.db.prepare("UPDATE opus_reviews SET seen_at = ? WHERE repo = 'app' AND number = 1").run(at);
    await w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'sha1', 'H', 'pushed', 1, ?)").run(at);
    await w.db.prepare("INSERT INTO patch_checks (kind, repo, number, subject, patch_hash, round, verdict, reasons, problems, model, created_at) VALUES ('fixup', 'app', 1, 'sha1', 'x', 1, 'approve', '', '[]', 'm', ?)").run(at);
    assert.ok(await pauseReason(w.db, "opus-review"), "models are paused");
    assert.equal(await pauseReason(w.db, "review-carry"), null);
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => a.kind).filter((k) => k === "review" || k === "carry"), ["carry"]);
    assert.deepEqual(await selectOpusCandidates(w.db, "app"), []);
    assert.equal(await runCarry(w.db, "app", () => {}), 1);
    assert.deepEqual(await w.rows("SELECT head_oid, verdict, model FROM opus_reviews WHERE head_oid = 'H'"), [{ head_oid: "H", verdict: "take", model: "carried" }]);
    assert.equal((await w.prPlan(1)).actions.some((a) => a.kind === "carry" || a.kind === "review"), false);
  } finally { w.close(); }
});

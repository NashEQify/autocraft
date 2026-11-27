import { test } from "node:test";
import assert from "node:assert/strict";
import { breakerTripped, classifyPush, requiredResult } from "../src/core/push-outcome.ts";
import { join } from "node:path";
import { tmpdir } from "./world-db.ts";
import { addPushOutcomes, loadPushFacts, loadTrips, pushesUnsettled, resolvePushes, UNSETTLED_PUSHES_MAX } from "../src/data/control/index.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("push outcome: green to red is broke, red to green is fixed, optional checks are ignored", () => {
  const green = [{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }];
  const red = [{ name: "gate", state: "failure" }, { name: "sonar", state: "success" }];
  const optional = ["sonar"];
  assert.equal(requiredResult(green, optional), "green");
  assert.equal(requiredResult(red, optional), "red");
  assert.equal(requiredResult([{ name: "gate", state: "pending" }], optional), "pending");
  assert.equal(classifyPush(requiredResult(green, optional), requiredResult(red, optional)), "broke");
  assert.equal(classifyPush(requiredResult(red, optional), requiredResult(green, optional)), "fixed");
  assert.equal(classifyPush("red", "red"), "still-red");
  assert.equal(classifyPush("green", "green"), "kept-green");
  assert.equal(classifyPush("unknown", "red"), "unknown");
  assert.equal(classifyPush("green", "pending"), null);
  assert.equal(classifyPush("green", "none"), null, "no required check yet is not final");
  // A red optional check alone is no break.
  assert.equal(classifyPush("green", requiredResult([{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }], optional)), "kept-green");
  assert.equal(breakerTripped(["broke", "fixed", null, "broke"]), true);
  assert.equal(breakerTripped(["broke", ...Array(9).fill("fixed"), "broke"]), false);
});

test("a new branch takes the CI result of the newest default-branch head with a final result", async () => {
  const db = await connectDb(join(tmpdir("push-base"), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "o/r", added_by: "op", added_at: "2026-11-01T00:00:00Z" }));
  const ci = async (sha: string, state: string, at: string) => await db.run(db.k.insertInto("main_ci").values({ repo: "o/r", head_sha: sha, branch: "main", state, failing: "[]", checks: "[]", committed_at: at, first_seen_at: at, state_changed_at: at, updated_at: at }));
  await ci("base", "red", "2026-11-01T00:00:00Z");
  await ci("latest", "green", "2026-11-02T00:00:00Z");
  const before = async () => (await db.get(db.k.selectFrom("push_outcomes").select("before_res").orderBy("id", "desc").limit(1)))!.before_res;
  await addPushOutcomes(db, [{ action: "implement-push", repo: "o/r", number: null, from: null, to: "c1", base: "base" }]);
  assert.equal(await before(), "green", "the new PR's run merges with the newest head");
  await ci("newest", "running", "2026-11-03T00:00:00Z");
  await addPushOutcomes(db, [{ action: "implement-push", repo: "o/r", number: null, from: null, to: "c2", base: "base" }]);
  assert.equal(await before(), "green", "CI still running on the newest head: the newest head with a final result");
  const rows = [{ repo: "o/r", number: 5, head_oid: "c2", checks: JSON.stringify([{ name: "gate", state: "failure" }]) }];
  await resolvePushes(db, rows);
  assert.equal((await db.get(db.k.selectFrom("push_outcomes").select("outcome").where("to_oid", "=", "c2")))!.outcome, "broke");
});

test("the unsettled-push gate counts only recent pushes whose PR is open at the pushed head", async () => {
  const db = await connectDb(join(tmpdir("push-gate"), "t.db"));
  const now = new Date("2026-11-07T12:00:00Z");
  const item = async (n: number, state: string, head: string) => await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state, title: "t", author: "a", head_oid: head, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }));
  const push = async (n: number | null, to: string, at: string) => await db.run(db.k.insertInto("push_outcomes").values({ at, stage: "fixup", action: "fixup-push", repo: "app", number: n, from_oid: "old", to_oid: to, before_res: "green" }));
  const checks = async (n: number, head: string) => await db.run(db.k.insertInto("pr_checks").values({ repo: "app", number: n, head_oid: head, overall: "pending", checks: JSON.stringify([{ name: "gate", state: "pending" }]), fetched_at: "2026-11-07T11:50:00Z" }));
  // Orphans: PR merged, head moved on, no number.
  await item(1, "MERGED", "h1"); await push(1, "h1", "2026-11-07T11:30:00Z");
  await item(2, "OPEN", "other"); await push(2, "h2", "2026-11-07T11:30:00Z");
  await push(null, "h3", "2026-11-07T11:30:00Z");
  for (const n of [4, 5, 6]) { await item(n, "OPEN", `h${n}`); await checks(n, `h${n}`); }
  await push(4, "h4", "2026-11-07T11:30:00Z"); await push(5, "h5", "2026-11-07T11:30:00Z");
  const unsettled = async (at: Date): Promise<boolean> => ((await pushesUnsettled(db, ["app"], at.getTime())).get("app") ?? 0) >= UNSETTLED_PUSHES_MAX;
  assert.equal(await unsettled(now), false);
  await push(6, "h6", "2026-11-07T11:40:00Z");
  assert.equal(await unsettled(now), true);
  assert.equal(await unsettled(new Date("2026-11-07T14:00:00Z")), false, "pushes older than 2 hours no longer count");
});

test("a push whose green before predates a move of the default branch is stale and trips nothing; a fresh green that turns red still counts", async () => {
  const db = await connectDb(join(tmpdir("push-stale"), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "o/r", added_by: "op", added_at: "2026-11-01T00:00:00Z" }));
  // Commit times come from GitHub as written, here with an offset: 2026-11-10T00:00Z.
  const main = "2026-11-10T02:00:00+02:00";
  await db.run(db.k.insertInto("main_ci").values({ repo: "o/r", head_sha: "m2", branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: main, first_seen_at: main, state_changed_at: main, updated_at: main }));
  const green = JSON.stringify([{ name: "gate", state: "success" }]), red = JSON.stringify([{ name: "gate", state: "failure" }]);
  const pr = async (n: number, committedAt: string, firstSeen = committedAt) => {
    await db.run(db.k.insertInto("pr_checks").values({ repo: "o/r", number: n, head_oid: `a${n}`, overall: "success", checks: green, fetched_at: "2026-11-12T00:00:00Z" }));
    await db.run(db.k.insertInto("pr_commits").values({ repo: "o/r", number: n, oid: `a${n}`, committed_at: committedAt, first_seen_at: firstSeen }));
  };
  const push = async (ns: number[]) => {
    await addPushOutcomes(db, ns.map((n) => ({ action: "fixup-push", repo: "o/r", number: n, from: `a${n}`, to: `b${n}` })));
    await resolvePushes(db, ns.map((n) => ({ repo: "o/r", number: n, head_oid: `b${n}`, checks: red })), "2026-11-12T01:00:00Z");
  };
  // Green on runs older than the default branch head: the red after the push may come from the base.
  await pr(2, "2026-11-05T00:00:00Z"); await pr(3, "2026-11-06T00:00:00Z");
  await push([2, 3]);
  const outcomes = async () => (await db.all(db.k.selectFrom("push_outcomes").select(["number", "outcome"]).orderBy("number"))).map((r) => `${r.number}:${r.outcome}`);
  assert.deepEqual(await outcomes(), ["2:stale", "3:stale"]);
  assert.equal((await loadTrips(db)).has("fixup:o/r"), false);
  assert.equal((await loadPushFacts(db, [{ repo: "o/r", number: 2 }])).get("o/r#2")?.brokeHead, "b2", "the CI fix still repairs that head");
  // Fresh greens: a head we pushed just after the base moved (dated by our push, its commit is older; by time, not by text), and
  // a contributor's commit made before the move but pushed after it (dated by when the sync first saw it).
  await pr(4, "2026-11-01T00:00:00Z");
  await db.run(db.k.insertInto("own_pushes").values({ repo: "o/r", number: 4, from_oid: "a0", to_oid: "a4", action: "fixup-push", at: "2026-11-10T00:00:00.500Z", landed_at: "2026-11-10T00:00:01.000Z" }));
  await pr(5, "2026-11-05T00:00:00Z", "2026-11-11T00:00:00Z");
  await push([4, 5]);
  assert.deepEqual((await outcomes()).slice(2), ["4:broke", "5:broke"]);
  // A head whose time is not known yet: the green counts.
  await pr(6, "2026-11-01T00:00:00Z");
  await db.run(db.k.deleteFrom("pr_commits").where("number", "=", 6));
  await push([6]);
  assert.deepEqual((await outcomes()).slice(4), ["6:broke"]);
  assert.ok((await loadTrips(db)).has("fixup:o/r"), "two broken pushes trip the repo's breaker; the stale ones take no place in its window");
});

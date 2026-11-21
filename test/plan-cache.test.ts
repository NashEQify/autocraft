// The planner's Plan cache (item_plans) and what a pass writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { planHistory, prunePlanHistory, refreshPlanCache } from "../src/core/plan-cache.ts";
import { detectAutopilot, planDue, setEnabled } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";
import { mapSeq } from "../src/async-seq.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-cache-"));
const T0 = "2026-01-01T00:00:00Z";

describe("Plan cache", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
  const add = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', 't', 'b', 0, '${T0}', '${T0}')`);
  await add.run(1); await add.run(2);
  await db.script("UPDATE items SET embed_hash = NULL");
  await setEnabled(db, true, "op");
  const cache = async () => await db.prepare("SELECT number, kind, state, actions FROM item_plans ORDER BY number").all() as { number: number; kind: string; state: string; actions: string }[];
  const seq = async () => (await db.prepare("SELECT seq FROM change_seq WHERE topic = 'plans'").get() as { seq: number }).seq;

  test("a pass writes one row per item, writes nothing else, and writes only changed rows the next time", async () => {
    const changes = async () => (await db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE embed_hash IS NULL").get() as { n: number };
    const first = await detectAutopilot(db);
    assert.equal(first.timing!.written, 2);
    assert.deepEqual((await cache()).map((r) => [r.number, r.kind]), [[1, "issue"], [2, "issue"]]);
    assert.ok(JSON.parse((await cache())[0]!.actions).some((a: { kind: string }) => a.kind === "embed"), "the embed action is cached");
    assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM items WHERE embed_hash IS NULL").get(), before, "planning fills no hashes");
    const s = await seq();
    const n = await changes();
    const second = await detectAutopilot(db);
    assert.deepEqual([second.timing!.written, second.timing!.deleted], [0, 0]);
    assert.equal(await changes(), n, "an unchanged pass writes nothing");
    assert.equal(await seq(), s);
  });

  test("a changed item rewrites its row only, and an item that closed leaves the cache", async () => {
    await db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 2").run();
    const r = await detectAutopilot(db);
    assert.deepEqual([r.timing!.written, r.timing!.deleted], [0, 1]);
    assert.deepEqual((await cache()).map((x) => x.number), [1]);
  });

  test("with the pipeline off the planner is still due and caches the Plans (the runner queues no proposal then)", async () => {
    await setEnabled(db, false, "op");
    await db.prepare("UPDATE items SET state = 'OPEN' WHERE number = 2").run();
    assert.equal(await planDue(db), true);
    const r = await detectAutopilot(db);
    assert.ok(r.proposals.every((p) => p.lane), "proposals are only data; applyProposals is not called while off");
    assert.equal(r.timing!.written, 1);
    assert.deepEqual((await cache()).map((x) => x.number), [1, 2]);
  });

  test("with the pipeline off a wake time that has passed makes one pass due, not every tick", async () => {
    await setEnabled(db, false, "op");
    await planDue(db);
    await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_wake_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(new Date(Date.now() - 60_000).toISOString());
    assert.equal(await planDue(db), true);
    assert.equal(await planDue(db), false);
  });

  test("the history gets a row for each change of an item's state, none for a pass that changes nothing else", async () => {
    const before = (await planHistory(db, "app", 1)).length;
    await refreshPlanCache(db);
    assert.equal((await planHistory(db, "app", 1)).length, before, "an unchanged pass adds no row");
    await db.prepare("UPDATE item_plans SET state = 'earlier' WHERE number = 1").run();
    await refreshPlanCache(db);
    await db.prepare("UPDATE item_plans SET state = 'before-that', wait = 'x' WHERE number = 1").run();
    await refreshPlanCache(db);
    const h = await planHistory(db, "app", 1);
    assert.deepEqual(h.slice(before).map((r) => [r.oldState, r.wait === null]), [["earlier", true], ["before-that", true]]);
    await db.prepare("UPDATE item_plans SET wait = 'y' WHERE number = 1").run();
    await refreshPlanCache(db);
    const w = (await planHistory(db, "app", 1)).at(-1)!;
    assert.deepEqual([w.oldWait, w.wait === null], ["y", true], "a wait-only change is recorded with the old wait");
    await db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 2").run();
    await refreshPlanCache(db);
    const gone = (await planHistory(db, "app", 2)).at(-1)!;
    await db.prepare("UPDATE items SET state = 'OPEN' WHERE number = 2").run();
    await refreshPlanCache(db);
    assert.deepEqual([gone.newState, gone.oldState === null], ["gone", false], "an item leaving the plan set gets a row");
    assert.equal(h[h.length - 1]!.newState, (await cache())[0]!.state);
    assert.equal(h[0]!.oldState, null, "the first plan has no old state");
    assert.ok(await prunePlanHistory(db, 0, Date.now() + 1000) >= h.length);
    assert.equal((await planHistory(db, "app", 1)).length, 0);
  });
});

describe("the cached next step of a PR outside the pipeline's scope", () => {
  test("names the step its stored rows wait on, not Review", async () => {
    const db = await connectDb(join(dir, "scope.db"));
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('off', 0)").run();
    const pr = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, head_oid, created_at, updated_at) VALUES ('off', ?, 'pr', 'OPEN', 't', 'b', 0, ?, '${T0}', '${T0}')`);
    const jev = async (number: number) => await db.run(db.k.insertInto("classifications")
      .values({ repo: "off", number, classifier: "jev", run_id: "r1", at: T0, type_label: "bugfix", flags: "[]", probs: '{"top":0.95}' }));
    const review = db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, sure, mode) VALUES ('off', ?, ?, 'rv', '${T0}', 'sonnet', ?, 'why', 1, 'full')`);
    for (const [n, verdict] of [[1, "hold"], [2, "take-fix"], [3, "take"]] as const) { await pr.run(n, `h${n}`); await jev(n); await review.run(n, `h${n}`, verdict); }
    await pr.run(4, "h4"); await jev(4);
    await db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('off', 3, 'h3', 'tests', 'r', 'passed', '${T0}')`).run();
    await refreshPlanCache(db);
    const next = async (n: number) => JSON.parse((await db.prepare("SELECT view FROM item_plans WHERE repo = 'off' AND number = ?").get(n) as { view: string }).view).next;
    assert.deepEqual(await mapSeq([1, 2, 3, 4], next), ["Needs a person", "Fix-up", "Merge queue", "Review"]);
    assert.equal((await db.prepare("SELECT state FROM item_plans WHERE number = 3").get() as { state: string }).state, "out-of-scope");
  });
});

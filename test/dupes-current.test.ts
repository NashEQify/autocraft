import { test } from "node:test";
import assert from "node:assert/strict";
import { currentComparison, kindSetsOf, saveComparison, type StoredComparison } from "../src/dupes/plan.ts";
import { T0, world } from "./world-db.ts";

test("a duplicate comparison survives head pushes and small diff changes, and is redone for a state change or a diff that moved over 20%", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  const group = { repo: "app", canonical: 1, why: "", members: [1, 2], edges: [] };
  const set = async () => (await kindSetsOf(w.db, group))[0]!;
  const s0 = await set();
  const cmp: StoredComparison = { repo: "app", key: s0.key, kind: "pr", members: [1, 2], hash: s0.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0 };
  await saveComparison(w.db, cmp);
  assert.ok(await currentComparison(w.db, await set()));
  await w.db.prepare("UPDATE items SET head_oid = 'newhead', title = 'edited', body = 'edited', additions = 115 WHERE repo = 'app' AND number = 2").run();
  assert.ok(await currentComparison(w.db, await set()), "a push with a 15% size change keeps the result");
  await w.db.prepare("UPDATE items SET additions = 130 WHERE repo = 'app' AND number = 2").run();
  assert.equal(await currentComparison(w.db, await set()), null, "a 30% size change makes it stale");
  await w.db.prepare("UPDATE items SET additions = 100 WHERE repo = 'app' AND number = 2").run();
  assert.ok(await currentComparison(w.db, await set()));
  await w.db.prepare("UPDATE items SET state = 'MERGED' WHERE repo = 'app' AND number = 2").run();
  assert.equal(await currentComparison(w.db, await set()), null, "a state change makes it stale");
  await w.db.prepare("UPDATE items SET state = 'OPEN' WHERE repo = 'app' AND number = 2").run();
  await w.db.prepare("UPDATE items SET closing_issues = '[34]' WHERE repo = 'app' AND number = 2").run();
  assert.equal(await currentComparison(w.db, await set()), null, "a changed closing-issue link makes it stale");
});

test("the stored sizes are those of the compared snapshot, and a size unknown then makes the result stale once known", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  await w.db.prepare("UPDATE items SET additions = NULL WHERE repo = 'app' AND number = 2").run();
  const group = { repo: "app", canonical: 1, why: "", members: [1, 2], edges: [] };
  const set = async () => (await kindSetsOf(w.db, group))[0]!;
  const snap = await set();
  await w.db.prepare("UPDATE items SET additions = 500 WHERE repo = 'app' AND number = 1").run();
  await saveComparison(w.db, { repo: "app", key: snap.key, kind: "pr", members: [1, 2], hash: snap.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0 }, snap);
  assert.equal(await currentComparison(w.db, await set()), null, "PR 1 grew after the snapshot");
  await w.db.prepare("UPDATE items SET additions = 100 WHERE repo = 'app' AND number = 1").run();
  assert.ok(await currentComparison(w.db, await set()));
  await w.db.prepare("UPDATE items SET additions = 100 WHERE repo = 'app' AND number = 2").run();
  assert.equal(await currentComparison(w.db, await set()), null, "PR 2's size became known");
});

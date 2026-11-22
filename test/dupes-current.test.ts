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
  await w.db.run(w.db.k.updateTable("items").set({ head_oid: "newhead", title: "edited", body: "edited", additions: 115 }).where("repo", "=", "app").where("number", "=", 2));
  assert.ok(await currentComparison(w.db, await set()), "a push with a 15% size change keeps the result");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 130 }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await currentComparison(w.db, await set()), null, "a 30% size change makes it stale");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 2));
  assert.ok(await currentComparison(w.db, await set()));
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED" }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await currentComparison(w.db, await set()), null, "a state change makes it stale");
  await w.db.run(w.db.k.updateTable("items").set({ state: "OPEN" }).where("repo", "=", "app").where("number", "=", 2));
  await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[34]" }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await currentComparison(w.db, await set()), null, "a changed closing-issue link makes it stale");
});

test("the stored sizes are those of the compared snapshot, and a size unknown then makes the result stale once known", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  await w.db.run(w.db.k.updateTable("items").set({ additions: null }).where("repo", "=", "app").where("number", "=", 2));
  const group = { repo: "app", canonical: 1, why: "", members: [1, 2], edges: [] };
  const set = async () => (await kindSetsOf(w.db, group))[0]!;
  const snap = await set();
  await w.db.run(w.db.k.updateTable("items").set({ additions: 500 }).where("repo", "=", "app").where("number", "=", 1));
  await saveComparison(w.db, { repo: "app", key: snap.key, kind: "pr", members: [1, 2], hash: snap.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0 }, snap);
  assert.equal(await currentComparison(w.db, await set()), null, "PR 1 grew after the snapshot");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 1));
  assert.ok(await currentComparison(w.db, await set()));
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await currentComparison(w.db, await set()), null, "PR 2's size became known");
});

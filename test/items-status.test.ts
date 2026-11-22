import { test } from "node:test";
import assert from "node:assert/strict";
import { listItems, statusList } from "../src/dash/api/items.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";

test("the status list counts every phase, filters by one, and gives an item without a plan its own status", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values([
    { repo: "app", number: 1, kind: "pr", state: "OPEN", title: "Planned", updated_at: "2026-01-03", merged_at: null },
    { repo: "app", number: 2, kind: "issue", state: "OPEN", title: "No plan", updated_at: "2026-01-02", merged_at: null },
    { repo: "app", number: 3, kind: "pr", state: "MERGED", title: "Done", updated_at: "2026-01-01", merged_at: "2026-01-01" },
  ]));
  await db.run(db.k.insertInto("item_plans").values({
    repo: "app", number: 1, kind: "pr", state: "needs-fix-up", actions: "[]", reasons: "[]", planned_at: "x",
    view: JSON.stringify({ status: { phase: "Fixing", waiting: null, next: "Fix-up", since: "2026-01-03" } }),
  }));
  const req = (q: string) => ({ query: new URLSearchParams(q), user: { role: "operator", login: "o", canRead: async () => true } }) as unknown as Req;
  const all = await statusList(db, req(""));
  assert.equal(all.total, 3);
  assert.deepEqual(all.rows.map((r) => r.status.phase), ["Fixing", "Triage", "Merged"]);
  const fixing = await statusList(db, req("phase=Fixing"));
  assert.deepEqual(fixing.rows.map((r) => r.number), [1]);
  assert.equal(fixing.total, 3);
  assert.equal(fixing.byPhase.Triage, 1);
  const page = await statusList(db, req("limit=2"));
  assert.equal(page.rows.length, 2);
  assert.deepEqual((await statusList(db, req(`limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`))).rows.map((r) => r.number), [3]);
});

test("the item list shows a verdict written after an earlier list, and a failed request changes nothing", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN", title: "Fix", updated_at: "2026-01-03" }));
  await db.run(db.k.insertInto("classifications").values({ repo: "app", number: 1, classifier: "jev", run_id: "r1", at: "2026-01-03", type_label: "bugfix", flags: "[]", probs: '{"top":0.95}' }));
  const req = (q: string) => ({ query: new URLSearchParams(q), user: { role: "operator", login: "o", canRead: async () => true } }) as unknown as Req;
  await assert.rejects(listItems(db, req("kind=bogus")));
  const list = await listItems(db, req(""));
  assert.equal(list.rows[0]?.settled.jevLabel, "bugfix");
  await db.run(db.k.updateTable("classifications").set({ type_label: "feature", probs: '{"top":0.97}' }).where("repo", "=", "app").where("number", "=", 1));
  assert.equal((await listItems(db, req(""))).rows[0]?.settled.jevLabel, "feature");
});

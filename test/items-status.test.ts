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

test("the item list filters by area, `none` takes the items without one, and grouping puts each area together with the unassigned last", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await db.run(db.k.insertInto("items").values([1, 2, 3, 4].map((n) => ({ repo: "app", number: n, kind: "issue", state: "OPEN", title: `Item ${n}`, updated_at: `2026-01-0${n}` }))));
  const at = (number: number, area: string | null) => ({ repo: "app", number, area, source: "jev", confidence: 0.95, list_version: 1, at: "2026-01-05" });
  await db.run(db.k.insertInto("item_areas").values([at(1, "Text"), at(2, "Canvas"), at(3, null), at(4, "Text")]));
  const req = (q: string) => ({ query: new URLSearchParams(q), user: { role: "operator", login: "o", canRead: async () => true } }) as unknown as Req;
  const numbers = async (q: string) => (await listItems(db, req(q))).rows.map((r) => r.number);
  assert.deepEqual(await numbers("area=Text"), [4, 1]);
  assert.deepEqual(await numbers("area=none"), [3]);
  assert.deepEqual(await numbers("area=Canvas,none"), [3, 2]);
  const grouped = await listItems(db, req("group=area"));
  assert.deepEqual(grouped.rows.map((r) => r.area ?? null), ["Canvas", "Text", "Text", null]);
  assert.deepEqual(Object.fromEntries(grouped.byArea!.map((g) => [g.area ?? "-", g.items])), { Canvas: 1, Text: 2, "-": 1 });
  assert.deepEqual((await statusList(db, req("area=Text"))).rows.map((r) => r.number), [4, 1]);
});

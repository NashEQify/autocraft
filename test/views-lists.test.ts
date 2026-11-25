// The list views behind Home, Items, Repos, Stats and the top-bar search (src/data/views): filters, hidden repos and counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { loadMaintainRepos } from "../src/data/views/maintain.ts";
import { loadItemsBase } from "../src/data/views/maintain-items.ts";
import { loadMaintainStats } from "../src/data/views/stats.ts";
import { loadQuickSearch } from "../src/data/views/items.ts";
import { visibleNames } from "../src/data/views/visibility.ts";

const NOW = "2026-11-10T12:00:00.000Z";

test("the lists leave out repos the viewer may not see, filter by hold and count closed items", async () => {
  const db = await connectDb(":memory:");
  try {
    for (const name of ["app", "secret"]) await db.run(db.k.insertInto("tracked_repos").values({ name, pipeline: 1 }));
    const item = (repo: string, number: number, state: string, o: Record<string, unknown> = {}) => ({ repo, number, kind: "issue", state, title: `t${number}`, author: "ann", updated_at: NOW, ...o });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1, "OPEN"), item("app", 2, "OPEN"), item("app", 3, "CLOSED", { closed_at: NOW }), item("app", 4, "MERGED", { kind: "pr", closed_at: NOW, merged_at: NOW }),
      item("secret", 1, "OPEN"),
    ]));
    await db.run(db.k.insertInto("main.outside_holds").values({ repo: "app", number: 2, author: "eve", kind: "issue", reason: "limit" }));
    const scope = { repos: ["app"], hidden: Object.assign(["secret"], { visible: ["app"] }) };
    const f = { show: "open" as const, filters: [], areas: [], text: null, refs: [], limit: 50 };

    assert.deepEqual((await loadItemsBase(db, scope, f)).rows.map((r) => r.number).sort(), [1, 2]);
    assert.deepEqual((await loadItemsBase(db, scope, { ...f, filters: ["outside"] })).rows.map((r) => r.number), [2]);
    const closed = await loadItemsBase(db, scope, { ...f, show: "closed", limit: 1 });
    assert.equal(closed.rows.length, 1);
    assert.equal(closed.closedTotal, 2);

    const repos = await loadMaintainRepos(db, { allRepos: ["app"] }, { nowMs: Date.parse(NOW) + 1000 });
    assert.deepEqual([...repos.open], [["app", 2]]);
    assert.deepEqual([...repos.mergedWeek], [["app", 1]]);

    const stats = await loadMaintainStats(db, scope, { days: 7, today: NOW.slice(0, 10) });
    assert.equal(stats.backlog, 2);
    assert.equal(stats.closed.reduce((n, r) => n + r.n, 0), 2);

    assert.deepEqual((await loadQuickSearch(db, scope, "#1", { limit: 20 })).map((r) => r.repo), ["app"]);
    assert.deepEqual((await loadQuickSearch(db, scope, "ann", { limit: 20 })).map((r) => r.repo).sort(), ["app", "app", "app", "app"]);
  } finally {
    await db.close?.();
  }
});

test("a viewer sees public repos and those with a cached permission; an operator sees every tracked repo", () => {
  const repo = (name: string, visibility: string) => ({ name, visibility }) as never;
  const inputs = {
    tracked: new Map([["a", { name: "a" }], ["b", { name: "b" }], ["c", { name: "c" }]]) as never,
    everTracked: new Set<string>(), repos: new Map([["a", repo("a", "public")], ["b", repo("b", "private")], ["c", repo("c", "private")]]),
  };
  assert.deepEqual(visibleNames(inputs, "viewer", new Map([["c", "read" as const]])), ["a", "c"]);
  assert.deepEqual(visibleNames(inputs, "operator", new Map()), ["a", "b", "c"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { settledLookup, settledSet, settledTable } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb, dbFor } from "../src/db/open.ts";

const RUN = "r1";

async function seed(db: Db): Promise<void> {
  const cls = (repo: string, number: number, classifier: string, run_id: string, at: string, type_label: string, probs: string | null, flags = "[]", reason: string | null = null, input_hash: string | null = null) =>
    db.run(db.k.insertInto("main.classifications").values({ repo, number, classifier, run_id, at, type_label, flags, probs, reason, input_hash }));
  await cls("app", 1, "jev", RUN, "2026-01-01", "bugfix", '{"top":0.95}');
  await cls("app", 2, "jev", RUN, "2026-01-01", "feature", '{"top":0.6}');
  await cls("app", 2, "haiku", RUN, "2026-01-02", "feature", null);
  await cls("app", 3, "jev", RUN, "2026-01-01", "feature", '{"top":0.5,"security":0.95}');
  await cls("app", 3, "haiku", RUN, "2026-01-02", "bugfix", null, '["security"]');
  await cls("app", 3, "sonnet", RUN, "2026-01-03", "bugfix", '{"sure":true}', "[]", "a fix");
  await cls("app", 4, "haiku", RUN, "2026-01-02", "docs", null, "[]", null, "h");
  await cls("app", 5, "jev", "old", "2026-01-01", "docs", '{"top":0.99}');
}

const rows = async (db: Db) => await db.all(db.k.selectFrom("item_settled")
  .select(["repo", "number", "status", "label", "source", "top", "jev_label", "haiku_label", "flags", "security", "needs_decision", "referee_label", "referee_sure", "referee_reason", "referee_final"])
  .where("run", "=", RUN).orderBy("repo").orderBy("number"));

/** item_settled after a first build and after changes, checked against the per-item rule. */
async function states(db: Db): Promise<unknown[]> {
  await seed(db);
  await settledTable(db, RUN);
  const first = await rows(db);
  await db.run(db.k.deleteFrom("main.classifications").where("repo", "=", "app").where("number", "=", 2).where("classifier", "=", "haiku"));
  await db.run(db.k.updateTable("main.classifications").set({ probs: '{"top":0.4}' }).where("repo", "=", "app").where("number", "=", 1));
  const jev = (number: number, run_id: string) => ({ repo: "app", number, classifier: "jev", run_id, at: "2026-01-04", type_label: "bugfix", flags: "[]", probs: '{"top":0.92}' });
  await db.run(db.k.insertInto("main.classifications").values([jev(6, RUN), jev(7, "old")]));
  await settledTable(db, RUN);
  const second = await rows(db);
  const one = settledLookup(db, RUN);
  const all = await settledSet(db, RUN);
  const some = await settledSet(db, RUN, ["app#3"]);
  assert.deepEqual(await some("app", 3), await one("app", 3));
  assert.equal((await some("app", 1)).status, "unclassified", "an item outside refs reads as unclassified");
  for (const r of second as { repo: string; number: number; status: string; label: string | null }[]) {
    const s = await one(r.repo, r.number);
    assert.deepEqual([r.status, r.label], [s.status, s.label], `${r.repo}#${r.number} as the per-item rule settles it`);
    assert.deepEqual(await all(r.repo, r.number), s, `${r.repo}#${r.number} read in one query`);
  }
  return [first, second];
}

test("item_settled follows verdict changes and holds the same rows on SQLite and on the suite's database", async () => {
  const sqlite = await dbFor(connect(":memory:"));
  // On the Postgres suite this opens Postgres; otherwise a second SQLite database.
  const other = await connectDb(":memory:");
  try {
    const [a, b] = [await states(sqlite), await states(other)];
    const [first, second] = a as { number: number; status: string }[][];
    assert.deepEqual(first!.map((r) => r.number), [1, 2, 3, 4]);
    assert.ok(second!.some((r) => r.number === 6), "a new verdict gets a row");
    assert.equal(second!.find((r) => r.number === 2)?.status, "waiting", "a deleted second opinion takes the item back to waiting");
    assert.deepEqual(b, a);
  } finally {
    await sqlite.close();
    await other.close();
  }
});

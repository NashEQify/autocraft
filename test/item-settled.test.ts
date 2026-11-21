import { test } from "node:test";
import assert from "node:assert/strict";
import { settledLookup, settledTable } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb, dbFor } from "../src/db/open.ts";

const RUN = "r1";

async function seed(db: Db): Promise<void> {
  const cls = db.prepare("INSERT INTO main.classifications (repo, number, classifier, run_id, at, type_label, flags, probs, reason, input_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  await cls.run("app", 1, "jev", RUN, "2026-01-01", "bugfix", "[]", '{"top":0.95}', null, null);
  await cls.run("app", 2, "jev", RUN, "2026-01-01", "feature", "[]", '{"top":0.6}', null, null);
  await cls.run("app", 2, "haiku", RUN, "2026-01-02", "feature", "[]", null, null, null);
  await cls.run("app", 3, "jev", RUN, "2026-01-01", "feature", "[]", '{"top":0.5,"security":0.95}', null, null);
  await cls.run("app", 3, "haiku", RUN, "2026-01-02", "bugfix", '["security"]', null, null, null);
  await cls.run("app", 3, "sonnet", RUN, "2026-01-03", "bugfix", "[]", '{"sure":true}', "a fix", null);
  await cls.run("app", 4, "haiku", RUN, "2026-01-02", "docs", "[]", null, null, "h");
  await cls.run("app", 5, "jev", "old", "2026-01-01", "docs", "[]", '{"top":0.99}', null, null);
}

const rows = async (db: Db) => await db.prepare("SELECT repo, number, status, label, source, top, jev_label, haiku_label, flags, security, needs_decision, referee_label, referee_sure, referee_reason, referee_final FROM item_settled WHERE run = ? ORDER BY repo, number").all(RUN);

/** item_settled after a first build and after changes, checked against the per-item rule. */
async function states(db: Db): Promise<unknown[]> {
  await seed(db);
  await settledTable(db, RUN);
  const first = await rows(db);
  await db.prepare("DELETE FROM main.classifications WHERE repo = 'app' AND number = 2 AND classifier = 'haiku'").run();
  await db.prepare(`UPDATE main.classifications SET probs = '{"top":0.4}' WHERE repo = 'app' AND number = 1`).run();
  await db.prepare("INSERT INTO main.classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 6, 'jev', ?, '2026-01-04', 'bugfix', '[]', '{\"top\":0.92}')").run(RUN);
  await db.prepare("INSERT INTO main.classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 7, 'jev', 'old', '2026-01-04', 'bugfix', '[]', '{\"top\":0.92}')").run();
  await settledTable(db, RUN);
  const second = await rows(db);
  const one = settledLookup(db, RUN);
  for (const r of second as { repo: string; number: number; status: string; label: string | null }[]) {
    const s = await one(r.repo, r.number);
    assert.deepEqual([r.status, r.label], [s.status, s.label], `${r.repo}#${r.number} as the per-item rule settles it`);
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

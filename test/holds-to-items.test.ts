// The once-only move of merge holds to held items, on each engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connect } from "../src/db.ts";
import { HOLDS_TO_ITEMS_DONE, holdsToItemsPg, holdsToItemsSqlite } from "../src/db/holds-to-items.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const T = "2026-11-20T10:00:00.000Z", AT = "2026-11-25T12:00:00.000Z";
const REC = { text: "Fix it.", parts: { fix: [1], drop: [] }, merges: true };
type Run = (sql: string) => Promise<Record<string, unknown>[]>;

/** Holds on: 1 a running PR, 2 a blocked one, 3 one nobody started, 4 one in the backlog, 5 a merged one, 6 the PR of issue 7's work. */
async function move(run: Run, convert: () => Promise<void>): Promise<void> {
  // Opening the database ran it on the empty table.
  await run(`DELETE FROM settings WHERE key = '${HOLDS_TO_ITEMS_DONE}'`);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await run(`INSERT INTO items (repo, number, kind, state, title, head_oid, updated_at) VALUES ('app', ${n}, 'pr', '${n === 5 ? "MERGED" : "OPEN"}', 'x', 'sha${n}', '${T}')`);
    await run(`INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', ${n}, 'ann', '${T}')`);
  }
  const wf = (n: number, kind: string, entry: string, state: string, more = "NULL, NULL, NULL, NULL") =>
    run(`INSERT INTO item_workflows (repo, number, kind, entry, state, started_by, started_at, started_via, updated_at, approved_by, rec, blocker, blocker_params, pr_number) VALUES ('app', ${n}, '${kind}', '${entry}', '${state}', 'mira', '${T}', 'github', '${T}', 'mira', ${more})`);
  await wf(1, "pr", "merge", "running");
  await wf(2, "pr", "fixup", "blocked", `'${JSON.stringify(REC)}', 'large-fix', '{"lines":900}', NULL`);
  await wf(4, "pr", "review", "backlog");
  await wf(7, "issue", "implement", "running", "NULL, NULL, NULL, 6");
  const read = async () => (await run("SELECT number, state, stopped_by, blocker, rec, blocker_params, started_by FROM item_workflows ORDER BY number"))
    .map((r) => [Number(r.number), r.state, r.stopped_by, r.blocker, r.rec, JSON.parse((r.blocker_params as string | null) ?? "null"), r.started_by]);
  await convert();
  const after = await read();
  assert.deepEqual(after, [
    [1, "stopped", "ann", null, null, { held: {} }, "mira"],
    [2, "stopped", "ann", null, null, { held: { rec: REC, blocker: "large-fix", params: { lines: 900 } } }, "mira"],
    [3, "stopped", "ann", null, null, { held: { unstarted: true } }, "ann"],
    [4, "backlog", null, null, null, null, "mira"],
    [7, "stopped", "ann", null, null, { held: {} }, "mira"],
  ]);
  assert.deepEqual(await run("SELECT number FROM merge_holds"), []);
  // Once only.
  await run(`INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 4, 'ann', '${T}')`);
  await convert();
  assert.deepEqual(await read(), after);
}

/** Without the table, as a later release leaves the database: nothing is converted, and nothing says it was. */
async function missing(run: Run, convert: () => Promise<void>): Promise<void> {
  await run(`DELETE FROM settings WHERE key = '${HOLDS_TO_ITEMS_DONE}'`);
  await run("DROP TABLE merge_holds");
  await convert();
  assert.deepEqual(await run(`SELECT key FROM settings WHERE key = '${HOLDS_TO_ITEMS_DONE}'`), []);
  assert.deepEqual(await run("SELECT number FROM item_workflows"), []);
}

for (const [name, check] of [["merge holds become held items once", move], ["a database without merge holds is left as it is", missing]] as const) {
  test(`${name} (sqlite)`, async () => {
    const db = connect(":memory:");
    await check(async (sql) => (/^SELECT/.test(sql) ? db.prepare(sql).all() as Record<string, unknown>[] : (db.exec(sql), [])), async () => holdsToItemsSqlite(db, AT));
  });

  test(`${name} (postgres)`, { skip: needsPg }, async () => {
    const t = await testDatabase("", "postgres");
    await t.open({ app: true });
    const client = new pg.Client({ connectionString: t.target });
    await client.connect();
    try {
      await check(async (sql) => (await client.query(sql)).rows as Record<string, unknown>[], () => holdsToItemsPg(client, AT));
    } finally {
      await client.end();
      await t.close();
    }
  });
}

// The planner's change log: which writes re-decide which items, and which force a full pass.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bulkWrites, changeCursor, changesSince, pruneChanges, type ChangeCursor } from "../src/core/plan-changes.ts";
import { PLAN_INPUTS } from "../src/core/plan-inputs.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { inReadSnapshot, planPass } from "../src/core/plan-engine.ts";
import { latestRun } from "../src/classify/settled.ts";
import { setReviewMinInterval } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { everySeq, filterSeq } from "../src/async-seq.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-changes-"));
const T = "2026-01-01T00:00:00Z";

test("writes log the items they re-decide; stamp-only updates log nothing; cross-item and global writes reach every affected item or force a full pass", async () => {
  const db = await connectDb(join(dir, "log.db"));
  const since = async (cursor: ChangeCursor) => { const c = await changesSince(db, cursor); return { ...c, refs: [...c.refs].sort() }; };
  let seq = await changeCursor(db);

  // Item-keyed: the row's own item.
  await db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 7, 1, '{}', ?)").run(T);
  let c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#7"], false]);
  seq = c.cursor;

  // A bookkeeping column alone: nothing.
  await db.prepare("UPDATE item_rank SET computed_at = '2026-01-02T00:00:00Z' WHERE repo = 'app' AND number = 7").run();
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [[], false]);
  assert.deepEqual(c.cursor, seq);

  // A key move logs the old and the new item.
  await db.prepare("UPDATE item_rank SET number = 8 WHERE repo = 'app' AND number = 7").run();
  c = await since(seq);
  assert.deepEqual(c.refs, ["app#7", "app#8"]);
  seq = c.cursor;

  // Cross-item: a batch row reaches its integration PR and every member.
  const batch = Number((await db.prepare(`INSERT INTO merge_batches (repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at)
    VALUES ('app', 'integration-1', 'open', 'b', 'c', 50, ?, ?) RETURNING id`).get(T, T) as { id: number }).id);
  await db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (?, 3, 'h3', 0), (?, 4, 'h4', 1)").run(batch, batch);
  seq = (await since(seq)).cursor;
  await db.prepare("UPDATE merge_batches SET state = 'merged' WHERE id = ?").run(batch);
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#3", "app#4", "app#50"], false]);
  seq = c.cursor;

  // Cross-item without a readable set: a full pass, and later logged items after it still count.
  await db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 9, 'op', ?)").run(T);
  c = await since(seq);
  assert.equal(c.full, true);
  assert.ok(c.cursor.gen > seq.gen);
  // The mark is counted under the trigger that made it, with the generation it made.
  assert.deepEqual({ ...await db.prepare("SELECT n, last_seq FROM plan_full_causes WHERE source = 'plan_fast_track_full_i'").get() }, { n: 1, last_seq: c.cursor.gen });
  seq = c.cursor;

  // Global: a planner input setting forces a full pass; the planner's own bookkeeping setting does not.
  await db.prepare("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(T);
  assert.equal((await since(seq)).full, false);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;

  // A prune deletes what was read; the next write is read after it.
  await pruneChanges(db, seq);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM item_changes").get() as { n: number }).n, 0);
  await db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 11, 'op', ?)").run(T);
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#11"], false]);
  await db.close();
});

test("every table the fact loaders read is classified", { skip: sqliteOnly("reads sqlite_master") }, async () => {
  const db = await connectDb(join(dir, "reads.db"));
  const tables = (await db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string; type: string; sql: string }[]);
  const views = new Map(tables.filter((t) => t.type === "view").map((t) => [t.name, t.sql]));
  // A view stands for the tables its own SQL names.
  const named = (sql: string, out: Set<string>, seen = new Set<string>()): void => {
    for (const t of tables) {
      if (seen.has(t.name) || !new RegExp(`(?<![\\w.'"])(main\\.)?${t.name}(?![\\w'"])`).test(sql)) continue;
      if (views.has(t.name)) named(views.get(t.name)!, out, new Set([...seen, t.name])); else out.add(t.name);
    }
  };
  const read = new Set<string>();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: Db, sql: string, ...rest: unknown[]) {
    named(sql, read);
    return (prepare as (...a: unknown[]) => ReturnType<typeof prepare>).call(this, sql, ...rest);
  } as typeof prepare;
  try { await loadPlanSet(db, { now: Date.parse(T) }); } finally { DatabaseSync.prototype.prepare = prepare; }
  const listed = new Set(PLAN_INPUTS.map((p) => p.table));
  assert.ok(read.size > 20);
  assert.deepEqual([...read].filter((t) => !listed.has(t)).sort(), []);
  // An item input without its own refs is logged by its repo and number columns.
  const cols = async (t: string) => (await db.prepare("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).map((c) => c.name);
  assert.deepEqual((await filterSeq(PLAN_INPUTS, async (p) => p.class === "item" && !p.refs && !await everySeq(["repo", "number"], async (c) => (await cols(p.table)).includes(c)))).map((p) => p.table), []);
  await db.close();
});

test("a PR's facts change with the clock alone no earlier than its refreshAt: a review held on another item stops waiting when the blocker list expires", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { head: "h1" })).pr(2);
  await setReviewMinInterval(w.db, 0, "test");
  await saveOpus(w.db, "rv", { repo: "app", number: 1, head_oid: "h1" }, {
    mode: "full", base: null, model: "m",
    review: { ref: "app#1", verdict: "hold", sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: ["app#2"] },
  });
  await w.synced(1, "h2");
  const at = Date.parse((await w.db.get(w.db.k.selectFrom("opus_reviews").select("at").where("number", "=", 1)))!.at);
  const load = async (now: number) => (await loadPrFacts(w.db, { now, refs: ["app#1"] }))[0]!;
  const f = await load(at + 3600_000);
  assert.equal(f.reviewHold?.kind, "blocked");
  assert.ok(f.refreshAt! > f.now);
  // Up to refreshAt a load gives the same facts at another time; at refreshAt they differ.
  assert.deepEqual({ ...await load(f.refreshAt! - 1), now: f.now }, f);
  const after = await load(f.refreshAt!);
  assert.notEqual(after.reviewHold?.kind, "blocked");
  assert.equal(after.review?.stale, true);
});

test("the incremental pass reloads only logged and due items, and its PlanSet equals a full load after each write", async () => {
  const prev = process.env.AUTOCRAFT_PLAN_SHADOW;
  process.env.AUTOCRAFT_PLAN_SHADOW = "throw";
  try {
    const w = await (await (await (await (await (await (await world()).repo()).pr(1)).pr(2)).issue(3)).review(1)).review(2, { verdict: "take-fix" });
    let now = Date.parse(T) + 3600_000;
    const pass = async () => {
      const p = await inReadSnapshot(w.db, async () => await planPass(w.db, { now, run: await latestRun(w.db), fullEveryMs: 30 * 60_000 }));
      await p.finish();
      return { kind: p.kind, refs: p.refs };
    };
    assert.equal((await pass()).kind, "full:start");
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
    // A new item moves other items' facts (open PRs of an issue, duplicate sets): a full load.
    await w.pr(4);
    assert.equal((await pass()).kind, "full:marker");
    await w.review(4, { verdict: "hold" });
    await w.db.prepare("INSERT INTO comments (id, repo, number, author, body, created_at) VALUES ('c1', 'app', 3, 'someone', 'still broken', ?)").run(T);
    assert.deepEqual(await pass(), { kind: "incremental", refs: 2 });
    await w.db.prepare("UPDATE items SET state = 'CLOSED' WHERE repo = 'app' AND number = 2").run();
    await pass();
    await w.db.prepare("INSERT INTO settings (key, value) VALUES ('plan_shadow', 'on')").run();
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
    now += 31 * 60_000;
    assert.equal((await pass()).kind, "full:floor");
    // The pass's records are not planner inputs.
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
  } finally {
    if (prev === undefined) delete process.env.AUTOCRAFT_PLAN_SHADOW; else process.env.AUTOCRAFT_PLAN_SHADOW = prev;
  }
});

test("a held PR is logged when its blocker closes; a bulk write logs nothing and takes one full mark; malformed rows and a lost marker row fail no write", async () => {
  const db = await connectDb(join(dir, "robust.db"));
  const since = async (cursor: ChangeCursor) => { const c = await changesSince(db, cursor); return { ...c, refs: [...c.refs].sort() }; };
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at) VALUES ('app', ?, 'pr', 'OPEN', 't', ?)");
  for (const n of [1, 2, 3]) await item.run(n, T);
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "h1", at: T, mode: "full", verdict: "hold", blocked_by: '["app#2", 7, "app#2"]' }));
  let seq = await changeCursor(db);
  await db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 2").run();
  let c = await since(seq);
  assert.ok(c.full || c.refs.includes("app#1"), "the PR held for app#2 is decided again");
  seq = c.cursor;

  // A decision whose items are not a list of objects is still written and logs its own item.
  await db.prepare("INSERT INTO decisions (id, kind, repo, number, items, asked_at, asked_by, question, options) VALUES ('d1', 'merge', 'app', 3, '[\"app#1\", 5]', ?, 'x', 'q', '[]')").run(T);
  await db.prepare("UPDATE decisions SET items = '{\"repo\": \"app\"}' WHERE id = 'd1'").run();
  c = await since(seq);
  assert.ok(c.full || c.refs.includes("app#3"));
  seq = c.cursor;

  await bulkWrites(db, "test", async () => { for (const n of [1, 3]) await db.prepare("UPDATE items SET embed_hash = ? WHERE number = ?").run(`e${n}`, n); });
  c = await since(seq);
  assert.equal(c.full, true);
  assert.deepEqual((await db.prepare("SELECT seq FROM item_changes").all() as { seq: number }[]).filter((r) => !seq.seen.has(r.seq)), []);
  seq = c.cursor;

  await db.script(db.dialect === "postgres"
    ? "DELETE FROM plan_full; SELECT setval(pg_get_serial_sequence('item_changes', 'seq'), 1, false)"
    : "DELETE FROM plan_full; DELETE FROM sqlite_sequence WHERE name = 'item_changes'");
  await db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('other', 'op', ?, 1)").run(T);
  assert.equal((await changesSince(db, seq)).full, true);
});

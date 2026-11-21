// The planner's change log: which writes re-decide which items, and which force a full pass.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { changeSeq, changesSince, pruneChanges } from "../src/core/plan-changes.ts";
import { PLAN_INPUTS } from "../src/core/plan-inputs.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { setReviewMinInterval } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-changes-"));
const T = "2026-01-01T00:00:00Z";

test("writes log the items they re-decide; stamp-only updates log nothing; cross-item and global writes reach every affected item or force a full pass", () => {
  const db = connect(join(dir, "log.db"));
  const since = (seq: number) => { const c = changesSince(db, seq); return { ...c, refs: [...c.refs].sort() }; };
  let seq = changeSeq(db);

  // Item-keyed: the row's own item.
  db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 7, 1, '{}', ?)").run(T);
  let c = since(seq);
  assert.deepEqual([c.refs, c.full], [["app#7"], false]);
  seq = c.seq;

  // A bookkeeping column alone: nothing.
  db.prepare("UPDATE item_rank SET computed_at = '2026-01-02T00:00:00Z' WHERE repo = 'app' AND number = 7").run();
  c = since(seq);
  assert.deepEqual([c.refs, c.full], [[], false]);
  assert.equal(c.seq, seq);

  // A key move logs the old and the new item.
  db.prepare("UPDATE item_rank SET number = 8 WHERE repo = 'app' AND number = 7").run();
  c = since(seq);
  assert.deepEqual(c.refs, ["app#7", "app#8"]);
  seq = c.seq;

  // Cross-item: a batch row reaches its integration PR and every member.
  const batch = Number(db.prepare(`INSERT INTO merge_batches (repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at)
    VALUES ('app', 'integration-1', 'open', 'b', 'c', 50, ?, ?)`).run(T, T).lastInsertRowid);
  db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (?, 3, 'h3', 0), (?, 4, 'h4', 1)").run(batch, batch);
  seq = since(seq).seq;
  db.prepare("UPDATE merge_batches SET state = 'merged' WHERE id = ?").run(batch);
  c = since(seq);
  assert.deepEqual([c.refs, c.full], [["app#3", "app#4", "app#50"], false]);
  seq = c.seq;

  // Cross-item without a readable set: a full pass, and later logged items after it still count.
  db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 9, 'op', ?)").run(T);
  c = since(seq);
  assert.equal(c.full, true);
  assert.ok(c.seq > seq);
  // The mark is counted under the trigger that made it.
  assert.deepEqual({ ...db.prepare("SELECT n, last_seq FROM plan_full_causes WHERE source = 'plan_fast_track_full_i'").get() }, { n: 1, last_seq: c.seq });
  seq = c.seq;

  // Global: a planner input setting forces a full pass; the planner's own bookkeeping setting does not.
  db.prepare("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(T);
  assert.equal(since(seq).full, false);
  db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  c = since(seq);
  assert.equal(c.full, true);
  seq = c.seq;

  // A prune never lets a seq come back: the next write is still after the consumed seq.
  pruneChanges(db, seq);
  db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 11, 'op', ?)").run(T);
  c = since(seq);
  assert.deepEqual([c.refs, c.full], [["app#11"], false]);
  db.close();
});

test("every table the fact loaders read is classified", () => {
  const db = connect(join(dir, "reads.db"));
  const tables = (db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string; type: string; sql: string }[]);
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
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]) {
    named(sql, read);
    return (prepare as (...a: unknown[]) => ReturnType<typeof prepare>).call(this, sql, ...rest);
  } as typeof prepare;
  try { loadPlanSet(db, { now: Date.parse(T) }); } finally { DatabaseSync.prototype.prepare = prepare; }
  const listed = new Set(PLAN_INPUTS.map((p) => p.table));
  assert.ok(read.size > 20);
  assert.deepEqual([...read].filter((t) => !listed.has(t)).sort(), []);
  // An item input without its own refs is logged by its repo and number columns.
  const cols = (t: string) => (db.prepare("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).map((c) => c.name);
  assert.deepEqual(PLAN_INPUTS.filter((p) => p.class === "item" && !p.refs && !["repo", "number"].every((c) => cols(p.table).includes(c))).map((p) => p.table), []);
  db.close();
});

test("a PR's facts change with the clock alone no earlier than its refreshAt: a review held on another item stops waiting when the blocker list expires", () => {
  const w = world().repo().pr(1, { head: "h1" }).pr(2);
  setReviewMinInterval(w.db, 0, "test");
  saveOpus(w.db, "rv", { repo: "app", number: 1, head_oid: "h1" }, {
    mode: "full", base: null, model: "m",
    review: { ref: "app#1", verdict: "hold", sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: ["app#2"] },
  });
  w.synced(1, "h2");
  const at = Date.parse((w.db.prepare("SELECT at FROM opus_reviews WHERE number = 1").get() as { at: string }).at);
  const load = (now: number) => loadPrFacts(w.db, { now, refs: ["app#1"] })[0]!;
  const f = load(at + 3600_000);
  assert.equal(f.reviewHold?.kind, "blocked");
  assert.ok(f.refreshAt! > f.now);
  // Up to refreshAt a load gives the same facts at another time; at refreshAt they differ.
  assert.deepEqual({ ...load(f.refreshAt! - 1), now: f.now }, f);
  const after = load(f.refreshAt!);
  assert.notEqual(after.reviewHold?.kind, "blocked");
  assert.equal(after.review?.stale, true);
});

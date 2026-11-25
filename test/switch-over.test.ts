// The switch to the maintainer workflow on a database an older release wrote: what it keeps, what it starts, and that running
// it again changes nothing. Runs on either engine (connectDb).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { STATE_COPY_DONE } from "../src/db/state-copy.ts";
import { SWITCH_KEY, switchOver } from "../src/db/switch-over.ts";
import { loadEvents, loadLastEventKinds } from "../src/data/workflow/index.ts";

const COPIED = "2026-11-20T00:00:00.000Z", BEFORE = "2026-11-19T00:00:00.000Z", AFTER = "2026-11-20T01:00:00.000Z", NOW = "2026-11-20T02:00:00.000Z";

async function insert(db: Db, table: string, row: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(row);
  await db.prepare(`INSERT INTO main.${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const setting = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
const item = (db: Db, number: number, kind: string, state = "OPEN") => insert(db, "items", { repo: "demo", number, kind, state, title: `t${number}`, head_oid: kind === "pr" ? `h${number}` : null, updated_at: BEFORE });
const decision = (db: Db, id: string, x: Record<string, string | number | null>) => insert(db, "decisions", {
  id, kind: "merge", repo: "demo", number: null, question: `Question ${id}?`, options: JSON.stringify([{ key: "take", label: "Take it" }, { key: "backlog", label: "Backlog" }]), asked_at: BEFORE, ...x,
});

async function legacy(): Promise<Db> {
  const db = await connectDb(":memory:");
  await db.prepare("DELETE FROM main.tracked_repos").run();
  await insert(db, "tracked_repos", { name: "demo", workflow: "legacy" });
  await insert(db, "tracked_repos", { name: "pilot", workflow: "new" });
  await setting(db, STATE_COPY_DONE, COPIED);
  await setting(db, "runner_heartbeat", AFTER);
  for (const [n, kind, state] of [[1, "issue"], [2, "pr"], [3, "issue", "CLOSED"], [4, "pr"], [5, "pr"], [6, "issue"], [7, "pr"], [8, "issue"], [9, "pr"], [10, "pr"], [11, "pr", "MERGED"], [12, "pr"]] as [number, string, string?][]) await item(db, n, kind, state);

  await decision(db, "answered", { number: 2, answer: "take", answered_by: "alice", answered_at: AFTER });
  await decision(db, "open", { number: 2 });
  await decision(db, "batch", { items: JSON.stringify([{ repo: "demo", number: 2 }, { repo: "demo", number: 7 }]), exceptions: JSON.stringify([{ repo: "demo", number: 7, answer: "other" }]), answer: "take", answered_by: "bob", answered_at: AFTER });
  await decision(db, "no-item", { kind: "other", answer: "take", answered_by: "alice", answered_at: AFTER });
  await decision(db, "parked", { kind: "scope", number: 6, answer: "backlog", answered_by: "carol", answered_at: AFTER });
  await decision(db, "parked-fast", { kind: "scope", number: 8, answer: "backlog", answered_by: "carol", answered_at: AFTER });
  await insert(db, "actions", { decision_id: "answered", repo: "demo", number: 2, kind: "comment-close", state: "done", comment_url: "https://example.test/c", created_at: AFTER });

  const fast = (number: number, weight: number) => insert(db, "fast_track", { repo: "demo", number, added_by: "dave", added_at: BEFORE, weight });
  for (const [n, w] of [[2, 5], [1, 8], [3, 5], [4, 5], [8, 5], [9, 5], [10, 7]] as const) await fast(n, w);
  await insert(db, "implementations", { repo: "demo", number: 1, queued_by: "dave", state: "pr", attempt: 1, text_hash: "x", pr_number: 9, created_at: BEFORE, updated_at: BEFORE });

  const workflow = async (id: number, number: number, state: string) =>
    await insert(db, "item_workflows", { id, repo: "demo", number, kind: "pr", entry: "fixup", state, started_by: "erin", started_at: BEFORE, started_via: "github", approved_by: "erin", approved_at: BEFORE, updated_at: BEFORE });
  await workflow(1001, 4, "running");
  await workflow(1002, 5, "running");
  const leg = (number: number, state: string, workflow_id: number | null, updated_at: string, head: string | null = null) =>
    insert(db, "preapprovals", { repo: "demo", number, by: "erin", at: BEFORE, instructions: "", state, from_head: "h", head, reason: "CI failed", updated_at, workflow_id });
  await leg(5, "asked", 1002, AFTER);
  // Pre-approved merges in progress: a fast-tracked PR's, the PR's of issue 1, a merged PR's, and one a person stopped since.
  await leg(10, "queued", null, AFTER, "h10");
  await leg(9, "fixup", null, AFTER);
  await leg(11, "queued", null, AFTER, "h11");
  await leg(12, "review", null, AFTER, "h12");
  await workflow(1003, 12, "stopped");
  await db.prepare("UPDATE main.item_workflows SET stopped_at = ? WHERE id = 1003").run(AFTER);
  // Answered after it stopped: the workflow goes on.
  await leg(4, "asked", 1001, BEFORE);
  await insert(db, "workflow_events", { workflow_id: 1001, repo: "demo", number: 4, login: "erin", via: "github", kind: "answered", at: AFTER });
  await insert(db, "workflow_events", { workflow_id: 1002, repo: "demo", number: 2, login: "erin", via: "github", kind: "ambiguous", at: AFTER });
  await insert(db, "opus_reviews", { repo: "demo", number: 5, head_oid: "h5", at: BEFORE, mode: "full", verdict: "take-fix", sure: 1, workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1, then merge it.", fix: [1], merge: true } }) });
  await insert(db, "user_settings", { login: "alice", key: "task_items", value: "fast", updated_at: BEFORE });

  // Approvals: granted on an older dashboard after the copy, revoked there, granted on a new one, revoked on a new one.
  await setting(db, "merge_approved:demo", JSON.stringify({ by: "op", at: AFTER }));
  await insert(db, "repo_step_approvals", { repo: "demo", step: "push", by: "op", at: BEFORE });
  await insert(db, "repo_step_approvals", { repo: "demo", step: "labels", by: "op", at: AFTER });
  await setting(db, "comment_approved:demo", JSON.stringify({ by: "op", at: BEFORE }));
  // The older runner went on after the copy.
  await setting(db, "pipeline_fp:review|demo", JSON.stringify({ fp: "later", job: 7 }));
  await insert(db, "lane_state", { kind: "fp", step: "review", repo: "demo", value: "earlier", job_id: 1, at: COPIED });
  await insert(db, "lane_state", { kind: "fp", step: "gone", repo: "demo", value: "x", job_id: 1, at: COPIED });
  await setting(db, "review_stale:demo#2", BEFORE);
  await insert(db, "review_state", { repo: "demo", number: 2, stale_at: AFTER });
  await insert(db, "classify_state", { kind: "jev_failed", repo: "demo", number: 1, value: "old", at: COPIED });
  await db.prepare("UPDATE main.items SET jev_failed_hash = 'new' WHERE repo = 'demo' AND number = 7").run();
  await setting(db, "limit_reset_at:merge", AFTER);
  const run = (id: number) => insert(db, "agent_runs", { id, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "m", state: "done", started_at: AFTER });
  await run(900);
  await insert(db, "agent_run_items", { run_id: 900, repo: "demo", number: 7 });
  await insert(db, "dupe_groups", { decision_id: "demo:dupegroup:1", repo: "demo", source: "model" });
  await insert(db, "discord_alert_msgs", { decision_id: `wf:1002:${BEFORE}`, user_hash: "u", sent_at: AFTER });
  return db;
}

const TABLES = ["workflow_events", "item_workflows", "preapprovals", "tracked_repos", "user_settings", "repo_step_approvals", "lane_state", "review_state", "classify_state", "stage_limits", "agent_runs", "dupe_groups", "discord_alert_msgs"];
const snapshot = async (db: Db) => {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM main.${t}`).all()).map((r) => JSON.stringify(r)).sort();
  out.audit = (await db.prepare("SELECT login, target FROM main.audit WHERE action = 'decision-archived'").all()).map((r) => JSON.stringify(r));
  return out;
};
const rows = (db: Db, text: string) => db.prepare(text).all();

test("the switch keeps the answers as history, starts fast-tracked items and carries over what older processes wrote", async () => {
  const db = await legacy();
  const r = (await switchOver(db, { now: NOW, perDay: {} }))!;

  const ref = (number: number) => ({ repo: "demo", number });
  const events = await loadEvents(db, [ref(2), ref(7)]);
  const archived = (n: number) => events.get(`demo#${n}`)!.filter((e) => e.kind as string === "archived").map((e) => [e.login, e.at, e.line]);
  assert.deepEqual(archived(2).sort(), [
    ["alice", AFTER, "Comment and close: done https://example.test/c"],
    ["alice", AFTER, "Question answered? Answer: Take it."],
    ["bob", AFTER, "Question batch? Answer: Take it."],
    ["pipeline", NOW, "Question open? Withdrawn at the switch to the maintainer workflow."],
  ]);
  assert.deepEqual(archived(7), [["bob", AFTER, "Question batch? Answer: other."]]);
  assert.equal((await rows(db, "SELECT target FROM main.audit WHERE action = 'decision-archived'"))[0]!.target, "decision:no-item");
  assert.equal((await loadLastEventKinds(db, [ref(2)])).get("demo#2"), "started", "an archived row is never an item's latest event");

  const wf = await rows(db, "SELECT number, kind, entry, weight, state, started_by, base_head FROM main.item_workflows WHERE id < 1000 OR id > 1003 ORDER BY number");
  assert.deepEqual(wf.map((w) => ({ ...w })), [
    { number: 1, kind: "issue", entry: "implement", weight: 8, state: "running", started_by: "dave", base_head: "h" },
    { number: 2, kind: "pr", entry: "review", weight: 5, state: "running", started_by: "dave", base_head: "h2" },
    { number: 6, kind: "issue", entry: "implement", weight: 5, state: "backlog", started_by: "carol", base_head: null },
    { number: 8, kind: "issue", entry: "implement", weight: 5, state: "backlog", started_by: "carol", base_head: null },
    { number: 10, kind: "pr", entry: "merge", weight: 7, state: "running", started_by: "erin", base_head: "h10" },
  ]);
  assert.deepEqual(r.fastTrackSkipped.map((s) => s.item).sort(), ["demo#10", "demo#4", "demo#8", "demo#9"], "a live workflow, a later Backlog, and the PR of an issue that starts");
  // A pre-approved merge keeps its approval: in a workflow of its own, or in that of the issue its PR implements.
  const bound = await rows(db, `SELECT p.number, w.number AS item, w.approved_by, w.approved_at FROM main.preapprovals p JOIN main.item_workflows w ON w.id = p.workflow_id
    WHERE p.state IN ('fixup', 'review', 'ci', 'queued') ORDER BY p.number`);
  assert.deepEqual(bound.map((b) => ({ ...b })), [
    { number: 9, item: 1, approved_by: "erin", approved_at: BEFORE },
    { number: 10, item: 10, approved_by: "erin", approved_at: BEFORE },
  ]);
  assert.deepEqual(r.legs.map((l) => l.item).sort(), ["demo#10", "demo#9"]);
  assert.deepEqual(r.legsSkipped.map((l) => l.item), ["demo#11", "demo#12"]);
  assert.deepEqual(await rows(db, "SELECT DISTINCT workflow FROM main.tracked_repos").then((x) => x.map((y) => y.workflow)), ["new"]);
  assert.equal((await rows(db, "SELECT value FROM main.user_settings WHERE key = 'task_items'"))[0]!.value, "fast", "the older release reads it");

  const stopped = (await rows(db, "SELECT state, rec, rec_head FROM main.item_workflows WHERE id = 1002"))[0]!;
  assert.equal(stopped.state, "recommending");
  assert.equal(stopped.rec_head, "h5");
  assert.equal((JSON.parse(stopped.rec as string) as { text: string }).text, "Fix 1, then merge it.");
  assert.equal((await rows(db, "SELECT state FROM main.item_workflows WHERE id = 1001"))[0]!.state, "running");
  assert.equal((await rows(db, "SELECT count(*) AS n FROM main.preapprovals WHERE state = 'asked'"))[0]!.n, 0);

  assert.deepEqual((await rows(db, "SELECT step FROM main.repo_step_approvals WHERE repo = 'demo' ORDER BY step")).map((x) => x.step), ["labels", "merge"]);
  assert.deepEqual((await rows(db, "SELECT key FROM main.settings WHERE key LIKE '%approved:demo' ORDER BY key")).map((x) => x.key), ["labels_approved:demo", "merge_approved:demo"]);
  assert.deepEqual((await rows(db, "SELECT step, value FROM main.lane_state WHERE kind = 'fp'")).map((x) => [x.step, x.value]), [["review", "later"]]);
  assert.equal((await rows(db, "SELECT stale_at FROM main.review_state WHERE number = 2"))[0]!.stale_at, AFTER);
  assert.deepEqual((await rows(db, "SELECT number, value FROM main.classify_state WHERE kind = 'jev_failed'")).map((x) => [x.number, x.value]), [[7, "new"]]);
  assert.equal((await rows(db, "SELECT reset_at FROM main.stage_limits WHERE step = 'merge'"))[0]!.reset_at, AFTER);
  assert.equal((await rows(db, "SELECT first_number FROM main.agent_runs WHERE id = 900"))[0]!.first_number, 7);
  assert.equal((await rows(db, "SELECT id FROM main.dupe_groups"))[0]!.id, "demo:dupegroup:1");
  assert.equal((await rows(db, "SELECT workflow_id FROM main.discord_alert_msgs"))[0]!.workflow_id, 1002);
  assert.equal((await rows(db, "SELECT count(*) AS n FROM main.decisions"))[0]!.n, 6, "the old tables keep their rows for a rollback");
  await db.close();
});

test("a second run, and a run after one that was cut short, change nothing; an older release that ran again is switched again", async () => {
  const db = await legacy();
  await switchOver(db, { now: NOW });
  const after = await snapshot(db);
  assert.equal(await switchOver(db, { now: "2026-11-21T00:00:00.000Z" }), null);
  // Cut short before its last transaction, the switch runs whole again.
  await db.prepare("DELETE FROM main.settings WHERE key = ?").run(SWITCH_KEY);
  await switchOver(db, { now: "2026-11-21T00:00:00.000Z" });
  assert.deepEqual(await snapshot(db), after);

  await setting(db, "runner_heartbeat", "2026-11-22T00:00:00.000Z");
  await db.prepare("UPDATE main.decisions SET answer = 'take', answered_by = 'alice', answered_at = '2026-11-22T00:00:00.000Z' WHERE id = 'open'").run();
  const again = (await switchOver(db, { now: "2026-11-23T00:00:00.000Z" }))!;
  assert.deepEqual([again.archived.answered, again.archived.withdrawn, again.archived.actions, again.fastTrack.length], [1, 0, 0, 0]);
  await db.close();
});

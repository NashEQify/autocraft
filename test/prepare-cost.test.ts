// What makes a decision due for another prepare: head pushes, discussion, reviews and the daily cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareIds } from "../src/decide/prepare.ts";
import { preparedEarlier, preparing } from "../src/decide/prepared.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { dependsOnCode } from "../src/conversations/cards.ts";
import { world } from "./world-db.ts";

const DAY = Date.parse("2026-11-04T12:00:00.000Z");
const opts = [{ key: "take", label: "Take" }, { key: "close", label: "Close" }];

async function setup() {
  const w = await (await (await world()).repo()).pr(7);
  const head = (await w.db.prepare("SELECT head_oid FROM items WHERE number = 7").get())!.head_oid as string;
  await ask(w.db, [
    { id: "app#7:scope", kind: "scope", repo: "app", number: 7, question: "In scope?", options: opts },
    { id: `app#7:merge@${head}`, kind: "merge", repo: "app", number: 7, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "no", label: "No" }] },
  ]);
  await w.db.prepare("UPDATE decisions SET prepared_at = '2026-11-04T10:00:00.000Z', prepared_head = ?, prepared_discussion = ''").run(head);
  return { w, head };
}
const comment = async (w: Awaited<ReturnType<typeof setup>>["w"], id: string, at: string, o: { counted?: number; author?: string; body?: string } = {}) =>
  await w.db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, counted) VALUES ('app', 7, ?, 'comment', ?, ?, ?, ?)").run(id, o.author ?? "maint", at, o.body ?? "b", o.counted ?? 1);

test("a scope decision stays prepared across a head push; a Merge? decision for an old head is not prepared", async () => {
  const { w, head } = await setup();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.prepare("UPDATE items SET head_oid = 'newhead' WHERE number = 7").run();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE id LIKE '%merge@%'").run();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.prepare("UPDATE items SET head_oid = ? WHERE number = 7").run(head);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [`app#7:merge@${head}`]);
});

test("a scope decision is prepared again after a counted person's comment, a review at the head or not after other posts", async () => {
  const { w } = await setup();
  await comment(w, "bot", "2026-11-04T11:00:00.000Z", { counted: 0 });
  await comment(w, "own", "2026-11-04T11:10:00.000Z", { body: "_AI-generated review of the PR_" });
  await w.db.prepare("INSERT INTO conversation_turns (repo, number, kind, login, at, body, block) VALUES ('app', 7, 'operator', 'op', '2026-11-04T11:20:00.000Z', 'hi', 'hi')").run();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await comment(w, "c2", "2026-11-04T11:30:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  // A prepare that read c2 covers it.
  await w.db.prepare("UPDATE decisions SET prepared_discussion = 'c2' WHERE id = 'app#7:scope'").run();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict) VALUES ('app', 7, (SELECT head_oid FROM items WHERE number = 7), '2026-11-04T11:40:00.000Z', 'full', 'take')").run();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("the 4th automatic prepare in a UTC day is held and the decision is not preparing; Re-prepare runs", async () => {
  const { w } = await setup();
  await w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE kind = 'scope'").run();
  const rec = async (at: string) => await w.db.prepare("INSERT INTO decision_prepares (decision_id, at, manual) VALUES ('app#7:scope', ?, 0)").run(at);
  await rec("2026-11-03T23:00:00.000Z"); await rec("2026-11-04T01:00:00.000Z"); await rec("2026-11-04T02:00:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  await rec("2026-11-04T03:00:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  const today = new Date().toISOString().slice(0, 10);
  await w.db.prepare("UPDATE decision_prepares SET at = ?").run(`${today}T00:00:01.000Z`);
  assert.equal(await preparing(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  // With earlier choices it shows them as prepared earlier.
  await w.db.prepare("UPDATE decisions SET prepared_at = '2026-11-04T10:00:00.000Z', prepared_discussion = 'zzz' WHERE id = 'app#7:scope'").run();
  // Past the day's discussion re-prepares a new comment no longer makes the choices stale; a new review at the head does.
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  await w.db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict) VALUES ('app', 7, (SELECT head_oid FROM items WHERE number = 7), '2026-11-04T11:40:00.000Z', 'full', 'take')").run();
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), true);
  await w.db.prepare("UPDATE decisions SET prepare_requested_at = ?, prepared_at = NULL WHERE id = 'app#7:scope'").run("2026-11-04T11:00:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("cards that rest on the code are told apart from those that do not", () => {
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "comment" }, { kind: "label", label: "x" }], settle: null }, "Thanks"), true);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "fixup", instructions: "do", merge: false }], settle: null }, null), true);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "label", label: "x" }], settle: { kind: "backlog", decision: "d", stamp: "s" } }, null), false);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "close", reason: "not_planned" as never, pr: true }], settle: null }, null), false);
});

test("after a push, a scope decision whose choices hold a code-dependent core is prepared again once per new head", async () => {
  const { w, head } = await setup();
  const put = async (drafts: object, seenHead: string) => {
    await w.db.prepare("DELETE FROM decision_choices").run();
    await w.db.prepare(`INSERT INTO decision_choices (id, decision_id, repo, number, stamp, seen, source, drafts, added, pick, state, created_at)
      VALUES ('c1', 'app#7:scope', 'app', 7, 's', ?, 'prepare', ?, '[]', '{}', 'current', '2026-11-04T10:00:00.000Z')`).run(JSON.stringify({ head: seenHead }), JSON.stringify(drafts));
  };
  await put({ "o:close": { extras: [] }, backlog: { extras: [] } }, head);
  await w.db.prepare("UPDATE items SET head_oid = 'newhead' WHERE number = 7").run();
  // Only code-independent cores: left as they are.
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await put({ "o:take": { extras: [{ kind: "comment", on: true }] } }, head);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  // Prepared for the new head: not due again.
  await put({ "o:take": { extras: [{ kind: "comment", on: true }] } }, "newhead");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  // Capped: the existing choices stay, shown as prepared earlier.
  await put({ "x:fixup": { params: { instructions: "do" }, extras: [] } }, head);
  for (const at of ["01", "02", "03"]) await w.db.prepare("INSERT INTO decision_prepares (decision_id, at, manual) VALUES ('app#7:scope', ?, 0)").run(`${new Date().toISOString().slice(0, 10)}T00:00:${at}.000Z`);
  assert.equal(await preparing(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), true);
});

test("a second comment in a day does not re-prepare; a Merge? question waits only while the Plan holds a review at its head, and Re-prepare lifts that", async () => {
  const { w, head } = await setup();
  const today = "2026-11-04";
  const rec = async (at: string) => await w.db.prepare("INSERT INTO decision_prepares (decision_id, at, manual) VALUES ('app#7:scope', ?, 0)").run(at);
  await comment(w, "c2", "2026-11-04T11:30:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"], "the first comment of the day re-prepares");
  await rec(`${today}T00:00:01.000Z`); await rec(`${today}T00:00:02.000Z`);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [], "later comments wait for a new review, head or Re-prepare");
  await w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE id LIKE '%merge@%'").run();
  const merge = `app#7:merge@${head}`;
  const plan = async (actions: unknown[]) => await w.db.prepare("INSERT INTO item_plans (repo, number, kind, state, actions, reasons, view, planned_at) VALUES ('app', 7, 'pr', 'x', ?, '[]', ?, '2026-11-04T00:00:00.000Z') ON CONFLICT (repo, number) DO UPDATE SET actions = excluded.actions, view = excluded.view").run(JSON.stringify(actions), JSON.stringify({ next: "Review" }));
  await plan([]);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [merge], "a stale review the Plan does not start (held by a cap or a blocker) does not hold the question");
  await plan([{ kind: "review", head }]);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [], "a review that starts at this head withdraws and asks the question again");
  await w.db.prepare("UPDATE decisions SET prepare_requested_at = '2026-11-04T11:00:00.000Z' WHERE id = ?").run(merge);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [merge], "an operator's Re-prepare runs");
});

test("prepares go round the repos, and a locked decision is not prepared", async () => {
  const { w } = await setup();
  await w.db.prepare("UPDATE decisions SET prepared_at = NULL").run();
  assert.equal((await prepareIds(w.db, undefined, DAY)).length, 2);
  await w.db.prepare("INSERT INTO conversation_cards (id, turn_id, repo, number, kind, params, description, state) VALUES (9, 0, 'app', 7, 'resolution', '{}', 'x', 'queued')").run();
  await w.db.prepare("UPDATE decisions SET exec_state = 'settling', exec_reason = '9:op' WHERE id = 'app#7:scope'").run();
  assert.deepEqual((await prepareIds(w.db, undefined, DAY)).filter((id) => id.includes("scope")), [], "a queued press holds its decision");
});

// What makes a decision due for another prepare: head pushes, discussion, reviews and the daily cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareIds } from "../src/decide/prepare.ts";
import { preparedEarlier, preparing } from "../src/decide/prepared.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { dependsOnCode } from "../src/conversations/cards.ts";
import { world } from "./world-db.ts";
import * as kx from "../src/db/kx.ts";

const DAY = Date.parse("2026-11-04T12:00:00.000Z");
const opts = [{ key: "take", label: "Take" }, { key: "close", label: "Close" }];

async function setup() {
  const w = await (await (await world()).repo()).pr(7);
  const head = (await w.db.get(w.db.k.selectFrom("items").select("head_oid").where("number", "=", 7)))!.head_oid as string;
  await ask(w.db, [
    { id: "app#7:scope", kind: "scope", repo: "app", number: 7, question: "In scope?", options: opts },
    { id: `app#7:merge@${head}`, kind: "merge", repo: "app", number: 7, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "no", label: "No" }] },
  ]);
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: "2026-11-04T10:00:00.000Z", prepared_head: head, prepared_discussion: "" }));
  return { w, head };
}
const comment = async (w: Awaited<ReturnType<typeof setup>>["w"], id: string, at: string, o: { counted?: number; author?: string; body?: string } = {}) =>
  await w.db.run(w.db.k.insertInto("comments").values({ repo: "app", number: 7, id, kind: "comment", author: o.author ?? "maint", created_at: at, body: o.body ?? "b", counted: o.counted ?? 1 }));

test("a scope decision stays prepared across a head push; a Merge? decision for an old head is not prepared", async () => {
  const { w, head } = await setup();
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.run(w.db.k.updateTable("items").set({ head_oid: "newhead" }).where("number", "=", 7));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: null }).where((eb) => kx.like(w.db, "id", eb.val("%merge@%"))));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.run(w.db.k.updateTable("items").set({ head_oid: head }).where("number", "=", 7));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [`app#7:merge@${head}`]);
});

test("a scope decision is prepared again after a counted person's comment, a review at the head or not after other posts", async () => {
  const { w } = await setup();
  await comment(w, "bot", "2026-11-04T11:00:00.000Z", { counted: 0 });
  await comment(w, "own", "2026-11-04T11:10:00.000Z", { body: "_AI-generated review of the PR_" });
  await w.db.run(w.db.k.insertInto("conversation_turns").values({ repo: "app", number: 7, kind: "operator", login: "op", at: "2026-11-04T11:20:00.000Z", body: "hi", block: "hi" }));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await comment(w, "c2", "2026-11-04T11:30:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  // A prepare that read c2 covers it.
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_discussion: "c2" }).where("id", "=", "app#7:scope"));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await w.db.run(w.db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: (await w.db.get(w.db.k.selectFrom("items").select("head_oid").where("number", "=", 7)))!.head_oid!, at: "2026-11-04T11:40:00.000Z", mode: "full", verdict: "take" }));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("the 4th automatic prepare in a UTC day is held and the decision is not preparing; Re-prepare runs", async () => {
  const { w } = await setup();
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: null }).where("kind", "=", "scope"));
  const rec = async (at: string) => await w.db.run(w.db.k.insertInto("decision_prepares").values({ decision_id: "app#7:scope", at, manual: 0 }));
  await rec("2026-11-03T23:00:00.000Z"); await rec("2026-11-04T01:00:00.000Z"); await rec("2026-11-04T02:00:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  await rec("2026-11-04T03:00:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  const today = new Date().toISOString().slice(0, 10);
  await w.db.run(w.db.k.updateTable("decision_prepares").set({ at: `${today}T00:00:01.000Z` }));
  assert.equal(await preparing(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  // With earlier choices it shows them as prepared earlier.
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: "2026-11-04T10:00:00.000Z", prepared_discussion: "zzz" }).where("id", "=", "app#7:scope"));
  // Past the day's discussion re-prepares a new comment no longer makes the choices stale; a new review at the head does.
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  await w.db.run(w.db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: (await w.db.get(w.db.k.selectFrom("items").select("head_oid").where("number", "=", 7)))!.head_oid!, at: "2026-11-04T11:40:00.000Z", mode: "full", verdict: "take" }));
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), true);
  await w.db.run(w.db.k.updateTable("decisions").set({ prepare_requested_at: "2026-11-04T11:00:00.000Z", prepared_at: null }).where("id", "=", "app#7:scope"));
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
    await w.db.run(w.db.k.deleteFrom("decision_choices"));
    await w.db.run(w.db.k.insertInto("decision_choices").values({ id: "c1", decision_id: "app#7:scope", repo: "app", number: 7, stamp: "s", seen: JSON.stringify({ head: seenHead }), source: "prepare", drafts: JSON.stringify(drafts), added: "[]", pick: "{}", state: "current", created_at: "2026-11-04T10:00:00.000Z" }));
  };
  await put({ "o:close": { extras: [] }, backlog: { extras: [] } }, head);
  await w.db.run(w.db.k.updateTable("items").set({ head_oid: "newhead" }).where("number", "=", 7));
  // Only code-independent cores: left as they are.
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  await put({ "o:take": { extras: [{ kind: "comment", on: true }] } }, head);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  // Prepared for the new head: not due again.
  await put({ "o:take": { extras: [{ kind: "comment", on: true }] } }, "newhead");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), []);
  // Capped: the existing choices stay, shown as prepared earlier.
  await put({ "x:fixup": { params: { instructions: "do" }, extras: [] } }, head);
  for (const at of ["01", "02", "03"]) await w.db.run(w.db.k.insertInto("decision_prepares").values({ decision_id: "app#7:scope", at: `${new Date().toISOString().slice(0, 10)}T00:00:${at}.000Z`, manual: 0 }));
  assert.equal(await preparing(w.db, (await getDecision(w.db, "app#7:scope"))!), false);
  assert.equal(await preparedEarlier(w.db, (await getDecision(w.db, "app#7:scope"))!), true);
});

test("a second comment in a day does not re-prepare; a Merge? question waits only while the Plan holds a review at its head, and Re-prepare lifts that", async () => {
  const { w, head } = await setup();
  const today = "2026-11-04";
  const rec = async (at: string) => await w.db.run(w.db.k.insertInto("decision_prepares").values({ decision_id: "app#7:scope", at, manual: 0 }));
  await comment(w, "c2", "2026-11-04T11:30:00.000Z");
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), ["app#7:scope"], "the first comment of the day re-prepares");
  await rec(`${today}T00:00:01.000Z`); await rec(`${today}T00:00:02.000Z`);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [], "later comments wait for a new review, head or Re-prepare");
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: null }).where((eb) => kx.like(w.db, "id", eb.val("%merge@%"))));
  const merge = `app#7:merge@${head}`;
  const plan = async (actions: unknown[]) => await w.db.run(w.db.k.insertInto("item_plans").values({ repo: "app", number: 7, kind: "pr", state: "x", actions: JSON.stringify(actions), reasons: "[]", view: JSON.stringify({ next: "Review" }), planned_at: "2026-11-04T00:00:00.000Z" })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["actions", "view"]))));
  await plan([]);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [merge], "a stale review the Plan does not start (held by a cap or a blocker) does not hold the question");
  await plan([{ kind: "review", head }]);
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [], "a review that starts at this head withdraws and asks the question again");
  await w.db.run(w.db.k.updateTable("decisions").set({ prepare_requested_at: "2026-11-04T11:00:00.000Z" }).where("id", "=", merge));
  assert.deepEqual(await prepareIds(w.db, undefined, DAY), [merge], "an operator's Re-prepare runs");
});

test("prepares go round the repos, and a locked decision is not prepared", async () => {
  const { w } = await setup();
  await w.db.run(w.db.k.updateTable("decisions").set({ prepared_at: null }));
  assert.equal((await prepareIds(w.db, undefined, DAY)).length, 2);
  await w.db.run(w.db.k.insertInto("conversation_cards").values({ id: 9, turn_id: 0, repo: "app", number: 7, kind: "resolution", params: "{}", description: "x", state: "queued" }));
  await w.db.run(w.db.k.updateTable("decisions").set({ exec_state: "settling", exec_reason: "9:op" }).where("id", "=", "app#7:scope"));
  assert.deepEqual((await prepareIds(w.db, undefined, DAY)).filter((id) => id.includes("scope")), [], "a queued press holds its decision");
});

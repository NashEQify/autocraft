// Proposed cards from before the choices format become drafts; the settling cards are replaced, an ask card stays proposed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { currentChoices } from "../src/decide/choices.ts";
import { convertOpenDecisions } from "../src/decide/choices-convert.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const T0 = "2026-01-01T00:00:00Z";

test("open decisions' proposed cards convert to choices", async () => {
  const db: Db = await connectDb(join(mkdtempSync(join(SCRATCH, "choices-convert-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await useTestAccount(db);
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "issue", state: "OPEN", title: "Issue 1", body: "Body", author: "someone", created_at: T0, updated_at: T0, labels: "[]" }));
  await ask(db, [{ id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }] }]);
  await db.run(db.k.updateTable("decisions").set({ recommended: "take", recommended_reason: "fits" }).where("id", "=", "app#1:scope"));
  const turn = Number((await db.get(db.k.insertInto("conversation_turns").values({ repo: "app", number: 1, kind: "opus", login: "opus", at: T0, body: "", block: "" }).returning("id")))!.id);
  const card = { run: async (turn_id: number, params: string, text: string) => await db.run(db.k.insertInto("conversation_cards").values({ turn_id, repo: "app", number: 1, kind: "resolution", params, text, description: "" })) };
  const stamp = await decisionStamp(db, (await getDecision(db, "app#1:scope"))!);
  const take = { kind: "resolution", settle: { kind: "answer", decision: "app#1:scope", option: "take", stamp }, steps: [{ kind: "comment" }, { kind: "label", label: "accepted" }, { kind: "open_issue", repo: "app", title: "T", body: "B" }] };
  const close = { kind: "resolution", settle: { kind: "handled", decision: "app#1:scope", summary: "s", stamp, fromClose: true }, steps: [{ kind: "comment" }, { kind: "close", reason: "not_planned", pr: false }] };
  await card.run(turn, JSON.stringify(take), "Thanks");
  await card.run(turn, JSON.stringify(close), "Closing");
  await card.run(turn, JSON.stringify({ kind: "resolution", settle: null, steps: [{ kind: "comment" }] }), "Which area?");

  // A card written for an earlier state of the decision is not converted.
  await card.run(turn, JSON.stringify({ ...take, settle: { ...take.settle, stamp: "old|0" } }), "Stale");
  const r = await convertOpenDecisions(db);
  assert.deepEqual([r.converted, r.skipped, r.stale, r.unconverted], [1, 0, 1, 0]);
  const row = (await currentChoices(db, "app#1:scope"))!;
  assert.equal(row.source, "converted");
  assert.deepEqual(row.pick, { core: "o:take", reason: "fits" });
  assert.deepEqual(row.drafts["o:take"]!.extras.map((e) => [e.id, e.on]), [["comment", true], ["label:accepted", true], ["open_issue", true]]);
  assert.equal(row.drafts["o:take"]!.extras[0]!.text, "Thanks");
  assert.deepEqual(row.added, ["x:close:not_planned"]);
  assert.equal(row.drafts["x:close:not_planned"]!.extras[0]!.text, "Closing");
  const states = (await db.all(db.k.selectFrom("conversation_cards").select("state").orderBy("id"))).map((r) => r.state);
  assert.deepEqual(states, ["replaced", "replaced", "proposed", "proposed"]);
  assert.equal((await convertOpenDecisions(db)).converted, 0);
});

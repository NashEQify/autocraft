// Questions that can no longer be answered usefully: a closed item's open questions are withdrawn after a sync, and a resolve
// card from a conversation closes the open decision as handled without any GitHub write.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { parseReply } from "../src/conversations/cards.ts";
import { doCard } from "../src/conversations/act.ts";
import { insertTurn } from "../src/conversations/store.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { setAsideSupersededQuestions, withdrawClosedQuestions } from "../src/merge/withdraw.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const T0 = "2026-01-01T00:00:00Z";
const OPTIONS = [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }];

async function fresh(): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "cleanup-test-")), "t.db"));
  await db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels) VALUES ('app', ?, 'issue', ?, ?, 'Body', 'someone', '${T0}', '${T0}', '[]')`);
  await item.run(1, "OPEN", "Open issue");
  await item.run(2, "OPEN", "Closes later");
  await item.run(3, "OPEN", "Stays open");
  return db;
}

describe("withdrawing questions about closed items", () => {
  test("a closed item's scope question is withdrawn and a group with two open members keeps its question", async () => {
    const db = await fresh();
    await ask(db, [
      { id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: OPTIONS },
      { id: "app#2:scope", kind: "scope", repo: "app", number: 2, question: "Scope?", options: OPTIONS },
      { id: "app:dupegroup:1", kind: "duplicate", repo: "app", items: [{ repo: "app", number: 1 }, { repo: "app", number: 2 }, { repo: "app", number: 3 }], question: "Duplicates?", options: OPTIONS },
    ]);
    const member = db.prepare("INSERT INTO dupe_group_items (decision_id, repo, number, kind, role, base_role) VALUES ('app:dupegroup:1', 'app', ?, 'issue', 'stay', 'stay')");
    for (const n of [1, 2, 3]) await member.run(n);
    assert.equal(await withdrawClosedQuestions(db, T0), 0);

    await db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 2").run();
    assert.equal(await withdrawClosedQuestions(db, T0), 1, "the group still has two open members");
    assert.equal((await getDecision(db, "app#1:scope"))!.answer, null);
    assert.equal(await getDecision(db, "app#2:scope"), undefined, "the closed item's question left its id, so a reopened item is asked again");
    const old = (await db.prepare("SELECT answer, answered_by, answer_note FROM decisions WHERE id LIKE 'app#2:scope~replaced-%'").get())!;
    assert.deepEqual({ ...old }, { answer: "withdrawn", answered_by: "pipeline", answer_note: "the issue was closed on GitHub" });
    assert.equal((await getDecision(db, "app:dupegroup:1"))!.answer, null);

    await db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 3").run();
    assert.equal(await withdrawClosedQuestions(db, T0), 1);
    assert.equal((await getDecision(db, "app:dupegroup:1"))!.answer_note, "the duplicate group has one open item left");
    assert.equal(await withdrawClosedQuestions(db, T0), 0, "nothing is left to withdraw");
  });
});

describe("resolve card", () => {
  test("answers the open decision as handled and writes nothing to GitHub", async () => {
    const db = await fresh();
    await ask(db, [{ id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: OPTIONS }]);
    const parsed = (await parseReply(db, "app", 1, 'None of the options fits; the comment settled it.\n```actions\n[{"kind":"resolution","steps":[],"settle":{"kind":"handled","summary":"Asked for a use case."}},{"kind":"resolution","steps":[],"settle":{"kind":"handled","summary":""}}]\n```'))!;
    assert.equal(parsed.cards.length, 1, "a handled settle without a summary is dropped");
    const turn = await insertTurn(db, "app", 1, { kind: "opus", login: "opus", body: "x", block: "x" });
    const card = (await db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (?, 'app', 1, 'resolution', ?, NULL, ?)")
      .run(turn, JSON.stringify(parsed.cards[0]!.params), parsed.cards[0]!.description)).lastInsertRowid as number;
    const querier = { query: async () => { throw new Error("GitHub was called"); }, spent: 0, remaining: null };
    const r = await doCard(db, card, "op", { querier });
    assert.equal(r.card.state, "done", r.card.error ?? "");
    const d = (await getDecision(db, "app#1:scope"))!;
    assert.deepEqual({ answer: d.answer, note: d.answer_note, by: d.answered_by, applied: !!d.applied_at }, { answer: "handled", note: "Asked for a use case.", by: "op", applied: true });
  });
});

describe("one open question per item", () => {
  test("a newer merge question replaces the older one, and a newer merge question displaces an older scope question", async () => {
    const db = await fresh();
    const q = (id: string, kind: string, n: number, at: string) => ({ id, kind, repo: "app", number: n, question: "Q?", options: OPTIONS, asked_at: at });
    await ask(db, [q("app#1:merge@aaa", "merge", 1, "2026-01-01T00:00:00Z"), q("app#1:merge@bbb", "merge", 1, "2026-01-01T01:00:00Z"), q("app#1:close@bbb", "close", 1, "2026-01-01T02:00:00Z"),
      q("app#2:scope", "scope", 2, "2026-01-01T00:00:00Z"), q("app#2:merge@ccc", "merge", 2, "2026-01-01T01:00:00Z")]);
    assert.equal(await setAsideSupersededQuestions(db, T0), 3);
    const open = (await db.prepare("SELECT id FROM decisions WHERE answer IS NULL ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(open, ["app#1:close@bbb", "app#2:merge@ccc"]);
    assert.equal((await getDecision(db, `app#1:merge@aaa~replaced-${T0}`))?.answer, "withdrawn");
    assert.equal(await setAsideSupersededQuestions(db, T0), 0);
  });
});

describe("questions at a head the PR moved past", () => {
  test("an open merge question at an old head is set aside; an answered one and the current head's stay", async () => {
    const db = await fresh();
    await db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels, head_oid) VALUES ('app', 10, 'pr', 'OPEN', 'PR', 'Body', 'someone', '${T0}', '${T0}', '[]', 'bbb')`).run();
    await db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels, head_oid) VALUES ('app', 11, 'pr', 'OPEN', 'PR', 'Body', 'someone', '${T0}', '${T0}', '[]', 'bbb')`).run();
    await ask(db, [
      { id: "app#10:merge@aaa", kind: "merge", repo: "app", number: 10, question: "Merge?", options: OPTIONS },
      { id: "app#11:merge@aaa", kind: "merge", repo: "app", number: 11, question: "Merge?", options: OPTIONS },
    ]);
    await db.prepare("UPDATE main.decisions SET answer = 'merge', answered_by = 'op', answered_at = ? WHERE id = 'app#11:merge@aaa'").run(T0);
    assert.equal(await setAsideSupersededQuestions(db, T0), 1);
    assert.equal(await getDecision(db, "app#10:merge@aaa"), undefined);
    assert.equal((await getDecision(db, `app#10:merge@aaa~replaced-${T0}`))?.answer, "withdrawn");
    assert.equal((await getDecision(db, "app#11:merge@aaa"))?.answer, "merge");
  });
});

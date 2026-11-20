// Needs queue rows: the reference's meta line, the compact answer word, ages and roving selection.
// Pure helpers only — no DOM, no data access beyond the Decision they are given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "../web/src/lib/format.ts";
import type { Decision } from "../web/src/api/types.ts";
import { ageTitle, answerWord, compactAge, metaFacts, refText, selectedFor, stepIndex } from "../web/src/modules/decisions/rows.ts";

const decision = (over: Partial<Decision> = {}): Decision => ({ id: "d1", repo: "deckcraft", number: 3180, items: [], kind: "merge", title: "t", askedAt: "2026-11-16T09:00:00Z", claim: null, answer: null, appliedAt: null, exec: null, dispute: null, ...over } as Decision);

test("the reference's meta order, with only the facts the DTO carries", () => {
  assert.deepEqual(metaFacts(decision()), [{ key: "ref", text: "deckcraft#3180" }, { key: "kind", text: "Merge approval" }]);
  const now = Date.parse("2026-11-16T09:00:00Z");
  const claimed = metaFacts(decision({ claim: { login: "ochre-fox", since: "2026-11-16T08:48:00Z" } }), now);
  assert.deepEqual(claimed.map((f) => f.text), ["deckcraft#3180", "Merge approval", "on it · ochre-fox · 12m"]);
  assert.match(claimed[2].title ?? "", /^claimed /);
  // A claim without a usable time still names the reader and says the time is unknown.
  const timeless = metaFacts(decision({ claim: { login: "ochre-fox", since: "not-a-date" } }), now);
  assert.equal(timeless[2].text, "on it · ochre-fox");
  assert.equal(timeless[2].title, "claim time unknown");
  const answered = metaFacts(decision({ answer: "merge", appliedAt: "2026-11-16T10:00:00Z" }));
  assert.deepEqual(answered.at(-1), { key: "answer", text: "applied", tone: "ok" });
});

test("an answered backlog decision keeps its row kind without claiming an applied write", () => {
  const facts = metaFacts(decision({ kind: "backlog", answer: "backlog" }));
  assert.deepEqual(facts, [
    { key: "ref", text: "deckcraft#3180" },
    { key: "kind", text: "Backlog" },
    { key: "answer", text: "answered", tone: "neutral" },
  ]);
});

test("a batch never invents a repo#number", () => {
  assert.equal(refText({ repo: "wordcraft", number: null, items: [0, 1, 2].map((i) => ({ repo: "wordcraft", number: i + 1, kind: "pr", state: "open", title: "t" })) as Decision["items"] }), "wordcraft · 3 items");
  assert.equal(refText({ repo: "wordcraft", number: null, items: [{ repo: "wordcraft", number: 1, kind: "pr", state: "open", title: "t" }] as Decision["items"] }), "wordcraft · 1 item");
  assert.equal(refText({ repo: "wordcraft", number: 12, items: [] }), "wordcraft#12");
});

test("the compact answer word follows the DTO's precedence and never invents held or applied", () => {
  const dispute = { by: "kiri", reason: "why", at: "2026-11-16T09:30:00Z" };
  // held = a disputed answer that is not applied; no `held` enum exists.
  assert.deepEqual(answerWord(decision({ answer: "merge", dispute })), { text: "held", tone: "warn" });
  // An applied answer outranks a later dispute.
  assert.deepEqual(answerWord(decision({ answer: "merge", appliedAt: "2026-11-16T10:00:00Z", dispute })), { text: "applied", tone: "ok" });
  // The write's own states.
  assert.equal(answerWord(decision({ answer: "merge", exec: { state: "failed", reason: "x" } }))?.text, "failed");
  assert.equal(answerWord(decision({ answer: "merge", exec: { state: "pending", reason: null } }))?.text, "pending");
  assert.equal(answerWord(decision({ answer: "merge", exec: { state: "waiting-token", reason: null } }))?.text, "waiting");
  assert.equal(answerWord(decision({ answer: "merge", exec: { state: "waiting-permission", reason: null } }))?.text, "waiting");
  assert.equal(answerWord(decision({ answer: "merge", exec: { state: "done", reason: null } }))?.text, "applied");
  // A plain answer, and nothing at all.
  assert.equal(answerWord(decision({ answer: "merge" }))?.text, "answered");
  assert.equal(answerWord(decision()), null);
  // Contradictory fields: no answer and no applied write means nothing is reported, even with exec/dispute metadata.
  assert.equal(answerWord(decision({ exec: { state: "failed", reason: "x" } })), null);
  assert.equal(answerWord(decision({ dispute })), null);
  // queued/preparing/orphaned are not answer states and never read as applied.
  assert.equal(answerWord(decision({ answer: "merge", queued: { card: 1, by: "x", place: 2, reason: "", dispute: null }, orphaned: true }))?.text, "answered");
});

test("the compact age is relative, honest for future and invalid values, with an absolute title", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(compactAge("2026-11-16T11:30:00Z", now), "30m");
  assert.equal(compactAge("2026-11-13T12:00:00Z", now), "3d");
  assert.equal(compactAge("2026-11-16T14:00:00Z", now), "in 2h");
  assert.equal(compactAge("not-a-date", now), "unknown");
  assert.match(ageTitle("2026-11-16T11:30:00Z"), /^asked /);
  assert.equal(ageTitle("not-a-date"), "asked time unknown");
});

test("roving selection defaults to the first row and clamps every movement", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(selectedFor(list, undefined), "a");
  assert.equal(selectedFor(list, "gone"), "a");
  assert.equal(selectedFor(list, "b"), "b");
  assert.equal(selectedFor([], "b"), undefined);
  assert.equal(stepIndex(list, 0, "ArrowDown"), 1);
  assert.equal(stepIndex(list, 2, "ArrowDown"), 2);
  assert.equal(stepIndex(list, 0, "ArrowUp"), 0);
  assert.equal(stepIndex(list, 1, "Home"), 0);
  assert.equal(stepIndex(list, 1, "End"), 2);
  assert.equal(stepIndex([], 0, "ArrowDown"), -1);
});


test("row and claim ages use the same frozen app clock as the list summary", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  setClock(() => now);
  try {
    assert.equal(compactAge("2026-11-16T07:00:00Z"), "5h");
    assert.equal(metaFacts(decision({ claim: { login: "ochre-fox", since: "2026-11-16T11:48:00Z" } })).find(f => f.key === "claim")?.text, "on it · ochre-fox · 12m");
  } finally { setClock(() => Date.now()); }
});

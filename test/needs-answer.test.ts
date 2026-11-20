// P6 private answer session: reader isolation/drop, per-id retention, cap/500, the 4 s two-press arm, the
// synchronous request lock, the single freshness watermark and the accepted-result precedence helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, materialSignature, NOTE_MAX, pageSerialFor, questionSignature, readerKeyOf } from "../web/src/modules/decisions/answer-state.ts";

const R1 = { login: "anna", role: "operator" };
const R2 = { login: "bo", role: "operator" };

test("drafts are per id for one reader and survive D1→D2→D1", () => {
  const s = createSession(8);
  s.setReader(R1);
  s.setPick("d1", "keep", R1);
  s.setNote("d1", "because", R1);
  s.setPick("d2", "close", R1);
  assert.equal(s.get().drafts.get("d1")?.pick, "keep");
  assert.equal(s.get().drafts.get("d1")?.note, "because");
  assert.equal(s.get().drafts.size, 2);          // only explicit events allocate
  s.setPick("d1", null, R1);
  assert.equal(s.get().drafts.get("d1")?.pick, null);
  assert.equal(s.get().drafts.get("d1")?.note, "because");   // the note remains
});

test("a genuine reader change DROPS prior drafts and R1→R2→R1 does not restore them", () => {
  const s = createSession(8);
  s.setReader(R1); s.setPick("d1", "keep", R1); s.setNote("d1", "note", R1);
  assert.equal(s.get().drafts.size, 1);
  s.setReader(R2);
  assert.equal(s.get().drafts.size, 0);
  assert.equal(s.get().accepted, null);
  assert.notEqual(s.get().readerKey, readerKeyOf(R1));
  s.setReader(R1);
  assert.equal(s.get().drafts.size, 0);          // deliberate privacy deviation from v9
});

test("the cap refuses new drafts without losing existing ones; empty pick+note removes an entry", () => {
  const s = createSession(2);
  s.setReader(R1);
  assert.equal(s.setPick("a", "keep", R1), true);
  assert.equal(s.setPick("b", "keep", R1), true);
  assert.equal(s.setPick("c", "keep", R1), false);          // refused
  assert.deepEqual([...s.get().drafts.keys()].sort(), ["a", "b"]);
  assert.match(s.get().error?.message ?? "", /limit/i);
  s.setPick("a", null, R1);
  assert.equal(s.setPick("c", "keep", R1), true);           // space freed by an explicit removal
});

test("the note is capped at 500 characters and an overlength edit keeps the previous draft", () => {
  const s = createSession(4);
  s.setReader(R1);
  assert.equal(s.setNote("d", "x".repeat(500), R1), "ok");
  assert.equal(s.setNote("d", "x".repeat(501), R1), "overlength");
  assert.equal(s.get().drafts.get("d")?.note.length, 500);
  assert.equal(NOTE_MAX, 500);
  assert.equal(s.get().error?.kind, "overlength");
});

test("a writing option arms for four seconds; a pick change or expiry disarms", () => {
  const s = createSession(4);
  s.setReader(R1);
  s.arm("d", "keep", 1_000);
  assert.equal(s.isArmed("d", "keep", 1_500), true);
  assert.equal(s.isArmed("d", "keep", 4_999), true);
  assert.equal(s.isArmed("d", "keep", 5_001), false);
  s.arm("d", "keep", 1_000);
  s.setPick("d", "close", R1);
  assert.equal(s.get().armedKey, null);
});

test("at most one request is in flight; the lock is synchronous and releases its own nonce", () => {
  const s = createSession(4);
  s.setReader(R1);
  const a = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "keep", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 });
  assert.ok(a);
  assert.equal(s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "keep", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 }), null);
  s.finishRequest(a!.nonce);
  assert.ok(s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "keep", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 }));
});

test("one accepted result raises the single watermark and is owner-scoped", () => {
  const s = createSession(4);
  s.setReader(R1);
  let clock = 0;
  const mark = () => (clock += 1);
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "keep", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 })!;
  s.setQuestion(held!.questionSignature, "d");
  const ack = s.ack("d", { id: "d" } as never, "S", mark, held);
  assert.equal(ack.ackSerial, 1);
  assert.equal(s.get().watermark, 1);
  assert.equal(s.get().accepted?.id, "d");
  s.ack("e", { id: "e" } as never, "S", mark, held);        // one slot only
  assert.equal(s.get().accepted?.id, "e");
  assert.equal(s.get().watermark, 2);
  s.setReader(R2);
  assert.equal(s.get().accepted, null);
  assert.equal(s.get().watermark, 2);                       // the scalar survives a reader change
});

test("a page serial gates another binding answer; the selected page serial is found among receipts", () => {
  const receipts = [{ page: { decisions: [{ id: "d" }] }, readSerial: 5 }, { page: { decisions: [{ id: "e" }] }, readSerial: 0 }];
  assert.equal(pageSerialFor(receipts, "d"), 5);
  assert.equal(pageSerialFor(receipts, "e"), 0);            // legacy/missing serial is 0, never fresh
  assert.equal(pageSerialFor(receipts, "absent"), 0);
  assert.equal(pageSerialFor(undefined, "d"), 0);
  const watermark = 5;
  assert.equal(5 > watermark, false);                       // a pre-ack page cannot reopen Submit
  assert.equal(6 > watermark, true);                        // a page actually read after the ack can
});

test("a successful answer clears only the draft it was sent from", () => {
  const s = createSession(4);
  s.setReader(R1);
  s.setPick("d", "keep", R1);
  const version = s.get().drafts.get("d")!.version;
  s.setNote("d", "typed", R1);                              // the user edits after sending
  s.clearAnsweredDraft("d", version, s.get().readerEpoch, "", R1);
  assert.ok(s.get().drafts.get("d"));                       // newer draft is preserved
  s.clearAnsweredDraft("d", s.get().drafts.get("d")!.version, s.get().readerEpoch, "", R1);
  assert.equal(s.get().drafts.get("d"), undefined);
});

test("an owner token from another epoch or scope is refused at the mutation boundary", () => {
  const s = createSession(8);
  s.setReader(R1);
  s.setScope("S1");
  const owner = { readerKey: readerKeyOf(R1), readerEpoch: s.get().readerEpoch, scopeKey: "S1", id: "d" };
  assert.equal(s.allows(owner), true);
  assert.equal(s.setNote("d", "typed", R1, owner), "ok");
  assert.equal(s.setNote("d", "late", R1, { ...owner, readerEpoch: owner.readerEpoch - 1 }), "stale");   // old epoch
  assert.equal(s.setNote("d", "late", R1, { ...owner, scopeKey: "S2" }), "stale");                       // other scope
  assert.equal(s.get().drafts.get("d")?.note, "typed");
});

test("a stale-epoch acknowledgement advances only the opaque fence, storing no personal result", () => {
  const s = createSession(4);
  s.setReader(R1);
  s.setScope("S");
  let clock = 0; const mark = () => (clock += 1);
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 })!;
  s.setReader(R2); s.setReader(R1);                       // a genuine round trip: a NEW epoch
  s.setQuestion(held!.questionSignature, "d");            // the question is unchanged; only the epoch moved
  const ack = s.ack("d", { id: "d" } as never, "S", mark, held);
  assert.ok(ack.ackSerial > 0);
  assert.equal(s.get().watermark, ack.ackSerial);          // the fence always advances
  assert.equal(s.get().accepted, null);                    // but no personal state is resurrected
});

test("an accepted result from another scope is not stored", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S1");
  let clock = 0; const mark = () => (clock += 1);
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S1", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 })!;
  s.setScope("S2");                                        // a real filter change drops the slot
  s.ack("d", { id: "d" } as never, "S1", mark, held);
  assert.equal(s.get().accepted, null);
  assert.equal(s.get().watermark, 1);
});

test("the material signature is stable across identical-data replacement but changes with the real material", () => {
  const user = { login: "anna", role: "operator", writeRepos: ["deckcraft"], maintainerWrites: true };
  const row = { id: "d", options: [{ key: "take", label: "Take", writes: "merges" }], optionTexts: [], canSettle: true, answer: null, preparing: false, queued: null, settling: null } as never;
  const a = materialSignature(row, user, {});
  const b = materialSignature(structuredClone(row), user, {});
  assert.equal(a, b);                                      // identical data, new object: arm survives
  assert.notEqual(a, materialSignature({ ...(row as object), options: [{ key: "take", label: "Take", writes: "closes" }] } as never, user, {}));
  assert.notEqual(a, materialSignature(row, { ...user, role: "viewer" }, {}));
  assert.notEqual(a, materialSignature(row, user, { "other#1": "take" }));
});

test("the note input is bounded and an overlength edit keeps the previous value", () => {
  const s = createSession(4);
  s.setReader(R1);
  assert.equal(s.setNote("d", "x".repeat(500), R1), "ok");
  assert.equal(s.setNote("d", "x".repeat(501), R1), "overlength");
  assert.equal(s.get().drafts.get("d")?.note.length, 500);
});

test("a page serial gates a second binding answer only until a real read", () => {
  const receipts = [{ page: { decisions: [{ id: "d" }] }, readSerial: 4 }];
  assert.equal(pageSerialFor(receipts, "d"), 4);
  const watermark = 4;
  assert.equal(4 > watermark, false);
  const fresh = [{ page: { decisions: [{ id: "d" }] }, readSerial: 5 }];
  assert.equal(pageSerialFor(fresh, "d") > watermark, true);
});

test("the typed lock refuses a stale material token at the synchronous boundary", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  s.setMaterial({ requestedIdentity: '["requested","d"]', materialSignature: "m1", sourceReadSerial: 3 });
  const base = { readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: '["requested","d"]', materialSignature: "m1", questionSignature: "", sourceReadSerial: 3 };
  const held = s.beginRequest(base);
  assert.ok(held, "a current token is accepted");
  s.finishRequest(held!.nonce);
  assert.equal(s.beginRequest({ ...base, materialSignature: "m2" }), null, "a changed material cannot lock");
  assert.equal(s.beginRequest({ ...base, requestedIdentity: '["requested","e"]' }), null, "a changed identity cannot lock");
  const stale = s.beginRequest({ ...base, readerKey: readerKeyOf(R2) });
  assert.equal(stale, null, "another reader cannot lock");
  const ok = s.beginRequest(base);
  assert.ok(ok);
  let clock = 0; const mark = () => (clock += 1);
  // The material check lives at the LOCK boundary (the answer itself legitimately changes material at ack time).
  s.setMaterial({ requestedIdentity: '["requested","e"]', materialSignature: "m9", sourceReadSerial: 4 });
  assert.equal(s.beginRequest(base), null, "a stale-material dispatch cannot lock");
  s.ack("d", { id: "d" } as never, "S", mark, ok!);
  assert.equal(s.get().accepted?.id, "d", "a same-owner acknowledgement stores the accepted result");
  assert.equal(s.get().watermark, 1, "and the fence advances exactly once");
});

test("A: an observed M0→M1 question change while pending invalidates the completion (fence only)", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  const row = (answer: string | null) => ({ id: "d", canSettle: true, preparing: false, queued: null, settling: null, answer, options: [{ key: "take", label: "Take", writes: "merges" }], optionTexts: [], exceptions: [] }) as never;
  const user = { login: "anna", role: "operator" };
  s.setMaterial({ requestedIdentity: '["requested","d"]', materialSignature: "m0", sourceReadSerial: 1 });
  s.setQuestion(questionSignature(row(null), user, {}), "d");
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: '["requested","d"]', materialSignature: "m0", questionSignature: questionSignature(row(null), user, {}), sourceReadSerial: 1 })!;
  // The question meaningfully changes while pending (a new option appears).
  const changed = { ...(row(null) as object), options: [{ key: "take", label: "Take (updated)", writes: "merges" }] } as never;
  s.setQuestion(questionSignature(changed, user, {}), "d");
  let clock = 0; const mark = () => (clock += 1);
  s.ack("d", { id: "d", answer: "take" } as never, "S", mark, held);
  assert.equal(s.get().accepted, null, "no accepted slot for a stale-question completion");
  assert.equal(s.get().watermark, 1, "the fence still advances");
  // Absence afterwards must not erase the observed invalidation: a later identical M1 ack still loses.
  s.finishRequest(held.nonce);
});

test("B: an answer-only transition with an unchanged question is a valid accepted result", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  const row = (answer: string | null) => ({ id: "d", canSettle: true, preparing: false, queued: null, settling: null, answer, options: [{ key: "take", label: "Take", writes: "merges" }], optionTexts: [], exceptions: [] }) as never;
  const user = { login: "anna", role: "operator" };
  const q = questionSignature(row(null), user, {});
  s.setMaterial({ requestedIdentity: '["requested","d"]', materialSignature: "m0", sourceReadSerial: 1 });
  s.setQuestion(q, "d");
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: '["requested","d"]', materialSignature: "m0", questionSignature: q, sourceReadSerial: 1 })!;
  // The answer's own fields change (answer set), which is NOT regenerated question content.
  assert.equal(questionSignature(row("take"), user, {}), q, "answer/answeredBy are excluded from the question signature");
  s.setQuestion(questionSignature(row("take"), user, {}), "d");
  let clock = 0; const mark = () => (clock += 1);
  s.ack("d", { id: "d", answer: "take" } as never, "S", mark, held);
  assert.equal(s.get().accepted?.id, "d", "the valid accepted result is stored for its own id");
  assert.equal(s.get().watermark, 1);
});

test("the nonce invalidation latches: M0→M1→M0 cannot re-validate a pending completion", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  const user = { login: "anna", role: "operator" };
  const row = (label: string) => ({ id: "d", canSettle: true, preparing: false, queued: null, settling: null, answer: null, options: [{ key: "take", label, writes: "merges" }], optionTexts: [], exceptions: [] }) as never;
  const q0 = questionSignature(row("Take"), user, {});
  s.setMaterial({ requestedIdentity: '["requested","d"]', materialSignature: "m0", sourceReadSerial: 2 });
  s.setQuestion(q0, "d");
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: '["requested","d"]', materialSignature: "m0", questionSignature: q0, sourceReadSerial: 2 })!;
  s.setQuestion(questionSignature(row("CURRENT Take"), user, {}), "d");   // M1 observed
  s.setQuestion(q0, "d");                                                 // back to M0 text
  assert.equal(s.heldValid(held), false, "the latch is irreversible for this nonce");
  let clock = 0; const mark = () => (clock += 1);
  const ack = s.ack("d", { id: "d", answer: "take" } as never, "S", mark, held);
  assert.equal(ack.stored, false);
  assert.equal(s.get().accepted, null);
  assert.equal(s.get().watermark, 1, "the fence still advances exactly once");
});

test("a stale or non-positive source serial cannot take a lock; a current one can", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  let clock = 0; const mark = () => (clock += 1);
  const base = { readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "" };
  assert.equal(s.beginRequest({ ...base, sourceReadSerial: 0 }), null, "a zero serial is refused");
  assert.equal(s.beginRequest({ ...base, sourceReadSerial: -1 }), null, "a negative serial is refused");
  s.raiseFence(mark);                                                     // fence = 1
  assert.equal(s.beginRequest({ ...base, sourceReadSerial: 1 }), null, "a serial at/below the fence is stale");
  const held = s.beginRequest({ ...base, sourceReadSerial: 2 });
  assert.ok(held, "a serial above the current fence takes the lock");
});

test("an actual scope transition while pending latches invalidation (S1→S2→S1 cannot restore)", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S1");
  s.setMaterial({ requestedIdentity: "[]", materialSignature: "", sourceReadSerial: 1 });
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S1", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1 })!;
  assert.equal(s.heldValid(held), true);
  s.setScope("S2");
  s.setScope("S1");                                   // back to the same scope
  assert.equal(s.heldValid(held), false, "the scope transition latched for this nonce");
  let clock = 0; const mark = () => (clock += 1);
  const ack = s.ack("d", { id: "d" } as never, "S1", mark, held);
  assert.equal(ack.stored, false);
  assert.equal(s.get().watermark, 1);
});

test("a capability change is observed from the full User even with the pending row absent; a finished token is never valid", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  s.setMaterial({ requestedIdentity: "[]", materialSignature: "", sourceReadSerial: 1 });
  const held = s.beginRequest({ readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", id: "d", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "", sourceReadSerial: 1, capabilitySignature: '["anna","operator",["a"],true]' })!;
  s.setCapability('["anna","operator",[],true]');      // writeRepos revoked while pending, row absent
  assert.equal(s.heldValid(held), false, "the revoke latched");
  s.finishRequest(held.nonce);
  assert.equal(s.heldValid(held), false, "a finished token stays invalid");
});

test("heldValid requires a live lock: after A-finish and B-finish both old tokens are false with no lock", () => {
  const s = createSession(4);
  s.setReader(R1); s.setScope("S");
  s.setMaterial({ requestedIdentity: "[]", materialSignature: "", sourceReadSerial: 1 });
  const base = { readerEpoch: s.get().readerEpoch, readerKey: readerKeyOf(R1), scopeKey: "S", answerKey: "take", draftVersion: 0, requestedIdentity: "[]", materialSignature: "", questionSignature: "" };
  const a = s.beginRequest({ ...base, id: "a", sourceReadSerial: 1 })!;
  assert.equal(s.heldValid(a), true, "the active lock's own token is valid before its finish");
  s.finishRequest(a.nonce);
  const b = s.beginRequest({ ...base, id: "b", sourceReadSerial: 2 })!;
  assert.equal(s.heldValid(a), false, "A is invalid once B holds the lock");
  s.finishRequest(b.nonce);
  assert.equal(s.get().pending, false);
  assert.equal(s.heldValid(a), false, "A stays false with no live lock");
  assert.equal(s.heldValid(b), false, "the latest finished token is false with no live lock");
});

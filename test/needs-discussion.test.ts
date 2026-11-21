import test from "node:test";
import assert from "node:assert/strict";
import {
  discussionModel,
} from "../web/src/modules/decisions/discussion.ts";

const dec = (over: Record<string, unknown> = {}) => ({
  id: "designcraft#10:scope", options: [{ key: "take", label: "In scope: take it" }, { key: "close", label: "Out of scope: close" }],
  opinions: [], ...over,
}) as never;
const op = (over: Record<string, unknown> = {}) => ({ id: "o1", login: "anna", option: "take", note: "note", at: "t1", permission: "write", ...over }) as never;
const cm = (over: Record<string, unknown> = {}) => ({ id: "c1", login: "ben", at: "t2", body: "hello", ...over }) as never;





test("model: opinion rows keep native order and every row", () => {
  const m = discussionModel(dec({ opinions: [op(), op({ id: "o2", login: "cara" }), op({ id: "o3", login: "dan" })] }), []);
  assert.deepEqual(m.opinions.map((o) => o.login), ["anna", "cara", "dan"]);
});

test("model: keys stay unique for duplicate native ids, logins and times", () => {
  const m = discussionModel(dec({ opinions: [op(), op()] }), [cm(), cm()]);
  assert.equal(new Set(m.opinions.map((o) => o.key)).size, 2);
  assert.equal(new Set(m.comments.map((c) => c.key)).size, 2);
});


test("model: an unknown option key keeps the key and invents no label", () => {
  const m = discussionModel(dec({ opinions: [op({ option: "gone" })] }), []);
  assert.equal(m.opinions[0].optionKey, "gone");
  assert.equal(m.opinions[0].optionLabel, null);
});

test("model: a null option key has no label", () => {
  const m = discussionModel(dec({ opinions: [op({ option: null })] }), []);
  assert.equal(m.opinions[0].optionKey, null);
  assert.equal(m.opinions[0].optionLabel, null);
});



test("model: an unknown permission value never implies granted access", () => {
  const m = discussionModel(dec({ opinions: [op({ permission: "weird" })] }), []);
  assert.equal(m.opinions[0].permissionGranted, false);
  assert.match(m.opinions[0].permissionLabel, /Permission: weird/);
});


test("model: a null note is no note and not 'unavailable'", () => {
  const m = discussionModel(dec({ opinions: [op({ note: null })] }), []);
  assert.equal(m.opinions[0].note, null);
  assert.equal(m.opinions[0].noteUnavailable, false);
});

test("model: a whitespace note is honestly unavailable, not blank text", () => {
  const m = discussionModel(dec({ opinions: [op({ note: "   " })] }), []);
  assert.equal(m.opinions[0].noteUnavailable, true);
});

test("model: comment text is preserved including line breaks", () => {
  const m = discussionModel(dec(), [cm({ body: "line one\nline two" })]);
  assert.equal(m.comments[0].body, "line one\nline two");
  assert.equal(m.comments[0].unavailable, false);
});

test("model: an empty comment body is unavailable without a guessed reason", () => {
  const m = discussionModel(dec(), [cm({ body: "" })]);
  assert.equal(m.comments[0].unavailable, true);
  assert.equal(m.comments[0].body, "");
});

test("model: empty is true only when both groups are empty", () => {
  assert.equal(discussionModel(dec(), []).empty, true);
  assert.equal(discussionModel(dec({ opinions: [op()] }), []).empty, false);
  assert.equal(discussionModel(dec(), [cm()]).empty, false);
});

test("model: the empty comments array used while pending is not a comment state claim by itself", () => {
  const m = discussionModel(dec({ opinions: [op()] }), []);
  assert.equal(m.comments.length, 0);
  assert.equal(m.empty, false);
});

test("model: 120 comments and 60 opinions all survive", () => {
  const opinions = Array.from({ length: 60 }, (_, i) => op({ id: `o${i}` }));
  const comments = Array.from({ length: 120 }, (_, i) => cm({ id: `c${i}` }));
  const m = discussionModel(dec({ opinions }), comments);
  assert.equal(m.opinions.length, 60);
  assert.equal(m.comments.length, 120);
  assert.equal(new Set(m.comments.map((c) => c.key)).size, 120);
});

test("model: long unbroken text is preserved as-is", () => {
  const long = "x".repeat(500);
  assert.equal(discussionModel(dec(), [cm({ body: long })]).comments[0].body, long);
});

test("model: timestamps are preserved verbatim rather than reformatted", () => {
  const at = "2026-10-30T02:10:00.000Z";
  assert.equal(discussionModel(dec({ opinions: [op({ at })] }), [cm({ at })]).opinions[0].at, at);
  assert.equal(discussionModel(dec(), [cm({ at })]).comments[0].at, at);
});

test("model: opinions and comments stay separate groups", () => {
  const m = discussionModel(dec({ opinions: [op()] }), [cm()]);
  assert.equal(m.opinions.length, 1);
  assert.equal(m.comments.length, 1);
});

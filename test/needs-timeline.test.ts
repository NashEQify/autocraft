import test from "node:test";
import assert from "node:assert/strict";
import type { Decision, ItemPageData, TimelineEntry } from "../web/src/api/types.ts";
import {
  timelineModel, timelineReadState, timelineReference,
} from "../web/src/modules/decisions/timeline.ts";

const ref = { repo: "designcraft", number: 17 };
const entry = (index: number, patch: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: `event-${index}`, text: `Event ${index}`, actor: "AutoCraft", at: String(index).padStart(4, "0"),
  kind: "harness", icon: "job", tone: "neutral", costUsd: null, major: false, jobId: null,
  reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null,
  markdown: false, lines: [], feedback: null, ...patch,
});
// A structural ItemPageData fixture for the pure gate's declared fields, not a mock of the native hook.
const page = (timeline: TimelineEntry[] = [], patch: Partial<ItemPageData> = {}): ItemPageData => ({
  ...ref, timeline, ...patch,
}) as ItemPageData;
const own = (repo: unknown, number: unknown) => ({ repo, number }) as Pick<Decision, "repo" | "number">;

// These tests establish pure helper behavior only. Native observers, escaping, role boundaries and no-model-on-error
// require actual UI evidence; no unit mirror counter here claims to prove them.

test("U01 reference.own-issue-pr", () => {
  const issue = { ...ref, shown: { kind: "issue", state: "open", title: "Issue" } };
  const pr = { ...ref, shown: { kind: "pr", state: "open", title: "Pull request" } };
  assert.deepEqual(timelineReference(issue), ref);
  assert.deepEqual(timelineReference(pr), ref);
  assert.deepEqual(timelineReference({ ...ref, number: 1 }), { repo: ref.repo, number: 1 });
});

test("U02 reference.invalid-number", () => {
  for (const number of [null, undefined, 0, -1, 1.5, NaN, Infinity, -Infinity, "17", true]) {
    assert.equal(timelineReference(own(ref.repo, number)), null, `invalid number ${String(number)}`);
  }
});

test("U03 reference.invalid-repo", () => {
  for (const repo of ["", "  \n\t", null, undefined, 17]) assert.equal(timelineReference(own(repo, 17)), null);
  const original = " designcraft ";
  assert.deepEqual(timelineReference(own(original, 17)), { repo: original, number: 17 }, "validity checking must not rewrite the supplied ref");
});

test("U04 reference.no-member-guess", () => {
  const memberOnly = {
    repo: "designcraft", number: null,
    items: [{ repo: "othercraft", number: 99 }], group: [{ repo: "thirdcraft", number: 100 }],
    related: [{ repo: "fourthcraft", number: 101 }], id: "othercraft#99", title: "othercraft#99",
  };
  assert.equal(timelineReference(memberOnly), null);
  const denied = { ...ref };
  for (const field of ["items", "group", "related", "id", "title", "shown", "kind"]) {
    Object.defineProperty(denied, field, { get() { throw new Error(`unexpected member access: ${field}`); } });
  }
  assert.deepEqual(timelineReference(denied), ref);
});







test("short supplied histories keep their supplied order", () => {
  assert.deepEqual(timelineModel([entry(1), entry(2)]).rows.map((r) => r.text), ["Event 1", "Event 2"]);
});

test("U12 model.more-than-four", () => {
  const rows = timelineModel(Array.from({ length: 7 }, (_, i) => entry(i))).rows;
  assert.deepEqual(rows.map((r) => r.text), ["Event 3", "Event 4", "Event 5", "Event 6"]);
  assert.deepEqual(rows.map((r) => r.key), ['[3,"event-3"]', '[4,"event-4"]', '[5,"event-5"]', '[6,"event-6"]']);
});


test("U14 model.tie-order", () => {
  const at = "2026-11-17T14:00:00.000Z";
  const input = ["a", "b", "c", "d", "e"].map((id, i) => entry(i, { id, text: id, at }));
  const rows = timelineModel(input).rows;
  assert.deepEqual(rows.map((r) => r.text), ["b", "c", "d", "e"]);
  assert.deepEqual(rows.map((r) => r.at), [at, at, at, at]);
});

test("U15 model.exact-duplicates", () => {
  const duplicate = entry(1, { id: "same", text: "same", actor: "same", at: "same" });
  const rows = timelineModel([duplicate, duplicate, duplicate, duplicate, duplicate, duplicate]).rows;
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((r) => r.key)).size, 4);
  assert.deepEqual(rows.map((r) => r.key), ['[2,"same"]', '[3,"same"]', '[4,"same"]', '[5,"same"]']);
  assert.ok(rows.every((r) => r.text === "same" && r.actor === "same" && r.at === "same"));
});


test("U17 model.source-immutable", () => {
  const input = Object.freeze(Array.from({ length: 7 }, (_, i) => Object.freeze(entry(i))));
  const before = JSON.stringify(input);
  const model = timelineModel(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(input.map((e) => e.id), ["event-0", "event-1", "event-2", "event-3", "event-4", "event-5", "event-6"]);
  assert.notEqual(model.rows[0], input[3]);
  assert.deepEqual(model.rows.map((r) => r.text), ["Event 3", "Event 4", "Event 5", "Event 6"]);
});




test("U21 model.rich-fields-ignored", () => {
  const headline = { id: "private-id", text: "Allowed headline", actor: "Allowed actor", at: "Allowed time", costUsd: 0.125 };
  for (const field of ["body", "lines", "calls", "markdown", "feedback", "jobId", "reviewId", "githubId", "commit", "preapproval", "icon", "tone", "major", "kind"]) {
    Object.defineProperty(headline, field, { get() { throw new Error(`rich field read: ${field}`); } });
  }
  const rows = timelineModel([headline as TimelineEntry]).rows;
  assert.deepEqual(rows, [{ key: '[0,"private-id"]', text: "Allowed headline", actor: "Allowed actor", at: "Allowed time", costUsd: 0.125 }]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["actor", "at", "costUsd", "key", "text"]);
});


test("U23 read.error-data", () => {
  const data = page([entry(1)]);
  assert.equal(timelineReadState(ref, { data, loading: false, error: "private failure detail" }), "error");
});

test("U24 read.blank-error", () => {
  assert.equal(timelineReadState(ref, { data: page([entry(1)]), loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: "" }), "error", "a defined error wins even over loading");
});

test("U25 read.waiting", () => {
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: undefined }), "waiting");
});

test("U26 read.success-empty", () => {
  const data = page();
  assert.equal(timelineReadState(ref, { data, loading: false, error: undefined }), "ready");
  assert.deepEqual(timelineModel(data.timeline), { rows: [], empty: true });
});

test("U27 read.success-data", () => {
  const data = page([entry(1), entry(2)]);
  assert.equal(timelineReadState(ref, { data, loading: false, error: undefined }), "ready");
});

test("U28 read.timeline-unavailable", () => {
  for (const timeline of [undefined, null, "[]", {}, 0]) {
    const data = { ...ref, timeline } as ItemPageData;
    assert.equal(timelineReadState(ref, { data, loading: false, error: undefined }), "error");
  }
  const missing = { ...ref } as ItemPageData;
  assert.equal(timelineReadState(ref, { data: missing, loading: false, error: undefined }), "error");
});

test("U29 read.defensive-unreachable", () => {
  // These are defensive helper inputs, NOT native completed-mismatch evidence: the hook reports waiting for that case.
  assert.equal(timelineReadState(ref, { data: undefined, loading: false, error: undefined }), "error");
  assert.equal(timelineReadState(ref, { data: page([], { repo: "othercraft" }), loading: false, error: undefined }), "error");
  assert.equal(timelineReadState(ref, { data: page([], { number: 18 }), loading: false, error: undefined }), "error");
});

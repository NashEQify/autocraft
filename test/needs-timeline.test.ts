import test from "node:test";
import assert from "node:assert/strict";
import type { Decision, ItemPageData, TimelineEntry } from "../web/src/api/types.ts";
import {
  changeTimelineOpen, timelineModel, timelineReadState, timelineReference,
  TIMELINE_EVENT_LIMIT, TIMELINE_OPEN_LIMIT, TIMELINE_READ_ERROR,
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

test("U05 open.immutable-add-close", () => {
  const before: ReadonlySet<string> = new Set(["A"]);
  const opened = changeTimelineOpen(before, "B", true);
  assert.notEqual(opened, before);
  assert.deepEqual([...before], ["A"]);
  assert.deepEqual([...opened], ["A", "B"]);
  const closed = changeTimelineOpen(opened, "A", false);
  assert.notEqual(closed, opened);
  assert.deepEqual([...closed], ["B"]);
  assert.deepEqual([...opened], ["A", "B"]);
});

test("U06 open.identity-noops", () => {
  const ids: ReadonlySet<string> = new Set(["A"]);
  assert.equal(changeTimelineOpen(ids, "A", true), ids);
  assert.equal(changeTimelineOpen(ids, "absent", false), ids);
  assert.equal(changeTimelineOpen(ids, "", true), ids);
  assert.equal(changeTimelineOpen(ids, "", false), ids);
  const empty: ReadonlySet<string> = new Set();
  assert.equal(changeTimelineOpen(empty, "absent", false), empty);
});

test("U07 open.limit512", () => {
  assert.equal(TIMELINE_OPEN_LIMIT, 512);
  let ids: ReadonlySet<string> = new Set();
  for (let i = 0; i < 512; i++) ids = changeTimelineOpen(ids, `d${i}`, true);
  assert.equal(ids.size, 512);
  const before = ids;
  const next = changeTimelineOpen(ids, "d512", true);
  assert.equal(next.size, 512);
  assert.equal(next.has("d0"), false);
  assert.equal(next.has("d1"), true);
  assert.equal(next.has("d511"), true);
  assert.equal(next.has("d512"), true);
  assert.equal(before.has("d0"), true);
  assert.equal(before.has("d512"), false);
});

test("U08 open.redundant-age", () => {
  const ids: ReadonlySet<string> = new Set(Array.from({ length: 512 }, (_, i) => `d${i}`));
  const repeated = changeTimelineOpen(ids, "d0", true);
  assert.equal(repeated, ids);
  const next = changeTimelineOpen(repeated, "new", true);
  assert.equal(next.has("d0"), false);
  assert.equal(next.has("d1"), true);
  assert.equal(next.has("new"), true);
});

test("U09 open.close-reopen-age", () => {
  const ids: ReadonlySet<string> = new Set(Array.from({ length: 512 }, (_, i) => `d${i}`));
  const closed = changeTimelineOpen(ids, "d0", false);
  const reopened = changeTimelineOpen(closed, "d0", true);
  assert.equal(reopened.size, 512);
  assert.equal([...reopened].at(-1), "d0");
  const next = changeTimelineOpen(reopened, "new", true);
  assert.equal(next.has("d1"), false);
  assert.equal(next.has("d0"), true);
  assert.equal(next.has("new"), true);
});

test("U10 model.empty", () => {
  assert.equal(TIMELINE_EVENT_LIMIT, 4);
  const input: TimelineEntry[] = [];
  const model = timelineModel(input);
  assert.deepEqual(model, { rows: [], empty: true });
  assert.notEqual(model.rows, input);
  assert.throws(() => timelineModel(undefined as unknown as TimelineEntry[]), "a missing read is not an empty-success fallback");
});

test("U11 model.one-to-four", () => {
  assert.deepEqual(timelineModel([entry(1)]).rows.map((r) => r.text), ["Event 1"]);
  assert.deepEqual(timelineModel([entry(1), entry(2)]).rows.map((r) => r.text), ["Event 2", "Event 1"]);
  assert.deepEqual(timelineModel([entry(1), entry(2), entry(3)]).rows.map((r) => r.text), ["Event 3", "Event 2", "Event 1"]);
  const four = timelineModel([entry(1), entry(2), entry(3), entry(4)]);
  assert.deepEqual(four.rows.map((r) => r.text), ["Event 4", "Event 3", "Event 2", "Event 1"]);
  assert.equal(four.empty, false);
});

test("U12 model.more-than-four", () => {
  const rows = timelineModel(Array.from({ length: 7 }, (_, i) => entry(i))).rows;
  assert.deepEqual(rows.map((r) => r.text), ["Event 6", "Event 5", "Event 4", "Event 3"]);
  assert.deepEqual(rows.map((r) => r.key), ['[6,"event-6"]', '[5,"event-5"]', '[4,"event-4"]', '[3,"event-3"]']);
});

test("U13 model.more-than-200", () => {
  const rows = timelineModel(Array.from({ length: 205 }, (_, i) => entry(i))).rows;
  assert.deepEqual(rows.map((r) => r.text), ["Event 204", "Event 203", "Event 202", "Event 201"]);
  assert.equal(rows[0]!.key, '[204,"event-204"]');
});

test("U14 model.tie-order", () => {
  const at = "2026-11-17T14:00:00.000Z";
  const input = ["a", "b", "c", "d", "e"].map((id, i) => entry(i, { id, text: id, at }));
  const rows = timelineModel(input).rows;
  assert.deepEqual(rows.map((r) => r.text), ["e", "d", "c", "b"]);
  assert.deepEqual(rows.map((r) => r.at), [at, at, at, at]);
});

test("U15 model.exact-duplicates", () => {
  const duplicate = entry(1, { id: "same", text: "same", actor: "same", at: "same" });
  const rows = timelineModel([duplicate, duplicate, duplicate, duplicate, duplicate, duplicate]).rows;
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((r) => r.key)).size, 4);
  assert.deepEqual(rows.map((r) => r.key), ['[5,"same"]', '[4,"same"]', '[3,"same"]', '[2,"same"]']);
  assert.ok(rows.every((r) => r.text === "same" && r.actor === "same" && r.at === "same"));
});

test("U16 model.key-exact", () => {
  const id = 'odd|:[]"\\\n';
  const rows = timelineModel([entry(0), entry(1, { id }), entry(2, { id })]).rows;
  assert.equal(rows[0]!.key, JSON.stringify([2, id]));
  assert.equal(rows[1]!.key, JSON.stringify([1, id]));
  assert.notEqual(rows[0]!.key, rows[1]!.key);
});

test("U17 model.source-immutable", () => {
  const input = Object.freeze(Array.from({ length: 7 }, (_, i) => Object.freeze(entry(i))));
  const before = JSON.stringify(input);
  const model = timelineModel(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(input.map((e) => e.id), ["event-0", "event-1", "event-2", "event-3", "event-4", "event-5", "event-6"]);
  assert.notEqual(model.rows[0], input[6]);
  assert.deepEqual(model.rows.map((r) => r.text), ["Event 6", "Event 5", "Event 4", "Event 3"]);
});

test("U18 model.include-conversations", () => {
  const input = [
    entry(0),
    entry(1, { kind: "harness", icon: "job", major: false }),
    entry(2, { kind: "person", icon: "chat", major: false, text: "A supplied conversation" }),
    entry(3, { kind: "opus", icon: "chat", major: false, text: "A supplied reply headline" }),
    entry(4, { kind: "harness", icon: "check", major: false }),
  ];
  assert.deepEqual(timelineModel(input).rows.map((r) => r.text), ["Event 4", "A supplied reply headline", "A supplied conversation", "Event 1"]);
});

test("U19 model.scalar-truth", () => {
  const text = "  First line\nSecond line  ";
  const actor = "  <person> · @name\n  ";
  const at = "  not a parsed date\n  ";
  const row = timelineModel([entry(0, { text, actor, at })]).rows[0]!;
  assert.equal(row.text, text);
  assert.equal(row.actor, actor);
  assert.equal(row.at, at);
  // Fallback is owned by the actual JSX renderer, not this pure raw-scalar model; B22 proves each fallback.
  const blanks = timelineModel([entry(0, { text: "", actor: " \t", at: "\n" })]).rows[0]!;
  assert.equal(blanks.text, "");
  assert.equal(blanks.actor, " \t");
  assert.equal(blanks.at, "\n");
});

test("U20 model.long-values", () => {
  const text = "x".repeat(16000);
  const actor = "actor".repeat(2000);
  const at = "timestamp".repeat(1000);
  const row = timelineModel([entry(0, { text, actor, at })]).rows[0]!;
  assert.equal(row.text, text);
  assert.equal(row.actor, actor);
  assert.equal(row.at, at);
});

test("U21 model.rich-fields-ignored", () => {
  const headline = { id: "private-id", text: "Allowed headline", actor: "Allowed actor", at: "Allowed time" };
  for (const field of ["body", "lines", "calls", "markdown", "feedback", "costUsd", "jobId", "reviewId", "githubId", "commit", "preapproval", "icon", "tone", "major", "kind"]) {
    Object.defineProperty(headline, field, { get() { throw new Error(`rich field read: ${field}`); } });
  }
  const rows = timelineModel([headline as TimelineEntry]).rows;
  assert.deepEqual(rows, [{ key: '[0,"private-id"]', text: "Allowed headline", actor: "Allowed actor", at: "Allowed time" }]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["actor", "at", "key", "text"]);
});

test("U22 model.latest-not-current-head", () => {
  const row = timelineModel([entry(0, {
    text: "As supplied: review recorded", actor: "Mirror", at: "source stamp",
    commit: "not-current-head", reviewId: "review-1", icon: "review", tone: "bad", major: true,
  })]).rows[0]!;
  assert.deepEqual(row, { key: '[0,"event-0"]', text: "As supplied: review recorded", actor: "Mirror", at: "source stamp" });
});

test("U23 read.error-data", () => {
  const data = page([entry(1)]);
  assert.equal(timelineReadState(ref, { data, loading: false, error: "private failure detail" }), "error");
  assert.equal(TIMELINE_READ_ERROR, "Could not read the item timeline. The decision and your draft are unaffected.");
  // This is disposition evidence ONLY; actual UI branch/no-projection proof belongs to B09.
});

test("U24 read.blank-error", () => {
  assert.equal(timelineReadState(ref, { data: page([entry(1)]), loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: "" }), "error", "a defined error wins even over loading");
});

test("U25 read.waiting", () => {
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: undefined }), "waiting");
  // Native hook-hidden wrong-ref has precisely this public shape; actual raw response behavior needs B08.
  const reported = { data: undefined, loading: true, error: undefined };
  assert.equal(timelineReadState(ref, reported), "waiting");
});

test("U26 read.success-empty", () => {
  const data = page();
  assert.equal(timelineReadState(ref, { data, loading: false, error: undefined }), "ready");
  assert.deepEqual(timelineModel(data.timeline), { rows: [], empty: true });
});

test("U27 read.success-data", () => {
  const data = page([entry(1), entry(2)]);
  assert.equal(timelineReadState(ref, { data, loading: false, error: undefined }), "ready");
  assert.deepEqual(timelineModel(data.timeline).rows.map((r) => r.text), ["Event 2", "Event 1"]);
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

test("U30 read.same-key-background", () => {
  // The native hook exports no isFetching field: unchanged matching success remains usable during background work.
  const data = page([entry(1)]);
  const snapshot = Object.freeze({ data, loading: false, error: undefined });
  assert.equal(timelineReadState(ref, snapshot), "ready");
  assert.equal(timelineReadState(ref, snapshot), "ready");
  assert.equal(snapshot.data, data);
  assert.deepEqual(Object.keys(snapshot).sort(), ["data", "error", "loading"]);
  assert.equal(timelineReadState(ref, { ...snapshot, error: "background read failed" }), "error");
});

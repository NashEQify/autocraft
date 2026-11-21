import test from "node:test";
import assert from "node:assert/strict";
import { decisionEvidenceModel, itemEvidenceModel, evidenceStaff } from "../web/src/modules/decisions/evidence.ts";

const d = (over: Record<string, unknown> = {}) => ({
  id: "designcraft#3837:scope", kind: "scope", repo: "designcraft", number: 3837,
  summary: "One summary.", summaryBy: "sonnet", summaryAt: "2026-10-30T02:10:00.000Z",
  context: ["c1", "c2"], facts: ["+1 −2 · 3 files", "author: x", "CI passing", "f4", "f5", "f6", "f7", "f8"],
  risks: ["r-should-not-show-for-scope"], classifications: [], askedBy: "autocraft", askedAt: "2026-10-30T02:00:00.000Z",
  docket: "deckcraft#77", optionTexts: [], items: [], shown: null, ...over,
}) as never;




test("decision evidence: facts start at original position 2, in order, with no truncation", () => {
  const m = decisionEvidenceModel(d());
  assert.deepEqual(m.facts, ["CI passing", "f4", "f5", "f6", "f7", "f8"]);
  assert.equal(m.facts.length, 6);
});

test("decision evidence: risks are shown only for merge/close", () => {
  assert.deepEqual(decisionEvidenceModel(d()).risks, []);
  const merge = decisionEvidenceModel(d({ kind: "merge", risks: ["r1", "r2"] }));
  assert.deepEqual(merge.risks, ["r1", "r2"]);
});

test("decision evidence: every classification in native order, keyed by position (duplicates stay distinct)", () => {
  const at = "2026-10-30T02:10:00.000Z";
  const m = decisionEvidenceModel(d({
    classifications: [
      { classifier: "sonnet", at, typeLabel: "bugfix", want: "yes", reason: "first", reference: null, dupOf: null },
      { classifier: "sonnet", at, typeLabel: "small extra", want: "no", reason: "second", reference: null, dupOf: null },
      { classifier: "haiku", at, typeLabel: "infra", want: "unclear", reason: "third", reference: null, dupOf: null },
    ],
  }));
  assert.equal(m.classifiers.length, 3);
  assert.equal(new Set(m.classifiers.map((c) => c.key)).size, 3, "keys are unique even with identical classifier+at");
  assert.deepEqual(m.classifiers.map((c) => c.reason), ["first", "second", "third"]);
  assert.equal(m.classifiers[1].want, "want no");
});

test("decision evidence: summary, context, ask and docket are the decision's own, and presence is honest", () => {
  const m = decisionEvidenceModel(d());
  assert.equal(m.summary?.by, "sonnet");
  assert.deepEqual(m.context, ["c1", "c2"]);
  assert.deepEqual(m.asked, { by: "autocraft", at: "2026-10-30T02:00:00.000Z" });
  assert.equal(m.docket, "deckcraft#77");
  assert.equal(m.present, true);
  const empty = decisionEvidenceModel(d({ summary: "", context: [], facts: [], classifications: [], askedBy: "", askedAt: "", docket: null, risks: [] }));
  assert.equal(empty.present, false);
});

test("item evidence: a viewer never sees staff-only summary/why/risks, whatever the payload says", () => {
  const payload = {
    repo: "designcraft", number: 3837, kind: "pr", state: "open", title: "t", author: "a", stamp: "s",
    header: {}, status: {}, bar: {}, costUsd: 0,
    reviews: { latest: { id: "r1", head: "abc1234", current: true, at: "2026-10-30T02:00:00.000Z", trigger: "new-head", why: "why-text", verdict: "take", sure: true, summary: "sum-text", fixes: ["f"], risks: ["risk-text"], claims: [], blockedBy: [], costUsd: 3 }, earlier: [] },
    timeline: [], github: { checks: [{ name: "ci", state: "passing" }], syncedAt: "2026-10-30T03:00:00.000Z", description: "", events: [], commits: [], files: [], url: "" },
    screenshots: [], prBuild: null,
  } as never;
  const viewer = itemEvidenceModel(payload, false)!;
  assert.equal(viewer.review?.summary, null);
  assert.equal(viewer.review?.why, null);
  assert.deepEqual(viewer.review?.risks, []);
  const staff = itemEvidenceModel(payload, true)!;
  assert.equal(staff.review?.summary, "sum-text");
  assert.equal(staff.review?.why, "why-text");
  assert.deepEqual(staff.review?.risks, ["risk-text"]);
});

test("item evidence: verdict/head/current/at/trigger are readable for every role", () => {
  const payload = { kind: "pr", reviews: { latest: { id: "r", head: "abc1234", current: false, at: "at", trigger: "discussion", verdict: "take-fix", sure: false, summary: "", fixes: [], risks: [], claims: [], blockedBy: [], costUsd: 0 }, earlier: [] }, github: { checks: [], syncedAt: null } } as never;
  const viewer = itemEvidenceModel(payload, false)!;
  assert.equal(viewer.review?.verdict, "Take with fixes");
  assert.equal(viewer.review?.head, "abc1234");
  assert.equal(viewer.review?.current, false);
  assert.equal(viewer.review?.trigger, "discussion");
  assert.equal(viewer.syncedAt, null);
});

test("item evidence: kind comes from the payload, and an issue is not-applicable rather than an error", () => {
  const issue = itemEvidenceModel({ kind: "issue", reviews: { latest: null, earlier: [] }, github: { checks: [], syncedAt: null } } as never, true)!;
  assert.equal(issue.kind, "issue");
  assert.equal(issue.notApplicable, true);
  assert.equal(issue.review, null);
  const pr = itemEvidenceModel({ kind: "pr", reviews: { latest: null, earlier: [] }, github: { checks: [], syncedAt: null } } as never, true)!;
  assert.equal(pr.notApplicable, false, "a PR with no review yet is not 'not applicable'");
});



test("facts are sliced by POSITION, not by value: identical strings after position 2 still appear", () => {
  const m = decisionEvidenceModel(d({ facts: ["same", "same", "same", "same", "same"] }));
  assert.deepEqual(m.facts, ["same", "same", "same"]);
});

test("decision risks are labelled apart from item-review risks and never merged", () => {
  const merge = decisionEvidenceModel(d({ kind: "close", risks: ["decision-risk"] }));
  const payload = { kind: "pr", reviews: { latest: { id: "r", head: "h", current: true, at: "at", trigger: "new-head", verdict: "hold", sure: false, summary: "s", fixes: [], risks: ["item-risk"], claims: [], blockedBy: [], costUsd: 0 }, earlier: [] }, github: { checks: [], syncedAt: null } } as never;
  const rich = itemEvidenceModel(payload, true)!;
  assert.deepEqual(merge.risks, ["decision-risk"]);
  assert.deepEqual(rich.review?.risks, ["item-risk"]);
  assert.notDeepEqual(merge.risks, rich.review?.risks);
});

test("a scope decision shows no decision risks even when the DTO carries risk text", () => {
  assert.deepEqual(decisionEvidenceModel(d({ kind: "scope", risks: ["ignored"] })).risks, []);
});

test("classifier rows keep native order for the same classifier across different timestamps", () => {
  const rows = [
    { classifier: "sonnet", at: "t2", typeLabel: "bugfix", want: "yes", reason: "later", reference: null, dupOf: null },
    { classifier: "sonnet", at: "t1", typeLabel: "bugfix", want: "yes", reason: "earlier", reference: null, dupOf: null },
  ];
  assert.deepEqual(decisionEvidenceModel(d({ classifications: rows })).classifiers.map((c) => c.reason), ["later", "earlier"]);
});



test("item evidence is null when there is no payload at all", () => {
  assert.equal(itemEvidenceModel(undefined, true), null);
});

test("a PR payload with no review still reports its checks and sync time", () => {
  const m = itemEvidenceModel({ kind: "pr", reviews: { latest: null, earlier: [] }, github: { checks: [{ name: "ci", state: "none" }], syncedAt: "s" } } as never, true)!;
  assert.equal(m.review, null);
  assert.deepEqual(m.checks, [{ name: "ci", state: "none" }]);
  assert.equal(m.syncedAt, "s");
});

test("an unknown item kind is reported as unknown, never as a PR", () => {
  const m = itemEvidenceModel({ kind: "weird", reviews: { latest: null, earlier: [] }, github: { checks: [], syncedAt: null } } as never, true)!;
  assert.equal(m.kind, "unknown");
  assert.equal(m.notApplicable, false);
});

test("staff predicate: an operator or a maintainer sees staff fields, a viewer does not; the write flag is irrelevant", () => {
  assert.equal(evidenceStaff("operator", false), true);
  assert.equal(evidenceStaff("maintainer", false), true);
  assert.equal(evidenceStaff("maintainer", true), true);
  assert.equal(evidenceStaff("viewer", false), false);
  assert.equal(evidenceStaff("viewer", true), false, "a write flag cannot promote a viewer");
});

test("an issue payload never renders a supplied PR snapshot, even with review rows present", () => {
  const payload = { kind: "issue", reviews: { latest: { id: "r", head: "h", current: true, at: "at", trigger: "new-head", verdict: "take", sure: false, summary: "s", fixes: [], risks: ["risk"], claims: [], blockedBy: [], costUsd: 0 }, earlier: [] }, github: { checks: [{ name: "ci", state: "passing" }], syncedAt: "s" } } as never;
  const m = itemEvidenceModel(payload, true)!;
  assert.equal(m.kind, "issue");
  assert.equal(m.notApplicable, true);
  assert.equal(m.review, null, "no PR review is rendered for an issue");
  assert.deepEqual(m.checks, [], "no PR checks are rendered for an issue");
  assert.equal(m.syncedAt, null);
});

test("a maintainer without the write flag still gets the staff summary (the write flag is not the gate)", () => {
  const payload = { kind: "pr", reviews: { latest: { id: "r", head: "h", current: true, at: "at", trigger: "new-head", verdict: "take", sure: false, summary: "staff-summary", fixes: [], risks: ["staff-risk"], claims: [], blockedBy: [], costUsd: 0 }, earlier: [] }, github: { checks: [], syncedAt: null } } as never;
  const m = itemEvidenceModel(payload, evidenceStaff("maintainer", false))!;
  assert.equal(m.review?.summary, "staff-summary");
  assert.deepEqual(m.review?.risks, ["staff-risk"]);
  assert.equal(itemEvidenceModel(payload, evidenceStaff("viewer", true))?.review?.summary, null);
});

test("an unknown item kind renders no review, no checks and no fabricated state", () => {
  const m = itemEvidenceModel({ kind: "weird", reviews: { latest: { id: "r", head: "h", current: true, at: "at", trigger: "new-head", verdict: "take", sure: false, summary: "s", fixes: [], risks: [], claims: [], blockedBy: [], costUsd: 0 }, earlier: [] }, github: { checks: [{ name: "ci", state: "passing" }], syncedAt: "s" } } as never, true)!;
  assert.equal(m.kind, "unknown");
  assert.equal(m.review, null);
  assert.deepEqual(m.checks, []);
  assert.equal(m.notApplicable, false, "unknown is not the issue case");
});

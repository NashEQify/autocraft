// PR stalls: every PR that needs a person is asked (a decision) or shows a typed wait with the reason; nothing waits silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr } from "../src/core/decide.ts";
import { NOW, prFacts } from "./world.ts";

const kinds = (f: Parameters<typeof prFacts>[0]) => decidePr(prFacts(f)).actions.filter((a) => a.kind !== "unassign").map((a) => `${a.kind}${a.params?.hold ? ":hold" : ""}${a.params?.withdraw ? ":withdraw" : ""}${typeof a.params?.bucket === "string" ? `:${a.params.bucket}` : ""}`);
const cifix = (o: Record<string, unknown> = {}) => ({ states: [] as string[], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: null, skipReason: null, ...o });
const HOLD = { review: { verdict: "hold" } } as const;

test("red CI that holds the review with no take review at the head asks the contributor", () => {
  const f = { review: { verdict: "hold", head: "h0" }, ci: "failure", cifix: cifix(), reviewHold: { kind: "ci", wait: "CI on the latest commit to pass", red: true } } as const;
  assert.deepEqual(kinds(f), ["cifix:ask"]);
  const asked = decidePr(prFacts({ ...f, cifix: cifix({ states: ["asked"] }) }));
  assert.equal(asked.waitKind, "contributor");
  const skipped = decidePr(prFacts({ ...f, cifix: cifix({ states: ["skipped"], skipReason: "nothing to fix" }) }));
  assert.equal(skipped.waitKind, "person");
});

test("a CI fix whose comment failed, or did not reach GitHub after the last retry, waits on a person", () => {
  for (const c of [cifix({ states: ["comment-failed"] }), cifix({ states: ["comment-unsent", "comment-unsent", "comment-unsent"], unsent: "final" })]) {
    const p = decidePr(prFacts({ ci: "failure", cifix: c }));
    assert.deepEqual([p.actions.filter((a) => a.kind !== "unassign"), p.wait, p.waitKind], [[], "a person: the CI fix comment failed", "person"]);
  }
});

test("a PR whose label gets no review names what it waits on", () => {
  const p = decidePr(prFacts({ review: null, label: "documentation" }));
  assert.equal(p.state, "label-not-reviewed");
  assert.equal(p.waitKind, "person");
});

test("a failed or errored verification blocks the merge with the failure as the reason", () => {
  for (const state of ["failed", "error"]) {
    const p = decidePr(prFacts({ verification: { state, kind: "tests", summary: "2 tests fail", note: null } }));
    assert.equal(p.state, "needs-decision");
    assert.ok(p.reasons.some((r) => r.startsWith("verification") && r.includes("2 tests fail")));
  }
});

test("a mergeable state still unknown after GitHub was asked to compute it blocks the merge; before that the wait says how often it was asked", () => {
  const since = new Date(NOW - 10 * 3600_000).toISOString();
  const reading = decidePr(prFacts({ mergeable: "UNKNOWN", unknown: { since, reads: 3, rereads: 0, stuck: false } }));
  assert.equal(reading.state, "waiting-ci");
  assert.match(reading.wait ?? "", /3 checks reads/);
  const stuck = decidePr(prFacts({ mergeable: "UNKNOWN", unknown: { since, reads: 6, rereads: 1, stuck: true } }));
  assert.equal(stuck.state, "needs-decision");
  assert.ok(stuck.reasons.some((r) => r.includes("unknown")));
});

test("a merge refused for a reason other than CI or mergeable blocks the merge; a state refusal waits for the change", () => {
  const refused = (reason: string) => ({ lastMerge: { outcome: "refused", reason, ci: "success", mergeable: "MERGEABLE" } });
  const other = decidePr(prFacts(refused("REFUSED app#1: the PR touches a protected file")));
  assert.equal(other.state, "needs-decision");
  assert.ok(other.reasons.some((r) => r.includes("protected file")));
  const state = decidePr(prFacts(refused("not ready at merge time: CI pending, mergeable unknown")));
  assert.equal(state.state, "refused");
});

test("from database rows: red CI at a new head with an earlier non-take review asks the contributor once", async () => {
  const { world } = await import("./world-db.ts");
  const w = await (await (await (await world()).repo()).pr(1, { ci: "failure" })).review(1, { verdict: "close", head: "oldhead" });
  try {
    const p = await w.prPlan(1);
    assert.deepEqual(p.actions.filter((a) => a.kind === "cifix").map((a) => a.params?.bucket), ["ask"]);
  } finally { w.close(); }
});

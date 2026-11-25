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

test("a PR whose label once got no review is planned for one, so it does not wait on a person", () => {
  const p = decidePr(prFacts({ review: null, label: "documentation" }));
  assert.equal(p.state, "not-reviewed");
  assert.deepEqual(p.actions.map((a) => a.kind), ["review"]);
  assert.equal(p.waitKind, null);
});

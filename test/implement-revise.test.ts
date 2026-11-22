// Our implementation PRs go back to their session: a take-fix review and red CI plan implement{revise} for the PR's issue
// instead of the fix-up and the CI fix; a conflict still goes to the conflict step, and a head is revised once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr } from "../src/core/decide.ts";
import { prFacts } from "./world.ts";

const kinds = (f: Parameters<typeof prFacts>[0]) =>
  decidePr(prFacts(f)).actions.filter((a) => a.kind !== "unassign").map((a) => `${a.kind}${a.params?.bucket ? `:${a.params.bucket}` : ""}${a.params?.issue ? `#${a.params.issue}` : ""}`);

test("an implementation PR's review fixes and red CI go to its session; a conflict goes to the conflict step", () => {
  const ours = { implementation: { issue: 7, state: "pr-opened", revisedHeads: [] as string[] } };
  const takeFix = { review: { verdict: "take-fix" as const, fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [] as string[] } };
  const red = { ci: "failure" as const, cifix: { states: [] as string[], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, skipReason: null, checksAt: null } };

  // A contributor's PR gets the fix-up and the CI fix; ours gets the revision instead.
  assert.ok(kinds(takeFix).includes("fixup:fix"));
  assert.deepEqual(kinds({ ...takeFix, ...ours }).filter((k) => /^(fixup|cifix|implement)/.test(k)), ["implement:revise#7"]);
  assert.ok(kinds(red).some((k) => k.startsWith("cifix")));
  assert.deepEqual(kinds({ ...red, ...ours }).filter((k) => /^(fixup|cifix|implement)/.test(k)), ["implement:revise#7"]);

  // A conflict is merged away by the conflict step first.
  const conflict = kinds({ ...takeFix, ...ours, mergeable: "CONFLICTING", conflict: { bucket: "merge", base: "main", baseOk: true } });
  assert.ok(conflict.includes("conflict:merge"), conflict.join());
  assert.ok(!conflict.some((k) => k.startsWith("implement")), conflict.join());

  // A head the session already revised waits for its push, and a revision that is running or stuck plans nothing new.
  assert.ok(!kinds({ ...takeFix, implementation: { ...ours.implementation, revisedHeads: ["h1"] } }).some((k) => /^(fixup|implement)/.test(k)));
  for (const state of ["revising", "stuck"]) assert.ok(!kinds({ ...takeFix, implementation: { ...ours.implementation, state } }).some((k) => /^(fixup|implement)/.test(k)), state);
});

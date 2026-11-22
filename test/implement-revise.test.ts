// Our implementation PRs go back to their session: a take-fix review and red CI plan implement{revise} for the PR's issue
// instead of the fix-up and the CI fix; a conflict still goes to the conflict step, and a head is revised once. While the repo's
// Implement feature is off the PR waits on it, and a PR that closed ends its attempt from the PR side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr, implementOffWait } from "../src/core/decide.ts";
import { setFeature } from "../src/build/features.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { setImplementationState, startImplementation } from "../src/implement/store.ts";
import { prFacts } from "./world.ts";
import { world } from "./world-db.ts";

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

  // A head the session already revised waits for its push, a revision that started goes on from the PR (its issue may be
  // closed or held), and a stuck one plans nothing new.
  assert.ok(!kinds({ ...takeFix, implementation: { ...ours.implementation, revisedHeads: ["h1"] } }).some((k) => /^(fixup|implement)/.test(k)));
  assert.deepEqual(kinds({ ...takeFix, implementation: { ...ours.implementation, state: "revising", revisedHeads: ["h1"] } }).filter((k) => /^(fixup|implement)/.test(k)), ["implement:revise#7"]);
  assert.ok(!kinds({ ...takeFix, implementation: { ...ours.implementation, state: "stuck" } }).some((k) => /^(fixup|implement)/.test(k)));
});

test("an implementation PR waits on the Implement switch while it is off", () => {
  const takeFix = { review: { verdict: "take-fix" as const, fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [] as string[] } };
  const off = decidePr(prFacts({ ...takeFix, implementation: { issue: 7, state: "pr-opened", revisedHeads: [] }, repoFacts: { implementOn: false } }));
  assert.ok(!off.actions.some((a) => a.kind === "implement"), JSON.stringify(off.actions));
  assert.equal(off.wait, implementOffWait("app"));
});

test("a closed, unmerged implementation PR whose issue is closed too still ends its attempt", async () => {
  const w = await (await (await (await world()).repo()).pr(1)).issue(2);
  await setFeature(w.db, "implement", true, "op");
  await setFeature(w.db, "implement", true, "op", "app");
  const impl = await startImplementation(w.db, { repo: "app", number: 2, queuedBy: "op", textHash: "t" });
  await setImplementationState(w.db, impl.id, "pr-opened", { prNumber: 1 });
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "in", [1, 2]));
  const f = (await loadPrFacts(w.db)).find((x) => x.number === 1);
  assert.ok(f, "the closed PR of a live implementation is loaded");
  assert.ok(decidePr(f).actions.some((a) => a.kind === "implement" && a.params?.bucket === "revise" && a.params?.issue === 2));
});

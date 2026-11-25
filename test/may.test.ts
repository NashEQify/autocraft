import { test } from "node:test";
import assert from "node:assert/strict";
import { mayMerge, mayPush, type WorkflowGate } from "../src/core/may.ts";

const wf = (o: Partial<WorkflowGate> = {}): WorkflowGate => ({ live: true, entry: "review", state: "running", startedBy: "starter", approvedBy: null, approvedAt: null, blocker: null, baseHead: "h1", fixupAsked: false, ...o });
const repo = { by: "op", at: "2026-01-01T00:00:00Z" };
const merge = (workflow: WorkflowGate | null, head = "h1", repoApproval: typeof repo | null = null, own: string[] = []) => mayMerge({ repoApproval, workflow, head, ownHeads: new Set(own) });
const push = (kind: Parameters<typeof mayPush>[0]["kind"], workflow: WorkflowGate | null, repoApproval: typeof repo | null = null, operatorFix = false) => mayPush({ kind, repoApproval, workflow, operatorFix, by: "asker" });

test("mayMerge with a live workflow", () => {
  assert.deepEqual(merge(wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
  assert.deepEqual(merge(wf({ entry: "merge" })), { ok: true, as: "person", by: "starter" });
  assert.equal(merge(wf({ approvedBy: "ann" }), "h2", null, ["h2"]).ok, true);
  assert.equal(merge(wf({ approvedBy: "ann", blocker: "major finding" })).ok, false);
  assert.equal(merge(wf({ approvedBy: "ann" }), "h2").ok, false);
  assert.equal(merge(wf()).ok, false);
});

test("mayMerge without a live workflow uses the repo switch", () => {
  assert.deepEqual(merge(null, "h1", repo), { ok: true, as: "repo", by: "op" });
  assert.equal(merge(null).ok, false);
  assert.deepEqual(merge(wf({ live: false, approvedBy: "ann" }), "h1", repo), { ok: true, as: "repo", by: "op" });
  assert.equal(merge(wf({ live: false })).ok, false);
});

test("mayPush", () => {
  assert.deepEqual(push("fixup", wf(), null, true), { ok: true, as: "person", by: "asker" });
  for (const entry of ["fix-up", "implement", "merge"] as const) assert.equal(push("fixup", wf({ entry })).ok, true);
  assert.equal(push("fixup", wf({ fixupAsked: true })).ok, true);
  assert.deepEqual(push("fixup", wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
  assert.equal(push("fixup", wf()).ok, false);
  for (const kind of ["cifix", "conflict"] as const) {
    assert.equal(push(kind, wf({ entry: "merge" })).ok, true);
    assert.deepEqual(push(kind, wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
    assert.equal(push(kind, wf()).ok, false);
  }
  assert.equal(push("implement-revision", wf({ entry: "implement" })).ok, true);
  assert.equal(push("implement-revision", wf()).ok, false);
  assert.deepEqual(push("cifix", null, repo), { ok: true, as: "repo", by: "op" });
  assert.equal(push("cifix", null).ok, false);
});

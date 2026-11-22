// Pod end classification: cluster disruptions and lost nodes are told apart from the task's own failures, a pinned pod
// waits for capacity while an unpinned one is replaced, and disruption recreates are capped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPodEnd, disruptionPolicy, pendingKind } from "../src/build/disruption.ts";
import type { KPod } from "../src/build/kube-api.ts";
import { PENDING_LIMIT_MS } from "../src/build/pods.ts";

const pod = (status: KPod["status"]): KPod => ({ metadata: { name: "p" }, status });
const term = (exitCode: number, reason?: string) => [{ name: "c", state: { terminated: { exitCode, reason } } }];
const unsched = (message: string): KPod => pod({ phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message }] });

test("classifyPodEnd separates disruptions, node loss and the task's own faults", () => {
  for (const reason of ["PreemptionByScheduler", "TerminationByKubelet", "EvictionByEvictionAPI", "DeletionByTaintManager"]) {
    assert.equal(classifyPodEnd(pod({ phase: "Failed", conditions: [{ type: "DisruptionTarget", status: "True", reason }], containerStatuses: term(137) }), true), "disruption", reason);
  }
  assert.equal(classifyPodEnd(pod({ phase: "Failed", reason: "Evicted", message: "The node was low on resource: memory." }), true), "disruption");
  assert.equal(classifyPodEnd(pod({ phase: "Failed", reason: "Evicted", message: "Usage of EmptyDir volume \"tmp\" exceeds the limit \"16Gi\"." }), true), "own-fault");
  assert.equal(classifyPodEnd(null, true), "disruption");
  assert.equal(classifyPodEnd(null, false), "node-lost");
  assert.equal(classifyPodEnd(null, null), "node-lost");
  assert.equal(classifyPodEnd(pod({ phase: "Failed" }), false), "node-lost");
  assert.equal(classifyPodEnd(pod({ phase: "Failed", containerStatuses: term(137, "OOMKilled") }), false), "own-fault");
  assert.equal(classifyPodEnd(pod({ phase: "Failed", reason: "DeadlineExceeded" }), true), "own-fault");
  assert.equal(classifyPodEnd(pod({ phase: "Failed", containerStatuses: term(2, "Error") }), true), "own-fault");
  assert.equal(classifyPodEnd(pod({ phase: "Succeeded", containerStatuses: term(0, "Completed") }), true), "ok");
});

test("pendingKind holds a pinned pod for capacity and replaces an unpinned one after the pending limit", () => {
  const full = unsched("0/5 nodes are available: 5 Insufficient cpu.");
  assert.equal(pendingKind(full, PENDING_LIMIT_MS * 10, true), "capacity-wait");
  assert.equal(pendingKind(unsched("0/5 nodes are available: 5 node(s) had untolerated taint"), PENDING_LIMIT_MS * 10, true), "wait");
  assert.equal(pendingKind(full, PENDING_LIMIT_MS + 1, false), "replace");
  assert.equal(pendingKind(full, PENDING_LIMIT_MS - 1, false), "wait");
  assert.equal(pendingKind(pod({ phase: "Pending" }), PENDING_LIMIT_MS * 2, false), "wait");
});

test("disruptionPolicy recreates up to three times", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => disruptionPolicy(n).recreate), [true, true, true, false, false]);
});

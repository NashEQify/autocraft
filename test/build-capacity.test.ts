import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCapacity, feedbackCapacity, podRequest, quotaRoom, toCapNode, toCapPod, type CapNode, type CapPod, type CapacitySettings, type Res } from "../src/build/capacity.ts";
import type { KPod } from "../src/build/kube-api.ts";

const GI = 1024 ** 3;
const settings: CapacitySettings = { archLabel: "amd64", nodeReserve: { cpu: 0, mem: 0 }, buildPriority: -200 };
const node = (name: string, cpu: number, memGi: number, extra: Partial<CapNode> = {}): CapNode =>
  ({ name, ready: true, unschedulable: false, arch: "amd64", labels: {}, allocatable: { cpu: cpu * 1000, mem: memGi * GI }, ...extra });
const pod = (name: string, nodeName: string | null, cpu: number, memGi: number, extra: Partial<CapPod> = {}): CapPod =>
  ({ name, node: nodeName, phase: "Running", priority: 0, request: { cpu: cpu * 1000, mem: memGi * GI }, ours: false, unschedulable: false, ...extra });
const req = (cpu: number, memGi: number): Res => ({ cpu: cpu * 1000, mem: memGi * GI });
const cap = (o: Partial<Parameters<typeof computeCapacity>[0]>) =>
  computeCapacity({ nodes: [node("a", 16, 64)], pods: [], quota: null, reservations: new Map(), settings, ...o });

test("a node full of other pods gets nothing; our own build pods do not count twice", () => {
  const c = cap({ pods: [pod("svc", "a", 14, 10), pod("done", "a", 2, 50, { phase: "Succeeded" }), pod("build", "a", 8, 8, { ours: true })] });
  assert.equal(c.fit(req(2, 4)), "a");
  assert.equal(c.fit(req(3, 4)), null);
  const full = cap({ pods: [pod("svc", "a", 16, 10)] });
  assert.equal(full.fit(req(1, 1)), null);
  assert.equal(cap({ nodes: [node("a", 16, 64, { ready: false }), node("b", 16, 64, { unschedulable: true }), node("c", 16, 64, { arch: "arm64" })] }).fit(req(1, 1)), null);
});

test("reservations reduce room, the reserve too, and fit prefers the warm node then the roomiest", () => {
  const nodes = [node("a", 16, 64), node("b", 16, 64)];
  const c = cap({ nodes, reservations: new Map([["a", req(10, 10)]]) });
  assert.equal(c.fit(req(8, 8)), "b");
  assert.equal(c.fit(req(4, 4), ["a"]), "a");
  assert.equal(c.fit(req(8, 8), ["a"]), "b");
  assert.equal(cap({ settings: { ...settings, nodeReserve: req(14, 0) } }).fit(req(4, 1)), null);
  const t = cap({ nodes });
  assert.equal(t.take(req(12, 1)), "a");
  assert.equal(t.take(req(12, 1)), "b");
  assert.equal(t.take(req(12, 1)), null);
});

test("yield on a pending unschedulable pod above build priority, not below", () => {
  const stuck = (priority: number) => pod("p", null, 8, 8, { phase: "Pending", priority, unschedulable: true });
  assert.equal(cap({ pods: [stuck(1000)] }).yield, true);
  assert.equal(cap({ pods: [stuck(-300)] }).yield, false);
  assert.equal(cap({ pods: [pod("p", null, 8, 8, { phase: "Pending", priority: 1000 })] }).yield, false);
  const kpod: KPod = { metadata: { name: "p" }, spec: { priority: 1000 }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] } };
  assert.equal(cap({ pods: [toCapPod(kpod)] }).yield, true);
});

test("quota room caps fit and count", () => {
  const room = quotaRoom([{ metadata: { name: "q" }, status: { hard: { "requests.cpu": "10", "requests.memory": "100Gi" }, used: { "requests.cpu": "7", "requests.memory": "20Gi" } } }]);
  assert.deepEqual(room, req(3, 80));
  const c = cap({ quota: room });
  assert.equal(c.fit(req(4, 1)), null);
  assert.equal(c.fit(req(3, 1)), "a");
  assert.equal(c.countFit(req(1, 1)), 3);
  assert.equal(quotaRoom([]), null);
});

test("pod request is max(init, sum of containers) plus overhead; nodes and quantities parse", () => {
  const spec = {
    initContainers: [{ resources: { requests: { cpu: "4", memory: "1Gi" } } }, { resources: { requests: { cpu: "500m", memory: "6Gi" } } }],
    containers: [{ resources: { requests: { cpu: "1500m", memory: "2048Mi" } } }, { resources: { requests: { cpu: "500m", memory: "1Gi" } } }, {}],
    overhead: { cpu: "250m", memory: "100Mi" },
  };
  assert.deepEqual(podRequest(spec), { cpu: 4250, mem: 6 * GI + 100 * 1024 ** 2 });
  const n = toCapNode({ metadata: { name: "n", labels: { "kubernetes.io/arch": "amd64" } }, status: { conditions: [{ type: "Ready", status: "True" }], allocatable: { cpu: "3920m", memory: "16384000Ki" } } });
  assert.deepEqual([n.ready, n.allocatable], [true, { cpu: 3920, mem: 16384000 * 1024 }]);
});

test("scheduler feedback: quota only, stops when the last pod is unschedulable", () => {
  const ok = feedbackCapacity(req(4, 8), { metadata: { name: "p" }, status: { phase: "Running" } });
  assert.equal(ok.fit(req(4, 8)), true);
  assert.equal(ok.fit(req(5, 1)), false);
  const bad = feedbackCapacity(req(40, 80), { metadata: { name: "p" }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] } });
  assert.equal(bad.fit(req(1, 1)), false);
});

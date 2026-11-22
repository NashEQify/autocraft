// Step pod memory per repository: an OOM kill raises it up to the environment's cap, and the step pod carries it, the
// build priority class and, when the run was placed, the node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "../src/db/open.ts";
import { groupsOf, parseSettings, quantity, stepPod, taskRequest, type Prepared } from "../src/build/pods.ts";
import { raiseAfterOom, repoMemory } from "../src/build/sizing.ts";
import type { TaskStep } from "../web/src/api/types.ts";

test("OOM kills raise a repo's step memory up to maxPodMemory; its step pod runs with it on the placed node", async () => {
  const db = await connectDb(":memory:");
  const s = parseSettings({ maxPodMemory: "16Gi", toolchainImages: { "rust-stable": "rust-stable:test" } });
  const start = await repoMemory(db, "app", s);
  const first = await raiseAfterOom(db, "app", s);
  assert.ok(first.raised && first.memory.limitBytes > start.limitBytes && first.memory.requestBytes > start.requestBytes);
  let last = first;
  for (let i = 0; i < 5 && last.raised; i++) last = await raiseAfterOom(db, "app", s);
  assert.equal(last.raised, false, "raises stop at the cap");
  assert.ok(last.memory.limitBytes <= quantity(s.maxPodMemory) && last.memory.requestBytes <= last.memory.limitBytes);
  assert.deepEqual(await repoMemory(db, "app", s), last.memory);

  const plan: TaskStep[] = [{ name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 }];
  const prepared: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null };
  const ctx = { s, envId: "pods", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600, memory: last.memory, node: "node-a" };
  const pod = stepPod(ctx, "rust-stable:test", "autocraft:test", plan, groupsOf(plan)[0]!, prepared, false, "app") as { spec: Record<string, any> };
  assert.equal(pod.spec.priorityClassName, s.priorityClassName);
  assert.deepEqual(pod.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ["node-a"]);
  const step = pod.spec.containers[0];
  assert.equal(quantity(step.resources.limits.memory), last.memory.limitBytes);
  assert.ok(taskRequest(s, last.memory).memBytes >= quantity(step.resources.requests.memory), "the reservation covers the step pod");
  const unplaced = stepPod({ ...ctx, node: null }, "rust-stable:test", "autocraft:test", plan, groupsOf(plan)[0]!, prepared, false, "app") as { spec: Record<string, any> };
  assert.equal(unplaced.spec.affinity, undefined);
  await db.close();
});

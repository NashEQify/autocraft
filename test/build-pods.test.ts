// Kubernetes build environments with a fake API: a queued task goes through its task, source, step and upload pods, the
// runner reads the results from pod status, and the pod key can read the task but never report a result; a task whose
// pod disappears is requeued once, then failed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { authenticate, createEnv } from "../src/build/envs.ts";
import type { KPod, KubeApi } from "../src/build/kube-api.ts";
import { launcherPass, LauncherState } from "../src/build/launcher.ts";
import { createTask, getTask } from "../src/build/tasks.ts";
import { startWorkerServer } from "../src/build/worker-api.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "build-pods-"));
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const db = connect(join(dir, "pods.db"));
db.exec("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1); INSERT INTO repos (name, visibility) VALUES ('open-app', 'public')");
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Pod = KPod & { spec: Record<string, any> };
const matches = (labels: Record<string, string> | undefined, selector: string) => selector.split(",").every((kv) => labels?.[kv.split("=")[0]!] === kv.split("=")[1]);

class FakeKube implements KubeApi {
  pods = new Map<string, Pod>();
  pvcs = new Map<string, { metadata: { name: string; labels?: Record<string, string> } }>();
  async listPods(_ns: string, sel: string) { return [...this.pods.values()].filter((p) => matches(p.metadata.labels, sel)); }
  async createPod(ns: string, pod: object) {
    const p = structuredClone(pod) as Pod;
    assert.equal((p.metadata as { namespace?: string }).namespace, ns);
    this.pods.set(p.metadata.name, { ...p, status: { phase: "Pending" } });
  }
  async deletePod(_ns: string, name: string) { this.pods.delete(name); }
  async podLog(_ns: string, name: string, container: string) { return `${container} of ${name} says hello\n`; }
  async listPvcs(_ns: string, sel: string) { return [...this.pvcs.values()].filter((v) => matches(v.metadata.labels, sel)); }
  async createPvc(_ns: string, pvc: object) { const v = structuredClone(pvc) as { metadata: { name: string } }; this.pvcs.set(v.metadata.name, v); }
  async deletePvc(_ns: string, name: string) { this.pvcs.delete(name); }
  async canI() { return true; }
  /** The single pod of a task, or fails. */
  only(task: number): Pod {
    const p = [...this.pods.values()].filter((x) => x.metadata.labels?.["craft.build/task"] === String(task));
    assert.equal(p.length, 1, `one pod for task ${task}`);
    return p[0]!;
  }
  /** Ends every container of a pod with the given exit codes (0 when not named). */
  end(pod: Pod, codes: Record<string, { exitCode: number; message?: string }> = {}) {
    const st = (c: { name: string }) => ({ name: c.name, state: { terminated: { exitCode: 0, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:03Z", ...codes[c.name] } } });
    const init = (pod.spec.initContainers ?? []) as { name: string }[], main = pod.spec.containers as { name: string }[];
    const failed = [...init, ...main].some((c) => (codes[c.name]?.exitCode ?? 0) !== 0);
    pod.status = { phase: failed ? "Failed" : "Succeeded", initContainerStatuses: init.map(st), containerStatuses: main.map(st) };
  }
}

const envOf = (c: { env?: { name: string; value: string }[] }) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
const SHA = "b".repeat(40);
let clock = Date.now();
const kube = new FakeKube();
const state = new LauncherState();
const pass = () => launcherPass({ db, api: kube, defaultImage: null, log: () => {}, now: () => clock }, state);

createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" } } }, "op");

test("a task runs through its pods and its results come from pod status", async () => {
  const id = createTask(db, {
    step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] },
    plan: [
      { name: "fetch deps", cmd: ["cargo", "fetch"], network: "fetch", timeoutSec: 600 },
      { name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 },
      { name: "test", cmd: ["cargo", "test"], network: "none", timeoutSec: 600, artifacts: ["report.json"] },
    ],
  });
  await pass();
  assert.equal(getTask(db, id)!.state, "running");
  assert.equal(kube.pvcs.size, 1);
  const taskPod = kube.only(id);
  const spec = taskPod.spec;
  assert.equal(taskPod.metadata.labels!["craft.build/network"], "api");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.restartPolicy, "Never");
  assert.equal(spec.nodeSelector, undefined);
  assert.equal(spec.securityContext.runAsNonRoot, true);
  assert.ok(spec.activeDeadlineSeconds > 0);
  assert.ok(spec.volumes.every((v: Record<string, unknown>) => v.persistentVolumeClaim || v.emptyDir), "only the task's volume and emptyDirs");
  const c = spec.containers[0];
  assert.equal(c.image, "autocraft:test");
  assert.ok(c.resources.limits.cpu && c.resources.limits.memory && c.resources.limits["ephemeral-storage"]);
  const key = envOf(c).AUTOCRAFT_POD_KEY!;
  assert.equal(authenticate(db, key)?.taskId, id);

  // The key reads its task and nothing else: no result, no claim, no other task.
  const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
  try {
    const call = (method: string, path: string, body?: object) =>
      fetch(`${w.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const got = await call("GET", "/worker/pod/task");
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { steps: unknown[] }).steps.length, 3);
    assert.equal((await call("POST", `/worker/tasks/${id}/finish`, { results: [{ step: "build", exitCode: 0, durationMs: 1, timedOut: false }], summary: "ok" })).status, 403);
    assert.equal((await call("POST", "/worker/claim", { free: 1 })).status, 403);
  } finally {
    await w.close();
  }

  kube.end(taskPod);
  await pass();
  assert.equal(authenticate(db, key), null, "the task pod's key dies before repository code runs");
  const source = kube.only(id);
  assert.equal(source.metadata.labels!["craft.build/network"], "fetch");
  assert.equal(envOf(source.spec.containers[0]).AUTOCRAFT_POD_KEY, undefined);

  kube.end(source, { source: { exitCode: 0, message: JSON.stringify({ ok: true, env: { GATE_FLAG: "1" }, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null }) } });
  await pass();
  const fetchPod = kube.only(id);
  assert.equal(fetchPod.metadata.labels!["craft.build/network"], "fetch");
  assert.deepEqual(fetchPod.spec.containers.map((x: { name: string }) => x.name), ["step-0"]);
  assert.equal(fetchPod.spec.containers[0].image, "rust-stable:test");
  assert.equal(envOf(fetchPod.spec.containers[0]).GATE_FLAG, undefined, "a fetch step gets no gate env");

  kube.end(fetchPod);
  await pass();
  const offline = kube.only(id);
  assert.equal(offline.metadata.labels!["craft.build/network"], "none");
  assert.deepEqual(offline.spec.initContainers.map((x: { name: string }) => x.name), ["step-1"]);
  assert.deepEqual(offline.spec.containers.map((x: { name: string }) => x.name), ["step-2"]);
  assert.equal(envOf(offline.spec.containers[0]).GATE_FLAG, "1");

  kube.end(offline);
  await pass();
  const upload = kube.only(id);
  assert.equal(upload.metadata.labels!["craft.build/network"], "api");
  assert.ok(authenticate(db, envOf(upload.spec.containers[0]).AUTOCRAFT_POD_KEY!));

  kube.end(upload);
  await pass();
  const t = getTask(db, id)!;
  assert.equal(t.state, "done");
  assert.deepEqual(t.results.map((r) => [r.step, r.exitCode]), [["fetch deps", 0], ["build", 0], ["test", 0]]);
  assert.equal(kube.pods.size, 0);
  assert.equal(kube.pvcs.size, 0);
  assert.equal(authenticate(db, envOf(upload.spec.containers[0]).AUTOCRAFT_POD_KEY!), null);
});

test("a failing step ends the task without running later pods", async () => {
  const id = createTask(db, {
    step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] },
    plan: [
      { name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 },
      { name: "fetch more", cmd: ["cargo", "fetch"], network: "fetch", timeoutSec: 600 },
    ],
  });
  await pass();
  kube.end(kube.only(id));
  await pass();
  kube.end(kube.only(id), { source: { exitCode: 0, message: JSON.stringify({ ok: true, env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null }) } });
  await pass();
  kube.end(kube.only(id), { "step-0": { exitCode: 101 } });
  await pass();
  const t = getTask(db, id)!;
  assert.equal(t.state, "failed");
  assert.match(t.summary ?? "", /build failed \(exit 101\)/);
  assert.equal(kube.pods.size, 0);
});

test("a task whose pod disappears is requeued once, then failed", async () => {
  const id = createTask(db, { step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] }, plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 60 }] });
  await pass();
  kube.pods.delete(kube.only(id).metadata.name);
  clock += 60_000;
  await pass();
  // Requeued, and claimed again in the same pass.
  assert.equal((db.prepare("SELECT attempts FROM build_tasks WHERE id = ?").get(id) as { attempts: number }).attempts, 2);
  kube.pods.delete(kube.only(id).metadata.name);
  clock += 60_000;
  await pass();
  const t = getTask(db, id)!;
  assert.equal(t.state, "failed");
  assert.match(t.summary ?? "", /disappeared/);
  assert.equal(kube.pods.size, 0);
  assert.equal(kube.pvcs.size, 0);
});

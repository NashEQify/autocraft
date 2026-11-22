// Workspace pods with a fake Kubernetes API: a requested workspace gets its volume and pod, is seeded from AutoCraft's
// clone over exec stdin, parks after it sits idle (checkpoint stored, pod deleted, volume kept), and its parked volume
// goes after the keep time while the checkpoint stays. The build-task launcher leaves workspace pods alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import type { ExecOptions, ExecResult, KPod, KubeApi } from "../src/build/kube-api.ts";
import { launcherPass, LauncherState } from "../src/build/launcher.ts";
import { IDLE_PARK_MS, PARKED_VOLUME_MS, workspacePass, WorkspaceState } from "../src/build/workspace-launch.ts";
import { createWorkspace, getWorkspace } from "../src/build/workspaces.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-pods-"));
process.env.AUTOCRAFT_FIXUP_DIR = join(dir, "fixups");
const db = await connectDb(join(dir, "ws.db"));
await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1); INSERT INTO repos (name, visibility) VALUES ('open-app', 'public')");
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// AutoCraft's clone of the repo: a bare repository with one commit.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const src = join(dir, "src");
mkdirSync(src);
git(src, "init", "-q");
writeFileSync(join(src, "README.md"), "hello\n");
git(src, "add", "-A");
git(src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
const SHA = git(src, "rev-parse", "HEAD");
mkdirSync(join(dir, "fixups"));
git(dir, "clone", "-q", "--bare", src, join(dir, "fixups", "open-app"));

type Pod = Omit<KPod, "spec"> & { spec: Record<string, any> };
const matches = (labels: Record<string, string> | undefined, selector: string) => selector.split(",").every((kv) => labels?.[kv.split("=")[0]!] === kv.split("=")[1]);
const DIFF = Buffer.from("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+hello, workspace\n");
const POD_COMMIT = "c".repeat(40);

class FakeKube implements KubeApi {
  pods = new Map<string, Pod>();
  pvcs = new Map<string, { metadata: { name: string; labels?: Record<string, string> } }>();
  execs: string[][] = [];
  untarBytes = 0;
  async listPods(_ns: string, sel: string) { return [...this.pods.values()].filter((p) => matches(p.metadata.labels, sel)); }
  async createPod(_ns: string, pod: object) { const p = structuredClone(pod) as Pod; this.pods.set(p.metadata.name, { ...p, status: { phase: "Pending" } }); }
  async deletePod(_ns: string, name: string) { this.pods.delete(name); }
  async podLog() { return ""; }
  async listPvcs(_ns: string, sel: string) { return [...this.pvcs.values()].filter((v) => matches(v.metadata.labels, sel)); }
  async createPvc(_ns: string, pvc: object) { const v = structuredClone(pvc) as { metadata: { name: string } }; this.pvcs.set(v.metadata.name, v); }
  async deletePvc(_ns: string, name: string) { this.pvcs.delete(name); }
  async canI() { return true; }
  async exec(_ns: string, _pod: string, _container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.execs.push(argv);
    const ok = (stdout: Buffer | string): ExecResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), truncated: false });
    if (argv[0] === WS_POD_PATH && argv[1] === "untar") {
      const chunks: Buffer[] = [];
      const input = opts.stdin ?? Buffer.alloc(0);
      for await (const c of Buffer.isBuffer(input) ? [input] : input) chunks.push(c);
      const tar = Buffer.concat(chunks);
      this.untarBytes = tar.length;
      // A tar of the base commit: the ustar magic of its first header, and the file in it.
      assert.equal(tar.subarray(257, 262).toString(), "ustar");
      assert.ok(tar.includes(Buffer.from("hello\n")));
      return ok(`WS ok ${POD_COMMIT}\n`);
    }
    if (argv[0] === WS_POD_PATH && argv[1] === "run") return ok("WS exited 0 15 0\n");
    if (argv[0] === "head") return ok(DIFF);
    return { exitCode: 2, stdout: Buffer.from("WS error usage unknown\n"), stderr: Buffer.alloc(0), truncated: false };
  }
  /** The pod runs and its container is ready, on node-a. */
  run(name: string) {
    const p = this.pods.get(name)!;
    p.spec.nodeName = "node-a";
    p.status = { phase: "Running", containerStatuses: (p.spec.containers as { name: string }[]).map((c) => ({ name: c.name, ready: true, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } })) };
  }
}

let clock = Date.now();
const kube = new FakeKube();
const state = new WorkspaceState();
const deps = { db, api: kube, defaultImage: null, log: () => {}, now: () => clock };
const pass = async () => {
  await workspacePass(deps, state);
  await state.idle();
};

await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" } } }, "op");

test("a workspace starts, is seeded, parks when idle and keeps its checkpoint after its volume goes", async () => {
  const id = await createWorkspace(db, { repo: "open-app", baseSha: SHA, envId: "pods", owner: "cli" }, clock);
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "starting");
  const pod = kube.pods.get(`ws-${id}`)!;
  assert.ok(pod && kube.pvcs.has(`ws-${id}`), "pod and volume created");
  const spec = pod.spec;
  assert.equal(pod.metadata.labels!["app.kubernetes.io/name"], "autocraft-workspace");
  assert.equal(pod.metadata.labels!["craft.build/network"], "none");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.enableServiceLinks, false);
  assert.equal(spec.securityContext.runAsNonRoot, true);
  for (const c of [...spec.initContainers, ...spec.containers]) {
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.ok(c.resources.requests.cpu && c.resources.requests.memory, `${c.name} has requests (the namespace quota needs them)`);
  }
  assert.equal(spec.containers[0].image, "rust-stable:test");
  assert.ok(spec.initContainers[0].command.includes(WS_POD_PATH), "the helper is copied in");
  assert.ok(spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0, "kept off the service's node");

  // The build-task launcher's sweep deletes only build pods.
  await launcherPass(deps, new LauncherState());
  assert.ok(kube.pods.has(`ws-${id}`) && kube.pvcs.has(`ws-${id}`), "the build launcher leaves workspace pods and volumes alone");

  kube.run(`ws-${id}`);
  await pass();
  let w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.equal(w.base_commit, POD_COMMIT);
  assert.equal(w.node, "node-a");
  assert.ok(kube.untarBytes > 0, "the source went over exec stdin");

  clock += IDLE_PARK_MS + 60_000;
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pod, null);
  assert.ok(!kube.pods.has(`ws-${id}`), "the parked workspace's pod is deleted");
  assert.ok(kube.pvcs.has(`ws-${id}`), "its volume is kept");
  assert.deepEqual(Buffer.from(w.checkpoint!), DIFF);
  const run = kube.execs.find((a) => a[1] === "run")!;
  assert.ok(run.includes(POD_COMMIT), "the checkpoint diffs against the pod's base commit");
  const calls = await db.all(db.k.selectFrom("workspace_calls").select(["tool", "state", "n"]).where("workspace_id", "=", id).orderBy("id"));
  assert.deepEqual(calls.map((c) => [c.tool, c.state]), [["seed", "done"], ["checkpoint", "done"]]);
  assert.ok(calls[1]!.n! > 0);

  clock += PARKED_VOLUME_MS + 60_000;
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pvc, null);
  assert.ok(!kube.pvcs.has(`ws-${id}`), "the parked volume is deleted after its keep time");
  assert.ok(w.checkpoint && w.checkpoint.length > 0, "the checkpoint stays");
});

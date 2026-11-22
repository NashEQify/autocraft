// The workspace half of the pod launcher: one pass every PASS_MS, per kubernetes environment, after the build-task pass.
//
//   requested  → starting  volume and pod created when a workspace slot is free
//   starting   → seeding   the pod runs and its container is ready; the node is recorded
//   seeding    → ready     `git archive <base_sha>` from AutoCraft's clone streamed into `ws untar`, which commits it
//   ready      → parked    no call for IDLE_PARK_MS: checkpoint, pod deleted, volume kept (PARKED_VOLUME_MS, then deleted)
//   any live   → failed    the pod could not start or seed, or passed its time limit; pod and volume deleted
//   ended                  set by whoever is done with it; the pass deletes pod and volume
// While ready, a checkpoint (`git diff --binary` against the base commit) is stored every CHECKPOINT_EVERY_MS. Seeding,
// checkpoints and parking run in the background, at most one per workspace, so a slow exec never holds up the pass.
// Stateless between passes apart from what is in flight: after a restart a `seeding` row seeds again (from an empty tree).
import { spawn } from "node:child_process";
import type { Db } from "../db/index.ts";
import { cols } from "../db/kx.ts";
import { exec, fixupDir, GIT_ENV, gitDirEnv, Git, HARDENING } from "../fixup/git.ts";
import { ownerOf } from "../owners.ts";
import { KubeError, type KPod, type KubeApi } from "./kube-api.ts";
import type { LauncherDeps } from "./launcher.ts";
import { LIST_GRACE_MS, PENDING_LIMIT_MS, PULL_LIMIT_MS, PULL_REASONS, settingsOf, STUCK_MS, type KubeSettings } from "./pods.ts";
import { workspaceEnvSelector, workspaceName, workspacePodSpec, workspacePvcSpec, WS_CONTAINER } from "./workspace-pods.ts";
import { describeHeader, execInWorkspace, execWs, limitsOf, LIVE_STATES, moveWorkspace, POD_STATES, type WorkspaceRow, type WorkspaceStateName, type WsCallResult } from "./workspaces.ts";

export const SEED_LIMIT_MS = 10 * 60_000;
export const IDLE_PARK_MS = 30 * 60_000;
export const CHECKPOINT_EVERY_MS = 10 * 60_000;
/** A parked workspace's volume is deleted after this long; the checkpoint stays, and a resume rebuilds from base plus checkpoint. */
export const PARKED_VOLUME_MS = 60 * 60_000;
export const MAX_SOURCE_BYTES = 512 * 1024 ** 2;
export const MAX_CHECKPOINT_BYTES = 5 * 1024 ** 2;
/** The toolchain image workspace pods run. */
export const WORKSPACE_TOOLCHAIN = "rust-stable";
const CREATE_BACKOFF_MS = 60_000;
const CHECKPOINT_FILE = "/work/.ws/checkpoint.diff";
// The diff is cut one byte past the cap, so an oversized one shows as such; head stopping early makes git's status 141.
const CHECKPOINT_SH = `set -e
git add -A -N
{ git diff --binary --no-ext-diff --no-textconv "$1"; echo $? >/work/.ws/checkpoint.rc; } | head -c ${MAX_CHECKPOINT_BYTES + 1} >/work/.ws/checkpoint.tmp
rc=$(cat /work/.ws/checkpoint.rc)
[ "$rc" = 0 ] || [ "$(wc -c </work/.ws/checkpoint.tmp)" -gt ${MAX_CHECKPOINT_BYTES} ] || exit "$rc"
mv /work/.ws/checkpoint.tmp ${CHECKPOINT_FILE}`;

/** What is in flight between passes. */
export class WorkspaceState {
  busy = new Map<number, Promise<void>>();
  unknownSince = new Map<number, number>();
  /** When each workspace's last checkpoint was tried, so a failing one is retried on the same schedule, not every pass. */
  checkpointTried = new Map<number, number>();
  backoff = new Map<string, number>();
  counts = new Map<string, string>();
  /** Resolves when nothing runs in the background (tests). */
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.allSettled([...this.busy.values()]);
  }
}

type EnvRow = { id: string; enabled: number; settings: string | null };
type Ctx = { d: LauncherDeps; state: WorkspaceState; api: KubeApi; env: EnvRow; s: KubeSettings; now: () => number };

const clean = (s: string | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
const errText = (e: unknown): string => clean(e instanceof Error ? e.message : String(e));

export async function workspacePass(d: LauncherDeps, state: WorkspaceState): Promise<void> {
  const api = d.api;
  if (!api) return;
  const envs = await d.db.all(d.db.k.selectFrom("build_envs").select(["id", "enabled", "settings"]).where("kind", "=", "kubernetes").orderBy("id"));
  for (const env of envs) {
    try {
      await envPass({ d, state, api, env, s: settingsOf(env.settings), now: d.now ?? Date.now });
    } catch (e) {
      d.log(`workspace launcher: ${env.id}: ${(e as Error).stack ?? e}`);
    }
  }
}

const liveRows = async (c: Ctx) =>
  await c.d.db.all(c.d.db.k.selectFrom("workspaces").select(cols("workspaces")).where("env_id", "=", c.env.id).where("state", "in", LIVE_STATES).orderBy("id"));

async function envPass(c: Ctx): Promise<void> {
  const { api, s } = c;
  const ns = s.namespace;
  const [pods, pvcs] = await Promise.all([api.listPods(ns, workspaceEnvSelector(c.env.id)), api.listPvcs(ns, workspaceEnvSelector(c.env.id))]);
  for (const w of await liveRows(c)) if (!c.state.busy.has(w.id)) await advance(c, w, pods);

  const back = c.state.backoff.get(c.env.id);
  if (c.env.enabled && !(back && back > c.now())) {
    const rows = await liveRows(c);
    let active = rows.filter((w) => POD_STATES.includes(w.state as WorkspaceStateName)).length;
    for (const w of rows) {
      if (w.state !== "requested") continue;
      if (active >= s.workspaceSlots) break;
      if (!await start(c, w)) break;
      active++;
    }
  }

  // Pods and volumes no live row owns: ended and failed workspaces, a parked one's old pod, a create that failed late.
  const owned = await liveRows(c);
  const podNames = new Set(owned.filter((w) => POD_STATES.includes(w.state as WorkspaceStateName)).map((w) => w.pod));
  const pvcNames = new Set(owned.map((w) => w.pvc));
  for (const p of pods) if (!podNames.has(p.metadata.name) && !p.metadata.deletionTimestamp) await api.deletePod(ns, p.metadata.name).catch((e: Error) => c.d.log(`workspace launcher: delete pod ${p.metadata.name}: ${e.message}`));
  for (const v of pvcs) if (!pvcNames.has(v.metadata.name)) await api.deletePvc(ns, v.metadata.name).catch((e: Error) => c.d.log(`workspace launcher: delete volume ${v.metadata.name}: ${e.message}`));
  for (const m of [c.state.unknownSince, c.state.checkpointTried]) for (const id of m.keys()) if (!owned.some((w) => w.id === id)) m.delete(id);

  const n = (st: string) => owned.filter((w) => w.state === st).length;
  const line = `${n("starting") + n("seeding") + n("ready")}/${s.workspaceSlots} running (${n("ready")} ready), ${n("parked")} parked, ${n("requested")} waiting`;
  if (c.state.counts.get(c.env.id) !== line) {
    c.state.counts.set(c.env.id, line);
    c.d.log(`workspace launcher: ${c.env.id}: workspaces ${line}`);
  }
}

/** Runs `f` in the background as the workspace's one step in flight. */
function background(c: Ctx, id: number, f: () => Promise<void>): void {
  const p = (async () => {
    try {
      await f();
    } catch (e) {
      c.d.log(`workspace launcher: workspace ${id}: ${(e as Error).stack ?? e}`);
    } finally {
      c.state.busy.delete(id);
    }
  })();
  c.state.busy.set(id, p);
}

async function fail(c: Ctx, w: WorkspaceRow, reason: string): Promise<void> {
  if (!await moveWorkspace(c.d.db, w.id, [w.state as WorkspaceStateName], "failed", { error: reason.slice(0, 300) }, c.now())) return;
  c.d.log(`workspace launcher: workspace ${w.id} failed: ${reason}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
  if (w.pvc) await c.api.deletePvc(c.s.namespace, w.pvc).catch(() => {});
}

/** Creates the volume and pod of a requested workspace. False when the environment should wait before the next create. */
async function start(c: Ctx, w: WorkspaceRow): Promise<boolean> {
  const appImage = c.s.image ?? c.d.defaultImage;
  const toolchainImage = c.s.toolchainImages[WORKSPACE_TOOLCHAIN];
  const missing = !appImage ? "No AutoCraft image is known for workspace pods: set AUTOCRAFT_IMAGE on the runner or the environment's image"
    : !toolchainImage ? `The environment has no ${WORKSPACE_TOOLCHAIN} toolchain image for workspace pods` : null;
  if (missing || !appImage || !toolchainImage) {
    await fail(c, w, missing!);
    return true;
  }
  const name = workspaceName(w.id);
  if (!await moveWorkspace(c.d.db, w.id, ["requested"], "starting", { pod: name, pvc: name, error: null }, c.now())) return true;
  const exists = (e: unknown) => {
    // A create that answered with an error may still have made the object; the name is the workspace's own.
    if (!(e instanceof KubeError && e.status === 409)) throw e;
  };
  try {
    await c.api.createPvc(c.s.namespace, workspacePvcSpec(c.s, c.env.id, w.id)).catch(exists);
    await c.api.createPod(c.s.namespace, workspacePodSpec({ s: c.s, envId: c.env.id, id: w.id, appImage, toolchainImage, limits: limitsOf(w) })).catch(exists);
    c.d.log(`workspace launcher: workspace ${w.id} (${w.repo}@${w.base_sha.slice(0, 8)}) starting on ${c.env.id}`);
    return true;
  } catch (e) {
    // Quota, rate limits or an API error: back in the queue, with the volume kept for the next try.
    const why = `The workspace pod could not be created: ${errText(e)}`;
    await moveWorkspace(c.d.db, w.id, ["starting"], "requested", { pod: null, error: why.slice(0, 300) }, c.now());
    c.state.backoff.set(c.env.id, c.now() + CREATE_BACKOFF_MS);
    c.d.log(`workspace launcher: workspace ${w.id}: ${why}`);
    return false;
  }
}

function podFailure(pod: KPod): string {
  const st = pod.status;
  return `The workspace pod stopped${st?.reason ? ` (${st.reason}${st.message ? `: ${st.message}` : ""})` : ""}`.slice(0, 300);
}

async function advance(c: Ctx, w: WorkspaceRow, pods: KPod[]): Promise<void> {
  const now = c.now();
  const age = now - Date.parse(w.state_at);
  if (w.state === "parked") {
    // TODO(AUTO-43): also delete parked volumes oldest first when the node's disk passes 70%, once there is a disk metric.
    if (w.pvc && age > PARKED_VOLUME_MS) {
      await c.api.deletePvc(c.s.namespace, w.pvc);
      await c.d.db.run(c.d.db.k.updateTable("workspaces").set({ pvc: null, updated_at: new Date(now).toISOString() }).where("id", "=", w.id).where("state", "=", "parked"));
      c.d.log(`workspace launcher: workspace ${w.id}: parked volume deleted after ${PARKED_VOLUME_MS / 60_000} min; the checkpoint stays`);
    }
    return;
  }
  if (!POD_STATES.includes(w.state as WorkspaceStateName)) return;
  const pod = pods.find((p) => p.metadata.name === w.pod);
  if (!pod) {
    if (w.state === "starting" && age < LIST_GRACE_MS) return;
    return lost(c, w, "The workspace pod disappeared (deleted, or its node went away)");
  }
  const deleting = pod.metadata.deletionTimestamp;
  if (deleting) {
    if (now - Date.parse(deleting) > STUCK_MS) return lost(c, w, "The workspace pod has been stuck in deletion (its node may be gone)");
    return;
  }
  const phase = pod.status?.phase;
  if (phase === "Unknown") {
    const since = c.state.unknownSince.get(w.id) ?? now;
    c.state.unknownSince.set(w.id, since);
    if (now - since > STUCK_MS) return lost(c, w, "The workspace pod's node stopped reporting");
    return;
  }
  c.state.unknownSince.delete(w.id);
  if (phase === "Succeeded" || phase === "Failed") {
    if (pod.status?.reason === "DeadlineExceeded") return fail(c, w, `The workspace passed its time limit of ${Math.round(limitsOf(w).deadlineSec / 60)} min`);
    return lost(c, w, podFailure(pod));
  }

  if (w.state === "starting") {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const pull = statuses.find((x) => PULL_REASONS.has(x.state?.waiting?.reason ?? ""));
    if (pull && age > PULL_LIMIT_MS) return fail(c, w, `The workspace pod's container ${pull.name} could not start: ${pull.state!.waiting!.reason}${pull.state!.waiting!.message ? ` (${clean(pull.state!.waiting!.message)})` : ""}`);
    const main = pod.status?.containerStatuses?.find((x) => x.name === WS_CONTAINER);
    if (phase === "Running" && main?.ready && main.state?.running) {
      if (await moveWorkspace(c.d.db, w.id, ["starting"], "seeding", { node: pod.spec?.nodeName ?? null }, now)) {
        background(c, w.id, () => seed(c, w.id));
      }
      return;
    }
    if (age > PENDING_LIMIT_MS) {
      const sched = pod.status?.conditions?.find((x) => x.type === "PodScheduled");
      const why = sched?.status === "False" ? clean(sched.message ?? sched.reason ?? "not scheduled") : pull ? pull.state!.waiting!.reason! : "its container did not become ready";
      return fail(c, w, `The workspace pod did not start within ${PENDING_LIMIT_MS / 60_000} min: ${why}`);
    }
    return;
  }
  if (w.state === "seeding") {
    // Nothing in flight for a seeding row: the runner restarted while it seeded.
    if (age > SEED_LIMIT_MS) return fail(c, w, `Seeding took longer than ${SEED_LIMIT_MS / 60_000} min`);
    background(c, w.id, () => seed(c, w.id));
    return;
  }
  // ready
  const lastCall = Math.max(Date.parse(w.state_at), w.last_call_at ? Date.parse(w.last_call_at) : 0);
  if (now - lastCall > IDLE_PARK_MS) return background(c, w.id, () => park(c, w.id));
  const lastCheckpoint = Math.max(Date.parse(w.state_at), w.checkpoint_at ? Date.parse(w.checkpoint_at) : 0, c.state.checkpointTried.get(w.id) ?? 0);
  if (now - lastCheckpoint > CHECKPOINT_EVERY_MS) {
    c.state.checkpointTried.set(w.id, now);
    background(c, w.id, async () => void await checkpoint(c, w.id));
  }
}

/** The pod went away. A ready workspace keeps its volume and checkpoint (parked, for a resume); an earlier one failed. */
async function lost(c: Ctx, w: WorkspaceRow, reason: string): Promise<void> {
  if (w.state !== "ready") return fail(c, w, reason);
  if (!await moveWorkspace(c.d.db, w.id, ["ready"], "parked", { pod: null, error: reason.slice(0, 300) }, c.now())) return;
  c.d.log(`workspace launcher: workspace ${w.id} parked: ${reason}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
}

// ---- seeding ---------------------------------------------------------------------

/** The tar of `sha` from AutoCraft's clone of `repo`, fetching the commit first when the clone lacks it. Refuses sources over MAX_SOURCE_BYTES. */
export async function sourceArchive(repo: string, sha: string): Promise<{ bytes: number; open: () => AsyncIterable<Buffer> }> {
  const g = new Git(exec, fixupDir(), repo);
  await g.init();
  if ((await g.git(["cat-file", "-e", `${sha}^{commit}`])).code !== 0) {
    await g.must(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", `https://github.com/${ownerOf(repo)}/${repo}.git`, `+${sha}:refs/workspace/base`]);
  }
  // The tar's size from the tree: a 512-byte header per entry and each blob padded to 512 bytes.
  let bytes = 1024;
  for (const e of (await g.must(["ls-tree", "-r", "-t", "-l", "-z", sha])).split("\0")) {
    const m = /^\d+ \w+ [0-9a-f]+ +(\d+|-)\t/.exec(e);
    if (m) bytes += 512 + (m[1] === "-" ? 0 : Math.ceil(Number(m[1]) / 512) * 512);
  }
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`the source of ${repo}@${sha.slice(0, 8)} is ${Math.round(bytes / 1024 ** 2)} MiB, over the ${MAX_SOURCE_BYTES / 1024 ** 2} MiB limit`);
  const env = { ...process.env, ...GIT_ENV, ...gitDirEnv(g.dir) };
  return {
    bytes,
    open: async function* () {
      const p = spawn("git", [...HARDENING, "archive", "--format=tar", sha], { env, stdio: ["ignore", "pipe", "ignore"] });
      const closed = new Promise<number | null>((ok) => {
        p.on("close", (code) => ok(code));
        p.on("error", () => ok(null));
      });
      try {
        for await (const chunk of p.stdout) yield chunk as Buffer;
        if (await closed !== 0) throw new Error("git archive failed");
      } finally {
        if (p.exitCode === null) p.kill();
      }
    },
  };
}

/** The base commit `ws untar` made, or null when it failed. */
const untarCommit = (r: WsCallResult): string | null => (r.header?.kind === "ok" && /^[0-9a-f]{40}$/.test(r.header.fields[0] ?? "") ? r.header.fields[0]! : null);

async function seed(c: Ctx, id: number): Promise<void> {
  const { db } = c.d;
  const w = await db.get(db.k.selectFrom("workspaces").select(cols("workspaces")).where("id", "=", id));
  if (!w || w.state !== "seeding") return;
  const deadline = Date.parse(w.state_at) + SEED_LIMIT_MS;
  try {
    const src = await sourceArchive(w.repo, w.base_sha);
    const untar = async () => await execWs(db, c.api, id, ["untar"], { tool: "seed", args: { repo: w.repo, sha: w.base_sha, bytes: src.bytes }, stdin: src.open(), timeoutMs: Math.max(10_000, deadline - c.now()) }, c.now);
    let r = await untar();
    if (r.header?.kind === "error" && r.header.code === "conflict") {
      // An earlier seed was cut off (a restart): start again from an empty tree.
      const wipe = await execWs(db, c.api, id, ["run", "300", "--", "find", "/work/src", "-mindepth", "1", "-delete"], { tool: "seed", args: { wipe: true }, timeoutMs: 310_000 }, c.now);
      if (wipe.header?.kind !== "status" || wipe.header.exit !== 0) throw new Error(`could not empty /work/src: ${describeHeader(wipe.header)}`);
      r = await untar();
    }
    const commit = untarCommit(r);
    if (!commit) throw new Error(`ws untar: ${r.error ?? describeHeader(r.header)}${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
    if (await moveWorkspace(db, id, ["seeding"], "ready", { base_commit: commit }, c.now())) c.d.log(`workspace launcher: workspace ${id} ready (base ${commit.slice(0, 8)})`);
  } catch (e) {
    await fail(c, w, `Seeding failed: ${errText(e)}`);
  }
}

// ---- checkpoints and parking -------------------------------------------------------

/** Stores the workspace's diff against its base commit. Problems are recorded on the row and never fail the workspace; false then. */
async function checkpoint(c: Ctx, id: number): Promise<boolean> {
  const { db } = c.d;
  const w = await db.get(db.k.selectFrom("workspaces").select(["state", "base_commit"]).where("id", "=", id));
  if (w?.state !== "ready" || !w.base_commit) return false;
  const problem = async (why: string) => {
    await db.run(db.k.updateTable("workspaces").set({ error: `checkpoint: ${why}`.slice(0, 300), updated_at: new Date(c.now()).toISOString() }).where("id", "=", id));
    c.d.log(`workspace launcher: workspace ${id}: checkpoint: ${why}`);
    return false;
  };
  try {
    const r = await execWs(db, c.api, id, ["run", "300", "--", "sh", "-c", CHECKPOINT_SH, "checkpoint", w.base_commit], { tool: "checkpoint", timeoutMs: 310_000 }, c.now);
    if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) {
      return await problem(`the diff failed (${r.error ?? describeHeader(r.header)})${r.output.trim() ? `: ${clean(r.output.trim().split("\n").pop())}` : ""}`);
    }
    const raw = await execInWorkspace(db, c.api, id, ["head", "-c", String(MAX_CHECKPOINT_BYTES + 1), CHECKPOINT_FILE], { maxOut: MAX_CHECKPOINT_BYTES + 1, timeoutMs: 120_000 });
    if (raw.exitCode !== 0) return await problem(`the diff could not be read (${raw.error ?? `exit ${raw.exitCode}`})`);
    if (raw.stdout.length > MAX_CHECKPOINT_BYTES) return await problem(`the diff is over ${MAX_CHECKPOINT_BYTES / 1024 ** 2} MiB; the previous checkpoint is kept`);
    const at = new Date(c.now()).toISOString();
    await db.run(db.k.updateTable("workspaces").set({ checkpoint: raw.stdout, checkpoint_at: at, error: null, updated_at: at }).where("id", "=", id).where("state", "=", "ready"));
    return true;
  } catch (e) {
    return await problem(errText(e));
  }
}

async function park(c: Ctx, id: number): Promise<void> {
  await checkpoint(c, id);
  const w = await c.d.db.get(c.d.db.k.selectFrom("workspaces").select(["pod"]).where("id", "=", id).where("state", "=", "ready"));
  if (!w) return;
  if (!await moveWorkspace(c.d.db, id, ["ready"], "parked", { pod: null }, c.now())) return;
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch((e: Error) => c.d.log(`workspace launcher: delete pod ${w.pod}: ${e.message}`));
  c.d.log(`workspace launcher: workspace ${id} parked after ${IDLE_PARK_MS / 60_000} min without a call`);
}

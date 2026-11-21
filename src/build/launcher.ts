// The pod launcher: runs in the runner and starts, follows and removes the build pods of kubernetes environments.
// Each pass, per environment: list its pods and volumes, move every pod run (build_pod_runs) on by what its pod's status
// says, claim queued tasks for free slots, delete pods and volumes no run owns, and record what the environment offers and
// its health. Stateless between passes apart from caches, so a restarted runner picks up where the last one stopped: a
// run whose pod is gone is lost (requeued once, then failed, as for a worker that stops answering), and pods and volumes
// of tasks that are no longer this environment's are deleted.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { Requires, SandboxEnv, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { envVar } from "../env.ts";
import { hashKey, kubeReport, newPodKey, type EnvHealth } from "./envs.ts";
import { inClusterApi, type ContainerStatus, type KPod, type KubeApi } from "./kube-api.ts";
import {
  envSelector, FIRST_GROUP, groupsOf, kubeCapabilities, PACKAGES_CONTAINER, parsePrepared, pvcSpec, settingsOf, sourcePod, STAGE_SOURCE, STAGE_TASK,
  stepContainer, stepPod, taskPod, toolchainImage, uploadPod, uploadStage, type KubeSettings, type PodCtx, type Prepared,
} from "./pods.ts";
import { appendLog, claim, finishTask, loseTask, MAX_CHUNK_BYTES, MAX_LOG_BYTES, releaseClaim, startTask, touchTask } from "./tasks.ts";

export const PASS_MS = 5000;
/** A pod not yet started after this long shows in the environment's health. */
export const PENDING_WARN_MS = 3 * 60_000;
/** A pod no node takes within this long is given up (the task is lost). */
export const PENDING_LIMIT_MS = 15 * 60_000;
/** An image that cannot be pulled for this long fails the pod. */
export const PULL_LIMIT_MS = 3 * 60_000;
/** A pod just created may be missing from a list for a moment. */
const LIST_GRACE_MS = 30_000;
const ACCESS_EVERY_MS = 60_000;
const CREATE_BACKOFF_MS = 60_000;
/** Longest the task, source and upload pods may run. */
const APP_POD_SEC = 30 * 60;
const PULL_REASONS = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError", "CreateContainerError"]);

type Run = {
  task_id: number; env_id: string; key_hash: string; pvc: string; stage: number; pod: string | null; pod_created_at: string | null;
  prepared: string | null; results: string; failed: string | null; ran: number; started_at: string;
};
type TaskRow = { id: number; state: string; env_id: string | null; plan: string; requires: string; log_bytes: number };
type EnvRow = { id: string; enabled: number; slots: number; settings: string | null };
type Kept = Prepared & { image: string };

export type LauncherDeps = {
  db: DatabaseSync;
  /** null outside a cluster: the environments then report that they cannot start pods. */
  api: KubeApi | null;
  /** The runner's own image (AUTOCRAFT_IMAGE), for environments that name none. */
  defaultImage: string | null;
  log: (line: string) => void;
  now?: () => number;
};

/** Caches between passes: the access review and a pause after a pod could not be created. */
export class LauncherState {
  access = new Map<string, { at: number; missing: string[] }>();
  backoff = new Map<string, { until: number; why: string }>();
}

const json = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const statusOf = (pod: KPod, name: string): ContainerStatus | undefined =>
  [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((c) => c.name === name);

export async function launcherPass(d: LauncherDeps, state: LauncherState): Promise<void> {
  const envs = d.db.prepare("SELECT id, enabled, slots, settings FROM build_envs WHERE kind = 'kubernetes' ORDER BY id").all() as EnvRow[];
  for (const env of envs) {
    try {
      await envPass(d, state, env);
    } catch (e) {
      d.log(`pod launcher: ${env.id}: ${(e as Error).stack ?? e}`);
    }
  }
}

async function envPass(d: LauncherDeps, state: LauncherState, env: EnvRow): Promise<void> {
  const { db } = d;
  const now = d.now ?? Date.now;
  const s = settingsOf(env.settings);
  const caps = kubeCapabilities(s);
  const report = (health: Omit<EnvHealth, "since"> | null, reachable: boolean) => kubeReport(db, env.id, caps, env.slots, health, reachable);
  const api = d.api;
  if (!api) return report({ state: "fail", text: "The runner is not running in a Kubernetes cluster, so it cannot start build pods" }, false);
  const ns = s.namespace;
  let pods: KPod[];
  let pvcs: { metadata: { name: string; labels?: Record<string, string> } }[];
  try {
    [pods, pvcs] = await Promise.all([api.listPods(ns, envSelector(env.id)), api.listPvcs(ns, envSelector(env.id))]);
  } catch (e) {
    return report({ state: "fail", text: `The Kubernetes API did not answer: ${(e as Error).message}`.slice(0, 300) }, false);
  }
  // Claims need the capabilities, before any health is known.
  kubeReport(db, env.id, caps, env.slots, undefined, true);

  let access = state.access.get(env.id);
  if (!access || now() - access.at > ACCESS_EVERY_MS) {
    const wanted: [string, string][] = [["create", "pods"], ["delete", "pods"], ["get", "pods"], ["create", "persistentvolumeclaims"], ["delete", "persistentvolumeclaims"]];
    const allowed = await Promise.all(wanted.map(([v, r]) => api.canI(ns, v, r).catch(() => false)));
    access = { at: now(), missing: wanted.filter((_, i) => !allowed[i]).map(([v, r]) => `${v} ${r}`) };
    state.access.set(env.id, access);
  }
  const image = s.image ?? d.defaultImage;
  const ctx: EnvCtx = { d, api, env, s, image, pods, pending: [] };

  const runs = db.prepare("SELECT * FROM build_pod_runs WHERE env_id = ? ORDER BY task_id").all(env.id) as Run[];
  for (const run of runs) await advance(ctx, run);

  const back = state.backoff.get(env.id);
  const paused = back && back.until > now();
  if (image && !access.missing.length && !paused) {
    const active = (db.prepare("SELECT COUNT(*) AS n FROM build_pod_runs WHERE env_id = ?").get(env.id) as { n: number }).n;
    const free = env.slots - active;
    if (free > 0) {
      for (const t of claim(db, env.id, free, now()).tasks) {
        const err = await start(ctx, t.id);
        if (err) {
          state.backoff.set(env.id, { until: now() + CREATE_BACKOFF_MS, why: err });
          break;
        }
        state.backoff.delete(env.id);
      }
    }
  }

  // Pods and volumes no run owns: a finished stage whose delete failed, or a task that is no longer this environment's.
  const owned = db.prepare("SELECT task_id, pod, pvc FROM build_pod_runs WHERE env_id = ?").all(env.id) as { task_id: number; pod: string | null; pvc: string }[];
  const podNames = new Set(owned.map((r) => r.pod)), pvcNames = new Set(owned.map((r) => r.pvc));
  for (const p of pods) if (!podNames.has(p.metadata.name)) await api.deletePod(ns, p.metadata.name).catch((e: Error) => d.log(`pod launcher: delete pod ${p.metadata.name}: ${e.message}`));
  for (const v of pvcs) if (!pvcNames.has(v.metadata.name)) await api.deletePvc(ns, v.metadata.name).catch((e: Error) => d.log(`pod launcher: delete volume ${v.metadata.name}: ${e.message}`));

  const backNow = state.backoff.get(env.id);
  const health: Omit<EnvHealth, "since"> | null =
    access.missing.length ? { state: "fail", text: `The runner may not ${access.missing.join(", ")} in namespace ${ns}` }
    : !image ? { state: "fail", text: "No AutoCraft image is known for build pods: set AUTOCRAFT_IMAGE on the runner or the environment's image" }
    : backNow && backNow.until > now() ? { state: "fail", text: `A build pod could not be created: ${backNow.why}`.slice(0, 300) }
    : ctx.pending.length ? { state: "warn", text: ctx.pending[0]! }
    : !Object.keys(s.toolchainImages).length ? { state: "warn", text: "No toolchain image is set, so tasks that name a toolchain (every pipeline build) are not taken" }
    : null;
  report(health, true);
}

type EnvCtx = { d: LauncherDeps; api: KubeApi; env: EnvRow; s: KubeSettings; image: string | null; pods: KPod[]; pending: string[] };

const taskOf = (db: DatabaseSync, id: number) => db.prepare("SELECT id, state, env_id, plan, requires, log_bytes FROM build_tasks WHERE id = ?").get(id) as TaskRow | undefined;

/** Claims are undone when the task's first pod cannot be created; returns the error then. */
async function start(c: EnvCtx, taskId: number): Promise<string | null> {
  const { db } = c.d;
  const key = newPodKey(taskId);
  const pvc = `acb-${taskId}-${randomBytes(3).toString("hex")}`;
  const at = new Date((c.d.now ?? Date.now)()).toISOString();
  db.prepare("INSERT INTO build_pod_runs (task_id, env_id, key_hash, pvc, stage, started_at) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, c.env.id, hashKey(key), pvc, STAGE_TASK, at);
  try {
    startTask(db, c.env.id, taskId);
    await c.api.createPvc(c.s.namespace, pvcSpec(c.s, c.env.id, taskId, pvc));
    const run = db.prepare("SELECT * FROM build_pod_runs WHERE task_id = ?").get(taskId) as Run;
    await createPod(c, run, STAGE_TASK, (ctx) => taskPod(ctx, c.image!, key));
    c.d.log(`pod launcher: task ${taskId} started on ${c.env.id}`);
    return null;
  } catch (e) {
    const msg = (e as Error).message;
    c.d.log(`pod launcher: task ${taskId}: could not start: ${msg}`);
    await c.api.deletePvc(c.s.namespace, pvc).catch(() => {});
    db.prepare("DELETE FROM build_pod_runs WHERE task_id = ?").run(taskId);
    releaseClaim(db, c.env.id, taskId);
    return msg;
  }
}

/** Creates the pod of `stage` and records it on the run. */
async function createPod(c: EnvCtx, run: Run, stage: number, spec: (ctx: PodCtx) => object, deadlineSec = APP_POD_SEC): Promise<void> {
  const now = (c.d.now ?? Date.now)();
  const left = c.s.deadlineSec - (now - Date.parse(run.started_at)) / 1000;
  const name = `acb-${run.task_id}-${stage}-${randomBytes(3).toString("hex")}`;
  const ctx: PodCtx = { s: c.s, envId: c.env.id, taskId: run.task_id, stage, name, pvc: run.pvc, deadlineSec: Math.min(deadlineSec, left) };
  c.d.db.prepare("UPDATE build_pod_runs SET stage = ?, pod = ?, pod_created_at = ? WHERE task_id = ?").run(stage, name, new Date(now).toISOString(), run.task_id);
  run.stage = stage;
  run.pod = name;
  run.pod_created_at = new Date(now).toISOString();
  await c.api.createPod(c.s.namespace, spec(ctx));
}

async function removeRun(c: EnvCtx, run: Run): Promise<void> {
  if (run.pod) await c.api.deletePod(c.s.namespace, run.pod).catch(() => {});
  await c.api.deletePvc(c.s.namespace, run.pvc).catch(() => {});
  c.d.db.prepare("DELETE FROM build_pod_runs WHERE task_id = ?").run(run.task_id);
}

async function lose(c: EnvCtx, run: Run, reason: string): Promise<void> {
  c.d.log(`pod launcher: task ${run.task_id}: ${reason}`);
  await removeRun(c, run);
  loseTask(c.d.db, run.task_id, reason, "Cancelled; its build pod stopped.");
}

/** Appends a container's output to the task log under `step`, within the task's log cap. */
async function podLog(c: EnvCtx, run: Run, container: string, step: string): Promise<void> {
  const t = taskOf(c.d.db, run.task_id);
  if (!t || !run.pod) return;
  let text: string;
  try {
    text = await c.api.podLog(c.s.namespace, run.pod, container, Math.max(1024, MAX_LOG_BYTES - t.log_bytes));
  } catch (e) {
    text = `(the output of ${container} could not be read: ${(e as Error).message})\n`;
  }
  // A quarter of the chunk cap in characters stays under it in bytes.
  for (let i = 0; i < text.length; i += MAX_CHUNK_BYTES / 4) {
    if (appendLog(c.d.db, c.env.id, run.task_id, step, text.slice(i, i + MAX_CHUNK_BYTES / 4)).truncated) break;
  }
}

/** Why a pod ended without its containers saying so. */
function podFailure(pod: KPod): string {
  const st = pod.status;
  if (st?.reason === "DeadlineExceeded") return "The build pod passed its deadline";
  return `The build pod failed${st?.reason ? ` (${st.reason}${st.message ? `: ${st.message}` : ""})` : ""}`.slice(0, 300);
}

async function advance(c: EnvCtx, run: Run): Promise<void> {
  const { db } = c.d;
  const now = (c.d.now ?? Date.now)();
  const t = taskOf(db, run.task_id);
  if (!t || t.env_id !== c.env.id || (t.state !== "claimed" && t.state !== "running")) return removeRun(c, run);
  const pod = run.pod ? c.pods.find((p) => p.metadata.name === run.pod) : undefined;
  const age = now - Date.parse(run.pod_created_at ?? run.started_at);
  if (!pod) {
    if (run.pod && age < LIST_GRACE_MS) return touchTask(db, c.env.id, t.id);
    return lose(c, run, "The build pod disappeared before it finished (deleted, or its node went away).");
  }
  const phase = pod.status?.phase;
  if (phase !== "Succeeded" && phase !== "Failed") {
    touchTask(db, c.env.id, t.id);
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const pull = statuses.find((s) => PULL_REASONS.has(s.state?.waiting?.reason ?? ""));
    if (pull && age > PULL_LIMIT_MS) return lose(c, run, `The build pod's container ${pull.name} could not start: ${pull.state!.waiting!.reason}${pull.state!.waiting!.message ? ` (${pull.state!.waiting!.message})` : ""}`.slice(0, 300));
    if (phase === "Pending" && !statuses.some((s) => s.state?.running || s.state?.terminated)) {
      const sched = pod.status?.conditions?.find((x) => x.type === "PodScheduled");
      const why = sched?.status === "False" ? sched.message ?? sched.reason ?? "not scheduled" : pull ? `${pull.state!.waiting!.reason}` : "starting";
      if (sched?.status === "False" && age > PENDING_LIMIT_MS) return lose(c, run, `No node took the build pod within ${minutes(PENDING_LIMIT_MS)}: ${why}`.slice(0, 300));
      if (age > PENDING_WARN_MS) c.pending.push(`The build pod of task ${t.id} has waited ${minutes(age)} to start: ${why}`.slice(0, 300));
    }
    return;
  }
  return endStage(c, run, t, pod);
}

async function endStage(c: EnvCtx, run: Run, t: TaskRow, pod: KPod): Promise<void> {
  const { db } = c.d;
  const plan = json<TaskStep[]>(t.plan, []);
  const groups = groupsOf(plan);
  const up = uploadStage(plan);

  if (run.stage === STAGE_TASK) {
    await podLog(c, run, "task", "source");
    if (statusOf(pod, "task")?.state?.terminated?.exitCode !== 0) return lose(c, run, `The task pod could not read its task: ${podFailure(pod)}`);
    // No key is valid while repository code runs; the upload pod gets a new one.
    db.prepare("UPDATE build_pod_runs SET key_hash = ? WHERE task_id = ?").run(hashKey(randomBytes(32).toString("hex")), run.task_id);
    return next(c, run, STAGE_SOURCE, (ctx) => sourcePod(ctx, c.image!));
  }
  if (run.stage === STAGE_SOURCE) {
    await podLog(c, run, "source", "source");
    const term = statusOf(pod, "source")?.state?.terminated;
    if (!term) return lose(c, run, podFailure(pod));
    const r = parsePrepared(term.message);
    if (term.exitCode !== 0 || !r.ok) return finish(c, run, r.ok ? `source failed (exit ${term.exitCode})` : r.summary);
    const image = toolchainImage(c.s, json<Requires>(t.requires, {}).toolchains);
    if (!image) return finish(c, run, `no toolchain image for ${json<Requires>(t.requires, {}).toolchains?.join(", ") || "this task"}`);
    const kept: Kept = { ...r.prepared, image };
    db.prepare("UPDATE build_pod_runs SET prepared = ? WHERE task_id = ?").run(JSON.stringify(kept), run.task_id);
    run.prepared = JSON.stringify(kept);
    return startGroup(c, run, plan, 0);
  }
  if (run.stage >= FIRST_GROUP && run.stage < up) {
    const g = groups[run.stage - FIRST_GROUP]!;
    const results = json<TaskResult[]>(run.results, []);
    let failed: string | null = null;
    let ran = run.ran;
    const pkg = statusOf(pod, PACKAGES_CONTAINER);
    if (pkg) {
      await podLog(c, run, PACKAGES_CONTAINER, "environment");
      const term = pkg.state?.terminated;
      if (term && term.exitCode !== 0) failed = term.message?.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300) || "the toolchain image lacks packages the CI gate installs";
    }
    for (const i of failed ? [] : g.steps) {
      const step = plan[i]!;
      const st = statusOf(pod, stepContainer(i))?.state;
      const term = st?.terminated;
      const startedAt = term?.startedAt ?? st?.running?.startedAt;
      if (!term && !startedAt) break;
      await podLog(c, run, stepContainer(i), step.name);
      const end = term?.finishedAt ? Date.parse(term.finishedAt) : (c.d.now ?? Date.now)();
      const durationMs = Math.max(0, end - (startedAt ? Date.parse(startedAt) : end)) || 0;
      // Exit 124 is `timeout`'s; a kill after its grace (137) or the pod's deadline also ends the step as timed out.
      const timedOut = !term || term.exitCode === 124 || (term.exitCode === 137 && durationMs >= step.timeoutSec * 1000);
      const oomKilled = term?.reason === "OOMKilled";
      results.push({ step: step.name, exitCode: timedOut ? null : term!.exitCode, durationMs, timedOut, ...(oomKilled ? { oomKilled } : {}) });
      ran = Math.max(ran, i + 1);
      if (timedOut) failed = `${step.name} timed out`;
      else if (term!.exitCode !== 0) failed = pod.status?.reason === "Evicted" ? `${step.name} failed: ${pod.status.message ?? "evicted"}`.slice(0, 300) : `${step.name} failed (exit ${term!.exitCode})`;
      if (failed) break;
    }
    if (!failed && pod.status?.phase === "Failed") return lose(c, run, podFailure(pod));
    db.prepare("UPDATE build_pod_runs SET results = ?, ran = ?, failed = ? WHERE task_id = ?").run(JSON.stringify(results), ran, failed, run.task_id);
    Object.assign(run, { results: JSON.stringify(results), ran, failed });
    const nextGroup = run.stage - FIRST_GROUP + 1;
    if (!failed && nextGroup < groups.length) return startGroup(c, run, plan, nextGroup);
    if (plan.slice(0, ran).some((s) => s.artifacts?.length)) {
      const key = newPodKey(run.task_id);
      db.prepare("UPDATE build_pod_runs SET key_hash = ? WHERE task_id = ?").run(hashKey(key), run.task_id);
      return next(c, run, up, (ctx) => uploadPod(ctx, c.image!, key, ran));
    }
    return finish(c, run, failed);
  }
  if (run.stage === up) {
    await podLog(c, run, "upload", "artifacts");
    if (statusOf(pod, "upload")?.state?.terminated?.exitCode !== 0) appendLog(db, c.env.id, run.task_id, "artifacts", `artifact upload failed: ${podFailure(pod)}\n`);
    return finish(c, run, run.failed);
  }
  return lose(c, run, `The build pod run is at an unknown stage ${run.stage}`);
}

async function startGroup(c: EnvCtx, run: Run, plan: TaskStep[], index: number): Promise<void> {
  const g = groupsOf(plan)[index]!;
  const kept = json<Kept | null>(run.prepared, null);
  if (!kept) return lose(c, run, "The build pod run lost its source report");
  // The steps' own limits, a minute each to copy the source, and two minutes to start the pod.
  const deadline = g.steps.reduce((n, i) => n + plan[i]!.timeoutSec + 60, 120);
  return next(c, run, FIRST_GROUP + index, (ctx) => stepPod(ctx, kept.image, plan, g, kept, index === 0), deadline);
}

/** Deletes the stage's pod and creates the next; past the task's deadline the task fails instead. */
async function next(c: EnvCtx, run: Run, stage: number, spec: (ctx: PodCtx) => object, deadlineSec?: number): Promise<void> {
  if (run.pod) await c.api.deletePod(c.s.namespace, run.pod).catch(() => {});
  const left = c.s.deadlineSec - ((c.d.now ?? Date.now)() - Date.parse(run.started_at)) / 1000;
  if (left < 60) return finish(c, run, run.failed ?? `the task passed its deadline of ${c.s.deadlineSec} s`);
  try {
    await createPod(c, run, stage, spec, deadlineSec);
  } catch (e) {
    return lose(c, run, `The next build pod could not be created: ${(e as Error).message}`.slice(0, 300));
  }
}

async function finish(c: EnvCtx, run: Run, failed: string | null): Promise<void> {
  const results = json<TaskResult[]>(run.results, []);
  const kept = json<Kept | null>(run.prepared, null);
  const environment: SandboxEnv | undefined = kept
    ? { image: kept.image, baseImage: kept.image, packages: kept.packages, craftFontsRef: kept.craftFontsRef, craftI18nRev: kept.craftI18nRev }
    : undefined;
  const summary = failed ?? (results.length ? `${results.length} step${results.length === 1 ? "" : "s"} passed` : "no step ran");
  try {
    finishTask(c.d.db, c.env.id, run.task_id, { results, summary, ...(environment ? { environment } : {}) });
  } catch (e) {
    c.d.log(`pod launcher: task ${run.task_id}: finish: ${(e as Error).message}`);
  }
  await removeRun(c, run);
}

/** Runs passes until `signal` aborts. Started by the runner; a pass with no kubernetes environment reads one table. */
export function startPodLauncher(db: DatabaseSync, signal: AbortSignal, log: (line: string) => void): void {
  const deps: LauncherDeps = { db, api: inClusterApi(), defaultImage: envVar("IMAGE") ?? null, log };
  const state = new LauncherState();
  void (async () => {
    while (!signal.aborted) {
      try {
        await launcherPass(deps, state);
      } catch (e) {
        log(`pod launcher: ${(e as Error).stack ?? e}`);
      }
      await sleep(PASS_MS, undefined, { signal }).catch(() => {});
    }
  })();
}

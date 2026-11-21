// Kubernetes build environments: settings, the stages of a task and the pod and volume specs.
//
// A task runs as a sequence of pods that share one volume (PVC) on a build node:
//   stage 0  task     AutoCraft image, network `api`: fetches the task with the pod key, writes /work/task.json
//   stage 1  source   AutoCraft image, network `fetch`: source tarball, patch, CI gate inputs; reports them in its termination message
//   stage 2+ steps    toolchain image, one pod per run of consecutive plan steps with the same network mode (`fetch` or `none`);
//                     each step is a container (ordered init containers, the last one the pod's container), so the runner
//                     reads exit codes, OOM kills and times from pod status and output from the pod log
//   last     upload   AutoCraft image, network `api`: uploads the artifacts of the steps that ran (only when a step names any)
// The pod key reaches only the `api` pods, which run no repository code; it can fetch the task and upload artifacts,
// never report a result. `none` pods have no egress; `fetch` pods reach DNS and public 80/443 (the cluster's NetworkPolicies).
import type { Capabilities, KubeSettings, TaskStep } from "../../web/src/api/types.ts";
export type { KubeSettings };
import { BuildError } from "./envs.ts";


export const DEFAULT_SETTINGS: KubeSettings = {
  namespace: "craft-builds", image: null, toolchainImages: {}, workerUrl: "http://autocraft-worker-api.craft.svc:8981",
  cpuRequest: "2", cpuLimit: "4", memoryRequest: "4Gi", memoryLimit: "8Gi", ephemeralRequest: "4Gi", ephemeralLimit: "16Gi",
  storage: "40Gi", storageClass: "local-path", deadlineSec: 3 * 3600, runtimeClassName: null, arch: "x86_64",
};

export const APP_LABEL = { "app.kubernetes.io/name": "autocraft-build" } as const;
/** The uid of the AutoCraft image; the toolchain images run as the same uid. */
export const POD_UID = 10001;
export const envSelector = (envId: string): string => `app.kubernetes.io/name=autocraft-build,craft.build/env=${envId}`;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,299}$/;
const QUANTITY = /^([0-9]+(\.[0-9]+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;
const TOOLCHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const UNITS: Record<string, number> = { "": 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };

/** A Kubernetes quantity as a number (cores or bytes). */
export function quantity(q: string): number {
  const m = QUANTITY.exec(q);
  return m ? Number(m[1]) * UNITS[m[3] ?? ""]! : NaN;
}

function checkQuantity(v: unknown, name: string): string {
  if (typeof v !== "string" || !QUANTITY.test(v) || !(quantity(v) > 0)) throw new BuildError(400, `${name} must be a Kubernetes quantity such as 4, 500m or 8Gi`);
  return v;
}

function checkImage(v: unknown, name: string): string {
  if (typeof v !== "string" || !IMAGE_RE.test(v)) throw new BuildError(400, `${name} must be an image reference`);
  return v;
}

export function settingsOf(json: string | null): KubeSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(json ? (JSON.parse(json) as Partial<KubeSettings>) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Applies a partial settings object to `base`; anything unknown or malformed is refused. */
export function parseSettings(input: unknown, base: KubeSettings = DEFAULT_SETTINGS): KubeSettings {
  if (input === undefined) return { ...base };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BuildError(400, "settings must be an object");
  const o = input as Record<string, unknown>;
  const out: KubeSettings = { ...base, toolchainImages: { ...base.toolchainImages } };
  for (const [k, v] of Object.entries(o)) {
    switch (k) {
      case "namespace":
        if (typeof v !== "string" || !DNS_LABEL.test(v)) throw new BuildError(400, "namespace must be a Kubernetes namespace name");
        out.namespace = v;
        break;
      case "image":
        out.image = v === null ? null : checkImage(v, "image");
        break;
      case "toolchainImages": {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "toolchainImages must map toolchain names to images");
        const m: Record<string, string> = {};
        for (const [t, img] of Object.entries(v as Record<string, unknown>)) {
          if (!TOOLCHAIN_RE.test(t)) throw new BuildError(400, `toolchain name ${t} is not valid`);
          if (img !== null) m[t] = checkImage(img, `toolchainImages.${t}`);
        }
        if (Object.keys(m).length > 20) throw new BuildError(400, "at most 20 toolchain images");
        out.toolchainImages = m;
        break;
      }
      case "workerUrl":
        if (typeof v !== "string" || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v)) throw new BuildError(400, "workerUrl must be http(s)://host[:port]");
        out.workerUrl = v;
        break;
      case "cpuRequest": case "cpuLimit": case "memoryRequest": case "memoryLimit": case "ephemeralRequest": case "ephemeralLimit": case "storage":
        out[k] = checkQuantity(v, k);
        break;
      case "storageClass":
        if (typeof v !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(v)) throw new BuildError(400, "storageClass must be a storage class name");
        out.storageClass = v;
        break;
      case "deadlineSec":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 300 || v > 48 * 3600) throw new BuildError(400, "deadlineSec must be 300 to 172800");
        out.deadlineSec = v;
        break;
      case "runtimeClassName":
        if (v !== null && (typeof v !== "string" || !DNS_LABEL.test(v))) throw new BuildError(400, "runtimeClassName must be a runtime class name or null");
        out.runtimeClassName = v as string | null;
        break;
      case "arch":
        if (v !== "x86_64" && v !== "aarch64") throw new BuildError(400, "arch must be x86_64 or aarch64");
        out.arch = v;
        break;
      default:
        throw new BuildError(400, `settings.${k} cannot be set`);
    }
  }
  for (const [req, lim] of [["cpuRequest", "cpuLimit"], ["memoryRequest", "memoryLimit"], ["ephemeralRequest", "ephemeralLimit"]] as const) {
    if (quantity(out[req]) > quantity(out[lim])) throw new BuildError(400, `${req} must not exceed ${lim}`);
  }
  return out;
}

/** What a task's pods offer, for claim matching: no display, no GPU, and only the toolchains that have an image. */
export function kubeCapabilities(s: KubeSettings): Capabilities {
  return {
    os: "linux", arch: s.arch, cpus: Math.max(1, Math.floor(quantity(s.cpuLimit))), memGb: Math.floor(quantity(s.memoryLimit) / 1024 ** 3),
    diskGb: Math.floor(quantity(s.storage) / 1024 ** 3), display: false, gpu: false, toolchains: Object.keys(s.toolchainImages).sort(),
  };
}

// ---- stages ------------------------------------------------------------------

export type Group = { network: "none" | "fetch"; steps: number[] };

/** Runs of consecutive steps with the same network mode. */
export function groupsOf(plan: TaskStep[]): Group[] {
  const out: Group[] = [];
  plan.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && last.network === s.network) last.steps.push(i);
    else out.push({ network: s.network, steps: [i] });
  });
  return out;
}

export const STAGE_TASK = 0;
export const STAGE_SOURCE = 1;
export const FIRST_GROUP = 2;
export const uploadStage = (plan: TaskStep[]): number => FIRST_GROUP + groupsOf(plan).length;

/** The toolchain image of a task: the first of its toolchains that has one, or the only image when it names none. */
export function toolchainImage(s: KubeSettings, toolchains: string[] | undefined): string | null {
  const names = toolchains?.length ? toolchains : Object.keys(s.toolchainImages).sort();
  for (const t of names) if (s.toolchainImages[t]) return s.toolchainImages[t]!;
  return null;
}

/** What the source pod found, from its termination message. */
export type Prepared = { env: Record<string, string>; mounts: { sub: string; target: string }[]; packages: string[]; craftFontsRef: string | null; craftI18nRev: string | null };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MOUNT_SUB = /^ext\/(craft-fonts|craft-i18n)\/[0-9a-f]{40}$/;
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const REF = /^[0-9a-f]{40}$/;

/** Reads the source pod's termination message; anything malformed is a failure with that reason. */
export function parsePrepared(message: string | undefined): { ok: true; prepared: Prepared } | { ok: false; summary: string } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(message ?? "") as Record<string, unknown>;
  } catch {
    return { ok: false, summary: "source: the source pod ended without a report" };
  }
  if (!o || typeof o !== "object") return { ok: false, summary: "source: the source pod's report is not valid" };
  if (o.ok !== true) return { ok: false, summary: typeof o.summary === "string" ? o.summary.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300) : "source failed" };
  const env = o.env as Record<string, unknown> | undefined;
  const mounts = o.mounts as { sub?: unknown; target?: unknown }[] | undefined;
  const packages = o.packages as unknown[] | undefined;
  const ref = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" && REF.test(v) ? v : undefined);
  const fonts = ref(o.craftFontsRef), i18n = ref(o.craftI18nRev);
  const bad =
    !env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 40 || Object.entries(env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== "string" || v.length > 1000 || v.includes("\0")) ||
    !Array.isArray(mounts) || mounts.length > 2 || mounts.some((m) => typeof m.sub !== "string" || !MOUNT_SUB.test(m.sub) || (m.target !== "/craft-fonts" && m.target !== "/craft-i18n")) ||
    !Array.isArray(packages) || packages.length > 100 || packages.some((p) => typeof p !== "string" || !PKG_RE.test(p)) || fonts === undefined || i18n === undefined;
  if (bad) return { ok: false, summary: "source: the source pod's report is not valid" };
  return { ok: true, prepared: { env: env as Record<string, string>, mounts: mounts as Prepared["mounts"], packages: packages as string[], craftFontsRef: fonts, craftI18nRev: i18n } };
}

// ---- specs -------------------------------------------------------------------

export type PodCtx = { s: KubeSettings; envId: string; taskId: number; stage: number; name: string; pvc: string; deadlineSec: number };

/**
 * Each step copies the pristine tree into its own /src (the container runtime's "writes are dropped after the step") and runs
 * under `timeout`: exit 124 is a timeout, 137 a kill after the 10 s grace.
 */
export const STEP_WRAPPER = 'cp -a /pristine/. /src/ || { echo "could not copy the source tree" >&2; exit 125; }; t=$1; shift; exec timeout -k 10 "$t" "$@"';
/** Fails before any step when the toolchain image lacks a package the repo's CI gate installs: pod mode cannot add packages. */
export const PACKAGES_CHECK = "missing=''; for p in \"$@\"; do dpkg-query -W -f='${Status}' \"$p\" 2>/dev/null | grep -q 'install ok installed' || missing=\"$missing $p\"; done; " +
  "if [ -n \"$missing\" ]; then echo \"the toolchain image lacks packages the CI gate installs:$missing (build pods cannot install packages)\" | tee /dev/termination-log >&2; exit 3; fi";
export const PACKAGES_CONTAINER = "packages";
export const stepContainer = (i: number): string => `step-${i}`;

function resources(s: KubeSettings) {
  return {
    requests: { cpu: s.cpuRequest, memory: s.memoryRequest, "ephemeral-storage": s.ephemeralRequest },
    limits: { cpu: s.cpuLimit, memory: s.memoryLimit, "ephemeral-storage": s.ephemeralLimit },
  };
}

function container(s: KubeSettings, name: string, image: string, extra: Record<string, unknown>) {
  return {
    name, image, imagePullPolicy: "IfNotPresent", resources: resources(s),
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
    ...extra,
  };
}

const envList = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

function pod(c: PodCtx, network: "api" | "fetch" | "none", volumes: object[], initContainers: object[], containers: object[]) {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name: c.name, namespace: c.s.namespace,
      labels: { ...APP_LABEL, "craft.build/env": c.envId, "craft.build/task": String(c.taskId), "craft.build/stage": String(c.stage), "craft.build/network": network },
    },
    spec: {
      restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false, activeDeadlineSeconds: Math.max(60, Math.round(c.deadlineSec)),
      terminationGracePeriodSeconds: 5,
      ...(c.s.runtimeClassName ? { runtimeClassName: c.s.runtimeClassName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: POD_UID, runAsGroup: POD_UID, fsGroup: POD_UID, seccompProfile: { type: "RuntimeDefault" } },
      volumes: [{ name: "work", persistentVolumeClaim: { claimName: c.pvc } }, ...volumes],
      ...(initContainers.length ? { initContainers } : {}),
      containers,
    },
  };
}

export function pvcSpec(s: KubeSettings, envId: string, taskId: number, name: string) {
  return {
    apiVersion: "v1", kind: "PersistentVolumeClaim",
    metadata: { name, namespace: s.namespace, labels: { ...APP_LABEL, "craft.build/env": envId, "craft.build/task": String(taskId) } },
    spec: { accessModes: ["ReadWriteOnce"], storageClassName: s.storageClass, resources: { requests: { storage: s.storage } } },
  };
}

/** A pod of the AutoCraft image running `worker pod <phase>`. */
function appPod(c: PodCtx, image: string, phase: "task" | "source" | "upload", network: "api" | "fetch", env: Record<string, string>, workReadOnly: boolean) {
  return pod(c, network, [{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } }], [], [
    container(c.s, phase, image, {
      args: ["worker", "pod", phase],
      env: envList({ HOME: "/tmp", XDG_CACHE_HOME: "/tmp", AUTOCRAFT_POD_TASK: String(c.taskId), ...env }),
      volumeMounts: [{ name: "work", mountPath: "/work", readOnly: workReadOnly }, { name: "tmp", mountPath: "/tmp" }],
    }),
  ]);
}

export const taskPod = (c: PodCtx, image: string, key: string) =>
  appPod(c, image, "task", "api", { AUTOCRAFT_POD_KEY: key, AUTOCRAFT_WORKER_URL: c.s.workerUrl }, false);
export const sourcePod = (c: PodCtx, image: string) => appPod(c, image, "source", "fetch", {}, false);
export const uploadPod = (c: PodCtx, image: string, key: string, ran: number) =>
  appPod(c, image, "upload", "api", { AUTOCRAFT_POD_KEY: key, AUTOCRAFT_WORKER_URL: c.s.workerUrl, AUTOCRAFT_POD_RAN: String(ran) }, true);

/** One group of steps. Offline steps get the CI gate's env and the craft-fonts / craft-i18n checkouts; a `fetch` step gets neither, as in the container runtime. */
export function stepPod(c: PodCtx, image: string, plan: TaskStep[], group: Group, prepared: Prepared, checkPackages: boolean) {
  const offline = group.network === "none";
  const volumes: object[] = [];
  const steps = group.steps.map((i) => {
    const step = plan[i]!;
    volumes.push({ name: `src-${i}`, emptyDir: {} }, { name: `tmp-${i}`, emptyDir: { sizeLimit: "2Gi" } });
    const mounts: object[] = [
      { name: "work", mountPath: "/pristine", subPath: "src", readOnly: true },
      { name: `src-${i}`, mountPath: "/src" },
      { name: `tmp-${i}`, mountPath: "/tmp" },
      ...(step.bare ? [] : [{ name: "work", mountPath: "/target", subPath: "target" }, { name: "work", mountPath: "/cache", subPath: "cache" }]),
      { name: "work", mountPath: "/out", subPath: `out/${i}` },
      ...(offline ? prepared.mounts.map((m) => ({ name: "work", mountPath: m.target, subPath: m.sub, readOnly: true })) : []),
    ];
    return container(c.s, stepContainer(i), image, {
      command: ["/bin/sh", "-c", STEP_WRAPPER, "step", String(step.timeoutSec), ...step.cmd],
      workingDir: "/src",
      env: envList({ ...(offline ? prepared.env : {}), HOME: "/tmp", CARGO_HOME: "/cache/cargo", CARGO_TARGET_DIR: "/target", CI: "1" }),
      volumeMounts: mounts,
    });
  });
  const check = checkPackages && prepared.packages.length
    ? [container(c.s, PACKAGES_CONTAINER, image, { command: ["/bin/sh", "-c", PACKAGES_CHECK, "check", ...prepared.packages], env: envList({ HOME: "/tmp" }), volumeMounts: [{ name: "pkg-tmp", mountPath: "/tmp" }] })]
    : [];
  if (check.length) volumes.push({ name: "pkg-tmp", emptyDir: { sizeLimit: "64Mi" } });
  return pod(c, group.network, volumes, [...check, ...steps.slice(0, -1)], steps.slice(-1));
}

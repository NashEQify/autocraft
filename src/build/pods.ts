// Kubernetes build environments: settings, the stages of a task and the pod and volume specs.
//
// A task runs as a sequence of pods that share one volume (PVC) on a build node:
//   stage 0  task     AutoCraft image, network `api`: fetches the task with the pod key, writes /work/task.json
//   stage 1  source   AutoCraft image, network `fetch`: source tarball, patch, CI gate inputs; reports them in its termination message
//   stage 2+ steps    toolchain image, one pod per run of consecutive plan steps with the same network mode (`fetch`, `mirror` or `none`);
//                     each step is a container (ordered init containers, the last one the pod's container), so the runner
//                     reads exit codes, OOM kills and times from pod status and output from the pod log
//   last     upload   AutoCraft image, network `api`: uploads the artifacts of the steps that ran (only when a step names any)
// The pod key reaches only the `api` pods, which run no repository code; it can fetch the task and upload artifacts,
// never report a result. `none` pods have no egress; `fetch` pods reach DNS and public 80/443; `mirror` pods reach only the
// crate mirror, which stands in for crates.io and GitHub (the cluster's NetworkPolicies).
// A warm producer environment (`warmWriter`) runs step `warm` tasks: its offline pod restores the previous warm version,
// builds at the CI paths with compile-cache writes, and publishes the result (warmPod below).
import { createHash } from "node:crypto";
import type { Capabilities, KubeSettings, TaskStep } from "../../web/src/api/types.ts";
export type { KubeSettings };
import { BuildError } from "./envs.ts";
import { slugOf } from "../owners.ts";
import { CACHE_VERSION, MAX_WARM_COMMAND } from "../worker/gate.ts";


export const DEFAULT_SETTINGS: KubeSettings = {
  namespace: "craft-builds", image: null, toolchainImages: {}, workerUrl: "http://autocraft-worker-api.craft.svc:8981",
  cpuRequest: "4", cpuLimit: "16", memoryRequest: "4Gi", memoryLimit: "8Gi", ephemeralRequest: "4Gi", ephemeralLimit: "16Gi",
  maxPodMemory: "64Gi", capacity: "cluster", nodeReserveCpu: "0", nodeReserveMemory: "0", priorityClassName: "craft-build-task",
  storage: "40Gi", storageClass: "local-path", deadlineSec: 3 * 3600, maxStepSec: 7200, runtimeClassName: null, arch: "x86_64",
  workspaceSlots: 12, workspaceCpuRequest: "2", workspaceCpuLimit: "16", workspaceMemoryRequest: "12Gi", workspaceMemoryLimit: "40Gi",
  workspaceEphemeralRequest: "4Gi", workspaceEphemeralLimit: "16Gi", workspaceStorage: "40Gi", sccacheUrl: null,
  warmWriter: false, cacheWriteUrl: null, writerSecret: null, signingSecret: null, crateMirror: null,
};

export const APP_LABEL = { "app.kubernetes.io/name": "autocraft-build" } as const;
/** The uid of the AutoCraft image; the toolchain images run as the same uid. */
export const POD_UID = 10001;
export const envSelector = (envId: string): string => `app.kubernetes.io/name=autocraft-build,craft.build/env=${envId}`;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,299}$/;
const QUANTITY = /^([0-9]+(\.[0-9]+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;
const TOOLCHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
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

/** A quantity that may be zero (a reserve). */
function checkReserve(v: unknown, name: string): string {
  if (typeof v !== "string" || !QUANTITY.test(v) || !(quantity(v) >= 0)) throw new BuildError(400, `${name} must be a Kubernetes quantity such as 0, 2 or 8Gi`);
  return v;
}

function checkImage(v: unknown, name: string): string {
  if (typeof v !== "string" || !IMAGE_RE.test(v)) throw new BuildError(400, `${name} must be an image reference`);
  return v;
}

export function settingsOf(json: string | null): KubeSettings {
  try {
    const stored = json ? (JSON.parse(json) as Partial<KubeSettings>) : {};
    // Environments stored before capacity existed keep their fixed slots until an operator switches them.
    return { ...DEFAULT_SETTINGS, ...stored, ...(json && stored.capacity === undefined ? { capacity: "fixed" as const } : {}) };
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
      case "cpuRequest": case "cpuLimit": case "memoryRequest": case "memoryLimit": case "ephemeralRequest": case "ephemeralLimit": case "storage": case "maxPodMemory":
      case "workspaceCpuRequest": case "workspaceCpuLimit": case "workspaceMemoryRequest": case "workspaceMemoryLimit":
      case "workspaceEphemeralRequest": case "workspaceEphemeralLimit": case "workspaceStorage":
        out[k] = checkQuantity(v, k);
        break;
      case "nodeReserveCpu": case "nodeReserveMemory":
        out[k] = checkReserve(v, k);
        break;
      case "capacity":
        if (v !== "cluster" && v !== "fixed") throw new BuildError(400, "capacity must be cluster or fixed");
        out.capacity = v;
        break;
      case "priorityClassName":
        if (v !== null && (typeof v !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(v))) throw new BuildError(400, "priorityClassName must be a priority class name or null");
        out.priorityClassName = v as string | null;
        break;
      case "workspaceSlots":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 200) throw new BuildError(400, "workspaceSlots must be 0 to 200");
        out.workspaceSlots = v;
        break;
      case "storageClass":
        if (typeof v !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(v)) throw new BuildError(400, "storageClass must be a storage class name");
        out.storageClass = v;
        break;
      case "deadlineSec":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 300 || v > 48 * 3600) throw new BuildError(400, "deadlineSec must be 300 to 172800");
        out.deadlineSec = v;
        break;
      case "maxStepSec":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 60 || v > 7200) throw new BuildError(400, "maxStepSec must be 60 to 7200");
        out.maxStepSec = v;
        break;
      case "runtimeClassName":
        if (v !== null && (typeof v !== "string" || !DNS_LABEL.test(v))) throw new BuildError(400, "runtimeClassName must be a runtime class name or null");
        out.runtimeClassName = v as string | null;
        break;
      case "sccacheUrl": case "cacheWriteUrl":
        if (v !== null && (typeof v !== "string" || !URL_RE.test(v))) throw new BuildError(400, `${k} must be http(s)://host[:port][/path] or null`);
        out[k] = v as string | null;
        break;
      case "writerSecret": case "signingSecret":
        if (v !== null && (typeof v !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(v))) throw new BuildError(400, `${k} must be a Secret name or null`);
        out[k] = v as string | null;
        break;
      case "crateMirror":
        if (v !== null && (typeof v !== "string" || !IPV4.test(v))) throw new BuildError(400, "crateMirror must be the mirror's ClusterIP (IPv4) or null");
        out.crateMirror = v as string | null;
        break;
      case "warmWriter":
        if (typeof v !== "boolean") throw new BuildError(400, "warmWriter must be true or false");
        out.warmWriter = v;
        break;
      case "arch":
        if (v !== "x86_64" && v !== "aarch64") throw new BuildError(400, "arch must be x86_64 or aarch64");
        out.arch = v;
        break;
      default:
        throw new BuildError(400, `settings.${k} cannot be set`);
    }
  }
  for (const [req, lim] of [["cpuRequest", "cpuLimit"], ["memoryRequest", "memoryLimit"], ["ephemeralRequest", "ephemeralLimit"],
    ["workspaceCpuRequest", "workspaceCpuLimit"], ["workspaceMemoryRequest", "workspaceMemoryLimit"], ["workspaceEphemeralRequest", "workspaceEphemeralLimit"]] as const) {
    if (quantity(out[req]) > quantity(out[lim])) throw new BuildError(400, `${req} must not exceed ${lim}`);
  }
  if (quantity(out.memoryLimit) > quantity(out.maxPodMemory)) throw new BuildError(400, "memoryLimit must not exceed maxPodMemory");
  if (out.warmWriter) {
    const missing = (["sccacheUrl", "cacheWriteUrl", "writerSecret", "signingSecret"] as const).filter((k) => !out[k]);
    if (missing.length) throw new BuildError(400, `a warm writer needs ${missing.join(", ")}`);
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

// ---- pod timing (build and workspace pods) -----------------------------------

/** A pod not yet started after this long shows in the environment's health. */
export const PENDING_WARN_MS = 3 * 60_000;
/** A pod no node takes within this long is given up. */
export const PENDING_LIMIT_MS = 15 * 60_000;
/** An image that cannot be pulled for this long fails the pod. */
export const PULL_LIMIT_MS = 3 * 60_000;
/** A pod still being deleted after this long, or whose node has not reported for this long, is given up. */
export const STUCK_MS = 5 * 60_000;
/** Creates of a pod that fail (or whose pod vanishes before it starts) are tried at most this many times. */
export const CREATE_TRIES = 6;
/** A pod just created may be missing from a list for a moment. */
export const LIST_GRACE_MS = 30_000;
export const PULL_REASONS = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError", "CreateContainerError"]);

// ---- stages ------------------------------------------------------------------

export type Group = { network: TaskStep["network"]; steps: number[] };

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
export type Prepared = {
  env: Record<string, string>; mounts: { sub: string; target: string }[]; packages: string[]; craftFontsRef: string | null; craftI18nRev: string | null;
  /** The CI gate's cache-version; null (or absent, in a run prepared before it was reported) when the repo has no gate. */
  cacheVersion?: string | null;
  /** The CI gate's warm-command, reported for warm tasks only; null: the default warm build. */
  warmCommand?: string | null;
};

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
  const cacheVersion = o.cacheVersion === undefined || o.cacheVersion === null ? null : typeof o.cacheVersion === "string" && CACHE_VERSION.test(o.cacheVersion) ? o.cacheVersion : undefined;
  const warmCommand = o.warmCommand === undefined || o.warmCommand === null ? null : typeof o.warmCommand === "string" && o.warmCommand.length <= MAX_WARM_COMMAND && !o.warmCommand.includes("\0") ? o.warmCommand : undefined;
  const bad =
    !env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 40 || Object.entries(env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== "string" || v.length > 1000 || v.includes("\0")) ||
    !Array.isArray(mounts) || mounts.length > 2 || mounts.some((m) => typeof m.sub !== "string" || !MOUNT_SUB.test(m.sub) || (m.target !== "/craft-fonts" && m.target !== "/craft-i18n")) ||
    !Array.isArray(packages) || packages.length > 100 || packages.some((p) => typeof p !== "string" || !PKG_RE.test(p)) || fonts === undefined || i18n === undefined || cacheVersion === undefined || warmCommand === undefined;
  if (bad) return { ok: false, summary: "source: the source pod's report is not valid" };
  return { ok: true, prepared: { env: env as Record<string, string>, mounts: mounts as Prepared["mounts"], packages: packages as string[], craftFontsRef: fonts, craftI18nRev: i18n, cacheVersion, warmCommand } };
}

// ---- specs -------------------------------------------------------------------

/**
 * `memory`: the repository's step memory (src/build/sizing.ts); absent, the environment's. `node`: the node the run was placed
 * on; the pod may run only there (its volume binds or is bound there).
 */
export type PodCtx = { s: KubeSettings; envId: string; taskId: number; stage: number; name: string; pvc: string; deadlineSec: number; memory?: StepMemory | null; node?: string | null };

/**
 * Each step copies the pristine tree into its own /src (the container runtime's "writes are dropped after the step") and runs
 * under `timeout`: exit 124 is a timeout, 137 a kill after the 10 s grace.
 */
// The children are copied, not `/pristine/.`: /src is a mount point the pod's user doesn't own, so cp could not set its times.
const COPY_SOURCE = 'find /pristine -mindepth 1 -maxdepth 1 -exec cp -a -t /src/ {} + || { echo "could not copy the source tree" >&2; exit 125; }';
export const STEP_WRAPPER = `${COPY_SOURCE}; t=$1; shift; exec timeout -k 10 "$t" "$@"`;
/**
 * A step that reads the compile cache: rustc runs through sccache, and the cache's hit counts end the step's output. sccache
 * keys a compile on every CARGO_* variable, and the CI gate builds with CARGO_TERM_COLOR set; the wrapper gives that value to
 * rustc alone, because cargo would colour the step's output and artifacts with it. An image without sccache builds uncached.
 */
export const CACHE_STEP_WRAPPER = [
  COPY_SOURCE,
  "if command -v sccache >/dev/null 2>&1; then",
  `  printf '%s\\n' '#!/bin/sh' 'exec env "CARGO_TERM_COLOR=$AUTOCRAFT_CI_TERM_COLOR" sccache "$@"' > /tmp/.rustc-wrapper && chmod 755 /tmp/.rustc-wrapper && export RUSTC_WRAPPER=/tmp/.rustc-wrapper`,
  'else echo "the toolchain image has no sccache: this step builds without the compile cache" >&2; fi',
  't=$1; shift; timeout -k 10 "$t" "$@"; s=$?',
  'if [ -n "${RUSTC_WRAPPER:-}" ]; then echo "compile cache (sccache, read-only):"; timeout 60 sccache --show-stats; fi',
  "exit $s",
].join("\n");
/**
 * A warm producer's build step: as CACHE_STEP_WRAPPER, with compile-cache writes. It records `rustc -vV` for the warm
 * manifest. The step runs with CARGO_NET_OFFLINE (the gate's warm-command does not say --offline); the rustc wrapper drops
 * it, because sccache keys on CARGO_* variables and the CI runners whose entries the build shares do not set it.
 */
export const WARM_STEP_WRAPPER = [
  COPY_SOURCE,
  "rustc -vV > /meta/rustc.txt 2>/dev/null || true",
  'if [ -z "${SCCACHE_WEBDAV_ENDPOINT:-}" ]; then echo "the CI gate names no cache version: this step builds without the compile cache" >&2',
  "elif command -v sccache >/dev/null 2>&1; then",
  `  printf '%s\n' '#!/bin/sh' 'exec env -u CARGO_NET_OFFLINE "CARGO_TERM_COLOR=$AUTOCRAFT_CI_TERM_COLOR" sccache "$@"' > /tmp/.rustc-wrapper && chmod 755 /tmp/.rustc-wrapper && export RUSTC_WRAPPER=/tmp/.rustc-wrapper`,
  'else echo "the toolchain image has no sccache: this step builds without the compile cache" >&2; fi',
  't=$1; shift; timeout -k 10 "$t" "$@"; s=$?',
  'if [ -n "${RUSTC_WRAPPER:-}" ]; then echo "compile cache (sccache, read-write):"; timeout 60 sccache --show-stats; fi',
  "exit $s",
].join("\n");
/** Fails before any step when the toolchain image lacks a package the repo's CI gate installs: pod mode cannot add packages. */
export const PACKAGES_CHECK = "missing=''; for p in \"$@\"; do dpkg-query -W -f='${Status}' \"$p\" 2>/dev/null | grep -q 'install ok installed' || missing=\"$missing $p\"; done; " +
  "if [ -n \"$missing\" ]; then echo \"the toolchain image lacks packages the CI gate installs:$missing (build pods cannot install packages)\" | tee /dev/termination-log >&2; exit 3; fi";
export const PACKAGES_CONTAINER = "packages";
/** First in every step pod: the AutoCraft image measures the task's volume, which local-path does not cap (`worker pod disk`). */
export const DISK_CONTAINER = "disk";
export const WARM_RESTORE_CONTAINER = "warm-restore";
export const WARM_PUBLISH_CONTAINER = "warm-publish";
export const WARM_GC_CONTAINER = "warm-gc";
/** Hosts a `mirror` pod reaches through the crate mirror (hostAliases); nothing else resolves there. */
export const MIRROR_HOSTS = ["index.crates.io", "static.crates.io", "github.com", "api.github.com"];
/** ConfigMap in the build namespace with the mirror's CA certificate (`ca.crt`). */
export const MIRROR_CA_CONFIGMAP = "craft-mirror-ca";
const MIRROR_CA = "/etc/craft-mirror/ca.crt";
const MIRROR_ENV = { CARGO_HTTP_CAINFO: MIRROR_CA, GIT_SSL_CAINFO: MIRROR_CA, SSL_CERT_FILE: MIRROR_CA };
const SIGNING_KEY = "/keys/signing/private.pem";
/** ConfigMap in the build namespace with the public half of the signing key (`public.pem`): restore and gc verify with it, so only the publish holds the private key. */
export const WARM_VERIFY_CONFIGMAP = "warm-verify-key";
const VERIFY_KEY = "/keys/verify/public.pem";
const RUSTC_FILE = "/meta/rustc.txt";
const BAD_BLOBS_FILE = "/meta/bad-blobs";
/** The build start warm-restore records for the publish's trim (src/warm/trim.ts). */
const STAMP_FILE = "/meta/build-start.json";
export const ARCH_LABEL: Record<KubeSettings["arch"], string> = { x86_64: "amd64", aarch64: "arm64" };
export const stepContainer = (i: number): string => `step-${i}`;

/** A repository's step memory in bytes (src/build/sizing.ts). */
export type StepMemory = { requestBytes: number; limitBytes: number };

/** The task, source and upload pods and the disk and package checks: a small request, so they hold little room on a node. */
export const APP_CPU_REQUEST = "500m";
export const APP_MEMORY_REQUEST = "1Gi";
const APP_CPU_LIMIT = "4";
const APP_MEMORY_LIMIT = "8Gi";

type Resources = { requests: Record<string, string>; limits: Record<string, string> };

function appResources(s: KubeSettings): Resources {
  return {
    requests: { cpu: APP_CPU_REQUEST, memory: APP_MEMORY_REQUEST, "ephemeral-storage": s.ephemeralRequest },
    limits: { cpu: APP_CPU_LIMIT, memory: APP_MEMORY_LIMIT, "ephemeral-storage": s.ephemeralLimit },
  };
}

/** A step container's memory request and limit: the repository's size, or the environment's without one, each at most maxPodMemory. */
export function stepMemory(s: KubeSettings, m: StepMemory | null | undefined): { request: string; limit: string } {
  if (!m) return { request: s.memoryRequest, limit: s.memoryLimit };
  const max = quantity(s.maxPodMemory);
  const limit = Math.min(Math.ceil(m.limitBytes), max);
  return { request: String(Math.min(Math.ceil(m.requestBytes), limit)), limit: String(limit) };
}

/** A step container's resources; `extraMemory` bytes (the in-memory warm target) are added to its memory request and limit. */
function stepResources(s: KubeSettings, m: StepMemory | null | undefined, extraMemory = 0): Resources {
  const mem = stepMemory(s, m);
  const memory = (q: string) => (extraMemory ? String(Math.ceil(quantity(q) + extraMemory)) : q);
  return {
    requests: { cpu: s.cpuRequest, memory: memory(mem.request), "ephemeral-storage": s.ephemeralRequest },
    limits: { cpu: s.cpuLimit, memory: memory(mem.limit), "ephemeral-storage": s.ephemeralLimit },
  };
}

/** A warm target in memory takes this share more than the version's size: the build adds to what the restore put there. */
export const WARM_MEMORY_FACTOR = 1.2;
/** Above this much expected target (the same threshold as for consumers) the producer's target lives on the volume. */
export const WARM_MEMORY_MAX_BYTES = 32 * 1024 ** 3;
/** The memory a producer's pod adds for an in-memory target, or null when the target goes on the volume: no published version is known yet (the first build), or it is large. */
export function warmMemory(warm: WarmPod): number | null {
  if (!warm.bytes || warm.bytes <= 0) return null;
  const bytes = Math.ceil(warm.bytes * WARM_MEMORY_FACTOR);
  return bytes > WARM_MEMORY_MAX_BYTES ? null : bytes;
}

/**
 * The most CPU (millicores) and memory (bytes) one stage of a task requests: what its run holds on its node while it lives.
 * Stages run one at a time and a pod's request is its largest container's (steps are init containers), so this is the larger
 * of an app pod and a step pod. With `warm` it counts the in-memory warm target, which only a warm producer's offline pod has.
 */
export function taskRequest(s: KubeSettings, memory?: StepMemory | null, warm?: WarmPod): { cpuM: number; memBytes: number } {
  const extra = warm ? warmMemory(warm) ?? 0 : 0;
  return {
    cpuM: Math.ceil(Math.max(quantity(APP_CPU_REQUEST), quantity(s.cpuRequest)) * 1000),
    memBytes: Math.ceil(Math.max(quantity(APP_MEMORY_REQUEST), quantity(stepMemory(s, memory).request) + extra)),
  };
}

/**
 * The limits and ephemeral storage one stage counts against a quota, beside taskRequest's requests: the largest container's,
 * since every pod runs its containers one after another (steps are init containers).
 */
export function taskLimits(s: KubeSettings, memory?: StepMemory | null, warm?: WarmPod): { cpuM: number; memBytes: number; ephRequest: number; ephLimit: number } {
  const extra = warm ? warmMemory(warm) ?? 0 : 0;
  return {
    cpuM: Math.ceil(Math.max(quantity(APP_CPU_LIMIT), quantity(s.cpuLimit)) * 1000),
    memBytes: Math.ceil(Math.max(quantity(APP_MEMORY_LIMIT), quantity(stepMemory(s, memory).limit) + extra)),
    ephRequest: Math.ceil(quantity(s.ephemeralRequest)), ephLimit: Math.ceil(quantity(s.ephemeralLimit)),
  };
}

function container(name: string, image: string, resources: Resources, extra: Record<string, unknown>) {
  return {
    name, image, imagePullPolicy: "IfNotPresent", resources,
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
    ...extra,
  };
}

const envList = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

function pod(c: PodCtx, network: "api" | TaskStep["network"], volumes: object[], initContainers: object[], containers: object[], labels: Record<string, string> = {}, spec: Record<string, unknown> = {}) {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name: c.name, namespace: c.s.namespace,
      labels: { ...APP_LABEL, "craft.build/env": c.envId, "craft.build/task": String(c.taskId), "craft.build/stage": String(c.stage), "craft.build/network": network, ...labels },
    },
    spec: {
      restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false, activeDeadlineSeconds: Math.max(60, Math.round(c.deadlineSec)),
      terminationGracePeriodSeconds: 5,
      nodeSelector: { "kubernetes.io/arch": ARCH_LABEL[c.s.arch] },
      ...(c.node ? { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [c.node] }] }] } } } } : {}),
      ...(c.s.priorityClassName ? { priorityClassName: c.s.priorityClassName } : {}),
      ...(c.s.runtimeClassName ? { runtimeClassName: c.s.runtimeClassName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: POD_UID, runAsGroup: POD_UID, fsGroup: POD_UID, seccompProfile: { type: "RuntimeDefault" } },
      volumes: [{ name: "work", persistentVolumeClaim: { claimName: c.pvc } }, ...volumes],
      ...(initContainers.length ? { initContainers } : {}),
      containers,
      ...spec,
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
    container(phase, image, appResources(c.s), {
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

/** Where the CI runners check `repo` out (GITHUB_WORKSPACE), or null when its name cannot be a path segment. */
export function ciCheckout(repo: string): string | null {
  const name = slugOf(repo).split("/").pop() ?? "";
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".." ? `/home/runner/_work/${name}/${name}` : null;
}

/**
 * The env of a step that uses the compile cache. sccache's key covers the compiler, the arguments, the CARGO_* variables
 * and the working directory, so the step matches the CI gate's job: its env (CARGO_TERM_COLOR through the rustc wrapper),
 * CARGO_HOME, and the checkout and default target dir at the runner's paths (`ciCheckout`, no CARGO_TARGET_DIR). The store
 * is the gate's `sccache/<cache-version>`: read-only for build pods, which never get the cache's write credentials; a warm
 * producer's steps write it (their credentials come from the writer Secret, `writerEnv`).
 */
function ciEnv(gate: Record<string, string>): Record<string, string> {
  return { CARGO_INCREMENTAL: "0", CARGO_NET_RETRY: "10", RUST_BACKTRACE: "1", ...gate, AUTOCRAFT_CI_TERM_COLOR: gate.CARGO_TERM_COLOR ?? "always" };
}
function sccacheEnv(url: string, cacheVersion: string, write: boolean): Record<string, string> {
  return {
    SCCACHE_WEBDAV_ENDPOINT: url, SCCACHE_WEBDAV_KEY_PREFIX: `sccache/${cacheVersion}`, ...(write ? {} : { SCCACHE_WEBDAV_RW_MODE: "READ_ONLY" }),
    // A step falls back to plain rustc when the cache cannot be reached, and the server lives until the step ends.
    SCCACHE_IGNORE_SERVER_IO_ERROR: "1", SCCACHE_IDLE_TIMEOUT: "0",
  };
}
/** The writer Secret's credentials as env references: the values never pass through the runner or the pod spec. */
const writerEnv = (secret: string, user: string, password: string) => [
  { name: user, valueFrom: { secretKeyRef: { name: secret, key: "username" } } },
  { name: password, valueFrom: { secretKeyRef: { name: secret, key: "password" } } },
];

/** What a warm producer's offline pod adds (warmWriter environments, step `warm` tasks): the key, the toolchain image, and whether the store's gc runs after the publish. */
export type WarmPod = {
  key: string; gc: boolean;
  /** Size of the key's last published version (src/build/warm-queue.ts warmBytes); absent before the first publish. */
  bytes?: number | null;
  /** Blob sha256s consumers failed on (warm-sync's status): the publish fetches and repairs them. */
  recheck?: string[];
};
/** At most this many rechecked blobs go into one publish's env. */
export const MAX_RECHECK = 200;

/**
 * One group of steps, after a disk check (and, in the first group, a package check). Offline steps get the CI gate's env and
 * the craft-fonts / craft-i18n checkouts; a `fetch` or `mirror` step gets neither, as in the container runtime. A `mirror`
 * pod resolves crates.io and GitHub to the crate mirror and trusts its CA. With `sccacheUrl` set and a CI gate, offline
 * steps that mount the build dirs read the CI runners' compile cache (`ciEnv`, `sccacheEnv`), and their pod carries the
 * `craft.build/cache=read` label that lets it reach the cache's read-only port.
 *
 * With `warm` (an offline group of a warm producer): `warm-restore` fills a memory-backed target dir at the checkout with the
 * key's newest warm version, the steps build at the CI paths and write the compile cache, and `warm-publish` (then, when
 * due, `warm-gc`) publishes the target and CARGO_HOME. The pod carries `craft.build/cache=write`. Only the steps, the
 * publish and the gc get the writer credentials; only the publish mounts the signing key. The restore and the gc mount the
 * public key from the `warm-verify-key` ConfigMap.
 */
export function stepPod(c: PodCtx, image: string, appImage: string, plan: TaskStep[], group: Group, prepared: Prepared, checkPackages: boolean, repo: string, warm?: WarmPod) {
  const offline = group.network === "none";
  const mirror = group.network === "mirror";
  const checkout = ciCheckout(repo);
  const cacheVersion = prepared.cacheVersion;
  const writing = !!warm && offline && !!checkout;
  const cacheUrl = writing ? c.s.cacheWriteUrl : c.s.sccacheUrl;
  const cached = (step: TaskStep): boolean => offline && !step.bare && !!cacheUrl && !!cacheVersion && !!checkout;
  const atCi = (step: TaskStep): boolean => cached(step) || (writing && !step.bare);
  const target = writing ? `${checkout}/target` : null;
  const volumes: object[] = [{ name: "check-tmp", emptyDir: { sizeLimit: "64Mi" } }];
  if (mirror) volumes.push({ name: "mirror-ca", configMap: { name: MIRROR_CA_CONFIGMAP, items: [{ key: "ca.crt", path: "ca.crt" }] } });
  // In memory when the version's size is known and moderate (the build containers' memory limit grows by it); else on the task's volume.
  const extraMemory = writing ? warmMemory(warm!) : null;
  const targetVolume = extraMemory !== null
    ? { name: "warm-target" }
    : { name: "work", subPath: "target" };
  if (writing) {
    volumes.push(
      ...(extraMemory !== null ? [{ name: "warm-target", emptyDir: { medium: "Memory", sizeLimit: String(Math.ceil(quantity(stepMemory(c.s, c.memory).limit) + extraMemory)) } }] : []),
      { name: "warm-meta", emptyDir: { sizeLimit: "1Mi" } }, { name: "warm-tmp", emptyDir: { sizeLimit: "2Gi" } },
      { name: "warm-verify", configMap: { name: WARM_VERIFY_CONFIGMAP, items: [{ key: "public.pem", path: "public.pem" }] } },
      { name: "warm-signing", secret: { secretName: c.s.signingSecret, items: [{ key: "private.pem", path: "private.pem" }], defaultMode: 0o440 } },
    );
  }
  const gateEnv = { ...ciEnv(prepared.env), HOME: "/tmp", CARGO_HOME: "/cache/cargo", CI: "1" };
  const steps = group.steps.map((i) => {
    const step = plan[i]!;
    const ci = atCi(step);
    volumes.push({ name: `src-${i}`, emptyDir: { sizeLimit: c.s.ephemeralLimit } }, { name: `tmp-${i}`, emptyDir: { sizeLimit: "2Gi" } });
    // A step at the CI paths works in the runner's checkout path; /src is the same directory, for scripts that name it.
    const mounts: object[] = [
      { name: "work", mountPath: "/pristine", subPath: "src", readOnly: true },
      { name: `src-${i}`, mountPath: "/src" },
      ...(ci ? [{ name: `src-${i}`, mountPath: checkout }] : []),
      { name: `tmp-${i}`, mountPath: "/tmp" },
      ...(step.bare ? [] : [
        target ? { ...targetVolume, mountPath: target } : { name: "work", mountPath: ci ? `${checkout}/target` : "/target", subPath: "target" },
        { name: "work", mountPath: "/cache", subPath: "cache" },
      ]),
      ...(writing ? [{ name: "warm-meta", mountPath: "/meta" }] : []),
      { name: "work", mountPath: "/out", subPath: `out/${i}` },
      ...(offline ? prepared.mounts.map((m) => ({ name: "work", mountPath: m.target, subPath: m.sub, readOnly: true })) : []),
      ...(mirror ? [{ name: "mirror-ca", mountPath: "/etc/craft-mirror", readOnly: true }] : []),
    ];
    const env = ci
      ? {
        ...gateEnv, ...(cached(step) ? sccacheEnv(cacheUrl!, cacheVersion!, writing) : {}),
        ...(writing ? { CARGO_NET_OFFLINE: "true", ...(prepared.warmCommand ? { AUTOCRAFT_WARM_COMMAND: prepared.warmCommand } : {}) } : {}),
      }
      : { ...(offline ? prepared.env : {}), ...(mirror ? MIRROR_ENV : {}), HOME: "/tmp", CARGO_HOME: "/cache/cargo", CARGO_TARGET_DIR: "/target", CI: "1" };
    return container(stepContainer(i), image, stepResources(c.s, c.memory, extraMemory ?? 0), {
      command: ["/bin/sh", "-c", writing && ci ? WARM_STEP_WRAPPER : cached(step) ? CACHE_STEP_WRAPPER : STEP_WRAPPER, "step", String(stepCap(c.s, step)), ...step.cmd],
      workingDir: ci ? checkout : "/src",
      env: [...envList(env), ...(writing && cached(step) ? writerEnv(c.s.writerSecret!, "SCCACHE_WEBDAV_USERNAME", "SCCACHE_WEBDAV_PASSWORD") : [])],
      volumeMounts: mounts,
    });
  });
  const disk = container(DISK_CONTAINER, appImage, appResources(c.s), {
    args: ["worker", "pod", "disk"],
    env: envList({ HOME: "/tmp", AUTOCRAFT_POD_DISK_LIMIT: String(Math.floor(quantity(c.s.storage))) }),
    volumeMounts: [{ name: "work", mountPath: "/work", readOnly: true }, { name: "check-tmp", mountPath: "/tmp" }],
  });
  const check = checkPackages && prepared.packages.length
    ? [container(PACKAGES_CONTAINER, image, appResources(c.s), { command: ["/bin/sh", "-c", PACKAGES_CHECK, "check", ...prepared.packages], env: envList({ HOME: "/tmp" }), volumeMounts: [{ name: "check-tmp", mountPath: "/tmp" }] })]
    : [];
  const spec = mirror && c.s.crateMirror ? { hostAliases: [{ ip: c.s.crateMirror, hostnames: MIRROR_HOSTS }] } : {};
  if (!writing) {
    const labels: Record<string, string> = group.steps.some((i) => cached(plan[i]!)) ? { "craft.build/cache": "read" } : {};
    return pod(c, group.network, volumes, [disk, ...check, ...steps.slice(0, -1)], steps.slice(-1), labels, spec);
  }
  const w = warmPhases(c, appImage, warm!, target!, checkout!, image, gateEnv, cacheVersion ?? null, targetVolume, extraMemory);
  const [init, last] = warm!.gc ? [[...steps, w.publish], [w.gc]] : [steps, [w.publish]];
  return pod(c, group.network, volumes, [disk, ...check, w.restore, ...init], last, { "craft.build/cache": "write" }, spec);
}

/** The AutoCraft-image containers of a warm producer's pod (`worker pod warm-restore|warm-publish|warm-gc`, src/worker/pod.ts). */
function warmPhases(c: PodCtx, appImage: string, warm: WarmPod, target: string, checkout: string, image: string, gateEnv: Record<string, string>, cacheVersion: string | null, targetVolume: { name: string; subPath?: string }, extraMemory: number | null) {
  const v = (o: Record<string, string>) => envList({ HOME: "/tmp", ...Object.fromEntries(Object.entries(o).map(([k, x]) => [`AUTOCRAFT_WARM_${k}`, x])) });
  const signing = { name: "warm-signing", mountPath: "/keys/signing", readOnly: true };
  const verify = { name: "warm-verify", mountPath: "/keys/verify", readOnly: true };
  const tmp = { name: "warm-tmp", mountPath: "/tmp" };
  // What the tree was built with besides the image and the paths: the env every build step shares.
  const envHash = createHash("sha256").update(JSON.stringify([Object.entries(gateEnv).sort(), cacheVersion])).digest("hex");
  const writer = writerEnv(c.s.writerSecret!, "AUTOCRAFT_WARM_STORE_USER", "AUTOCRAFT_WARM_STORE_PASSWORD");
  const phase = (name: string, env: object[], mounts: object[], extraMemory: number | null = null) =>
    container(name, appImage, stepResources(c.s, c.memory, extraMemory ?? 0), { args: ["worker", "pod", name], env, volumeMounts: [...mounts, tmp] });
  return {
    restore: phase(WARM_RESTORE_CONTAINER, v({ STORE_URL: c.s.sccacheUrl!, KEY: warm.key, TARGET: target, VERIFY_KEYS: VERIFY_KEY, IMAGE: image, BAD_BLOBS_FILE, STAMP_FILE }),
      [{ ...targetVolume, mountPath: target }, { name: "warm-meta", mountPath: "/meta" }, verify], extraMemory),
    publish: phase(WARM_PUBLISH_CONTAINER, [
      ...v({ STORE_WRITE_URL: c.s.cacheWriteUrl!, KEY: warm.key, SIGNING_KEY, TARGET: target, CARGO_HOME: "/cache/cargo", CHECKOUT: checkout, IMAGE: image, ENV_HASH: envHash, RUSTC_FILE, BAD_BLOBS_FILE, STAMP_FILE,
        ...(warm.recheck?.length ? { RECHECK: warm.recheck.filter((x) => /^[0-9a-f]{64}$/.test(x)).slice(0, MAX_RECHECK).join(",") } : {}) }),
      ...writer,
    ], [
      { name: "work", mountPath: "/work", readOnly: true }, { name: "work", mountPath: "/cache", subPath: "cache", readOnly: true },
      { ...targetVolume, mountPath: target, readOnly: true }, { name: "warm-meta", mountPath: "/meta", readOnly: true }, signing,
    ]),
    gc: phase(WARM_GC_CONTAINER, [...v({ STORE_WRITE_URL: c.s.cacheWriteUrl!, VERIFY_KEYS: VERIFY_KEY }), ...writer], [verify]),
  };
}

/** A step's time limit: its own, capped by the environment's. */
export const stepCap = (s: KubeSettings, step: TaskStep): number => Math.min(step.timeoutSec, s.maxStepSec);

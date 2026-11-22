/**
 * Cluster capacity for build pods: a pure model over what the cluster reports. Free room on a node is
 * its allocatable minus the requests of every pod that is not a build pod, minus our own runs'
 * reservations there, minus a per-node reserve. Build pods are excluded because each run reserves its
 * largest stage's request for its whole life, so the pod itself would count twice.
 */
import type { KContainerSpec, KNode, KPod, KResourceQuota } from "./kube-api.ts";
import { APP_LABEL, quantity } from "./pods.ts";

/**
 * CPU in millicores, memory in bytes: requests. The optional fields are what quotas may also count: limits of CPU and
 * memory, and requests and limits of ephemeral storage. Nodes count requests only.
 */
export type Res = { cpu: number; mem: number; limCpu?: number; limMem?: number; ephReq?: number; ephLim?: number };
type QuotaKey = keyof Res;

export type CapNode = { name: string; ready: boolean; unschedulable: boolean; arch: string | undefined; labels: Record<string, string>; allocatable: Res };
export type CapPod = {
  name: string;
  /** null while the scheduler has not placed it. */
  node: string | null;
  phase: string;
  priority: number;
  request: Res;
  ours: boolean;
  /** PodScheduled=False with reason Unschedulable. */
  unschedulable: boolean;
};

export type CapacitySettings = {
  /** kubernetes.io/arch label value a build node must carry (amd64, arm64). */
  archLabel: string;
  /** Held back on every node for the node's own services. */
  nodeReserve: Res;
  /** Priority of build pods; a Pending Unschedulable pod above it makes us yield. */
  buildPriority: number;
};

export type NodeFree = { name: string; labels: Record<string, string>; free: Res };

export type Capacity = {
  /** Eligible nodes, most free CPU first. */
  nodes: NodeFree[];
  /** Quota room, or null when the namespace has no quota on these resources. */
  quota: Res | null;
  /** A higher-priority pod is waiting for room: claim nothing new this pass. */
  yield: boolean;
  /** The node a pod with this request would go to, or null. `prefer` names nodes tried first, in order. */
  fit(request: Res, prefer?: readonly string[]): string | null;
  /** `fit`, and deducts the request from that node and the quota so the next call sees it. */
  take(request: Res, prefer?: readonly string[]): string | null;
  /** Gives back a request taken earlier (on `node`, when it had one) and its share of the quota. */
  release(request: Res, node: string | null): void;
  /** How many more pods of this size fit, node by node and within quota. */
  countFit(request: Res): number;
};

const cpuOf = (q: string | undefined): number => (q === undefined ? 0 : Math.round(quantity(q) * 1000) || 0);
const memOf = (q: string | undefined): number => (q === undefined ? 0 : Math.round(quantity(q)) || 0);
const resOf = (r: Record<string, string> | undefined): Res => ({ cpu: cpuOf(r?.cpu), mem: memOf(r?.memory) });

export function toCapNode(n: KNode): CapNode {
  const ready = n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
  return {
    name: n.metadata.name, ready, unschedulable: n.spec?.unschedulable === true,
    arch: n.metadata.labels?.["kubernetes.io/arch"], labels: n.metadata.labels ?? {}, allocatable: resOf(n.status?.allocatable),
  };
}

/** Effective request of a pod: max(largest init container, sum of regular containers and sidecars) per resource, plus overhead. */
export function podRequest(spec: KPod["spec"]): Res {
  const req = (c: KContainerSpec) => resOf(c.resources?.requests);
  const inits = spec?.initContainers ?? [];
  const sum: Res = { cpu: 0, mem: 0 }, initMax: Res = { cpu: 0, mem: 0 };
  for (const c of spec?.containers ?? []) { const r = req(c); sum.cpu += r.cpu; sum.mem += r.mem; }
  for (const c of inits) {
    const r = req(c);
    if (c.restartPolicy === "Always") { sum.cpu += r.cpu; sum.mem += r.mem; } else { initMax.cpu = Math.max(initMax.cpu, r.cpu); initMax.mem = Math.max(initMax.mem, r.mem); }
  }
  const o = resOf(spec?.overhead);
  return { cpu: Math.max(sum.cpu, initMax.cpu) + o.cpu, mem: Math.max(sum.mem, initMax.mem) + o.mem };
}

export function toCapPod(p: KPod): CapPod {
  const sched = p.status?.conditions?.find((c) => c.type === "PodScheduled");
  return {
    name: p.metadata.name, node: p.spec?.nodeName || null, phase: p.status?.phase ?? "Unknown", priority: p.spec?.priority ?? 0,
    request: podRequest(p.spec), ours: p.metadata.labels?.["app.kubernetes.io/name"] === APP_LABEL["app.kubernetes.io/name"],
    unschedulable: sched?.status === "False" && sched.reason === "Unschedulable",
  };
}

const QUOTA_KEYS: [QuotaKey, string[], (q: string | undefined) => number][] = [
  ["cpu", ["requests.cpu", "cpu"], cpuOf], ["mem", ["requests.memory", "memory"], memOf], ["limCpu", ["limits.cpu"], cpuOf], ["limMem", ["limits.memory"], memOf],
  ["ephReq", ["requests.ephemeral-storage", "ephemeral-storage"], memOf], ["ephLim", ["limits.ephemeral-storage"], memOf],
];

/** Per quota key the smallest of `value(quota, its names)` across quotas; null when no quota limits any key. Missing cpu or mem is Infinity. */
function acrossQuotas(quotas: readonly KResourceQuota[], value: (q: KResourceQuota, name: string, parse: (s: string | undefined) => number) => number): Res | null {
  const out: Partial<Record<QuotaKey, number>> = {};
  for (const q of quotas) {
    for (const [key, names, parse] of QUOTA_KEYS) {
      const name = names.find((n) => q.status?.hard?.[n] !== undefined);
      if (name === undefined) continue;
      const v = value(q, name, parse);
      out[key] = Math.min(out[key] ?? Infinity, v);
    }
  }
  return Object.keys(out).length ? { ...out, cpu: out.cpu ?? Infinity, mem: out.mem ?? Infinity } : null;
}

/** Room left under the namespace's quotas (the smallest across quotas); null when none limits what build pods use. */
export function quotaRoom(quotas: readonly KResourceQuota[]): Res | null {
  return acrossQuotas(quotas, (q, name, parse) => parse(q.status?.hard?.[name]) - parse(q.status?.used?.[name]));
}

/** The smallest hard limit across the namespace's quotas; null when none limits what build pods use. A request above it never fits. */
export function quotaHard(quotas: readonly KResourceQuota[]): Res | null {
  return acrossQuotas(quotas, (q, name, parse) => parse(q.status?.hard?.[name]));
}

/** The quota keys of `room` that `r` exceeds. */
export function overQuota(room: Res, r: Res): QuotaKey[] {
  return QUOTA_KEYS.map(([k]) => k).filter((k) => room[k] !== undefined && (r[k] ?? 0) > room[k]!);
}

export type CapacityInput = {
  nodes: readonly CapNode[];
  /** Every pod in the cluster; finished pods are ignored. */
  pods: readonly CapPod[];
  /** Quota room (see quotaRoom), or null for none. */
  quota: Res | null;
  /** Our runs' reserved request per node. */
  reservations: ReadonlyMap<string, Res>;
  settings: CapacitySettings;
};

const fits = (free: Res, r: Res) => free.cpu >= r.cpu && free.mem >= r.mem && !overQuota(free, r).length;

export function computeCapacity(input: CapacityInput): Capacity {
  const { settings } = input;
  const used = new Map<string, Res>();
  const add = (node: string, r: Res) => {
    const u = used.get(node) ?? { cpu: 0, mem: 0 };
    u.cpu += r.cpu; u.mem += r.mem;
    used.set(node, u);
  };
  let yielding = false;
  for (const p of input.pods) {
    if (p.phase === "Succeeded" || p.phase === "Failed") continue;
    if (!p.ours && p.node) add(p.node, p.request);
    if (!p.ours && p.phase === "Pending" && p.unschedulable && p.priority > settings.buildPriority) yielding = true;
  }
  for (const [node, r] of input.reservations) add(node, r);

  const nodes: NodeFree[] = input.nodes
    .filter((n) => n.ready && !n.unschedulable && n.arch === settings.archLabel)
    .map((n) => {
      const u = used.get(n.name) ?? { cpu: 0, mem: 0 };
      return {
        name: n.name, labels: n.labels,
        free: {
          cpu: Math.max(0, n.allocatable.cpu - u.cpu - settings.nodeReserve.cpu),
          mem: Math.max(0, n.allocatable.mem - u.mem - settings.nodeReserve.mem),
        },
      };
    })
    .sort((a, b) => b.free.cpu - a.free.cpu || b.free.mem - a.free.mem || a.name.localeCompare(b.name));
  const quota = input.quota ? { ...input.quota } : null;

  const pick = (r: Res, prefer: readonly string[]): NodeFree | null => {
    if (quota && !fits(quota, r)) return null;
    for (const name of prefer) {
      const n = nodes.find((x) => x.name === name);
      if (n && fits(n.free, r)) return n;
    }
    // Most free room first, so the order is re-derived after each take.
    const ordered = [...nodes].sort((a, b) => b.free.cpu - a.free.cpu || b.free.mem - a.free.mem || a.name.localeCompare(b.name));
    return ordered.find((n) => fits(n.free, r)) ?? null;
  };
  return {
    nodes, quota, yield: yielding,
    fit: (r, prefer = []) => pick(r, prefer)?.name ?? null,
    take(r, prefer = []) {
      const n = pick(r, prefer);
      if (!n) return null;
      n.free.cpu -= r.cpu; n.free.mem -= r.mem;
      if (quota) for (const [k] of QUOTA_KEYS) if (quota[k] !== undefined) quota[k] = quota[k]! - (r[k] ?? 0);
      return n.name;
    },
    release(r, node) {
      const n = nodes.find((x) => x.name === node);
      if (n) { n.free.cpu += r.cpu; n.free.mem += r.mem; }
      if (quota) for (const [k] of QUOTA_KEYS) if (quota[k] !== undefined) quota[k] = quota[k]! + (r[k] ?? 0);
    },
    countFit(r) {
      if (r.cpu <= 0 && r.mem <= 0) return 0;
      let n = 0;
      for (const node of nodes) n += Math.min(r.cpu > 0 ? Math.floor(node.free.cpu / r.cpu) : Infinity, r.mem > 0 ? Math.floor(node.free.mem / r.mem) : Infinity);
      if (quota) for (const [k] of QUOTA_KEYS) if (quota[k] !== undefined && (r[k] ?? 0) > 0) n = Math.min(n, Math.floor(quota[k]! / r[k]!));
      return n;
    },
  };
}

/**
 * Fallback when the cluster pod list is forbidden: the quota is the only capacity figure, and claiming
 * stops while the last pod we created sits Unschedulable (the scheduler told us there is no room).
 */
export type FeedbackCapacity = { quota: Res | null; stop: boolean; fit(request: Res): boolean };

export function feedbackCapacity(quota: Res | null, lastCreated: KPod | null): FeedbackCapacity {
  const stop = lastCreated ? toCapPod(lastCreated).unschedulable : false;
  return { quota, stop, fit: (r) => !stop && (!quota || fits(quota, r)) };
}

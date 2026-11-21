// The few Kubernetes API calls the pod launcher makes, behind an interface so tests use a fake.
// The in-cluster client uses the runner container's service-account token and CA, read at each
// call because the projected token is rotated. Only `node:` modules: no client library.
import { readFileSync } from "node:fs";
import { request } from "node:https";

export const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export type ContainerState = {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: { exitCode: number; reason?: string; message?: string; startedAt?: string; finishedAt?: string };
};
export type ContainerStatus = { name: string; state?: ContainerState };
export type KPod = {
  metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string };
  spec?: { activeDeadlineSeconds?: number };
  status?: {
    phase?: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    reason?: string;
    message?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
  };
};
export type KPvc = { metadata: { name: string; labels?: Record<string, string> } };

export interface KubeApi {
  listPods(ns: string, selector: string): Promise<KPod[]>;
  createPod(ns: string, pod: object): Promise<void>;
  /** A pod that is already gone counts as deleted. */
  deletePod(ns: string, name: string): Promise<void>;
  podLog(ns: string, name: string, container: string, limitBytes: number): Promise<string>;
  listPvcs(ns: string, selector: string): Promise<KPvc[]>;
  createPvc(ns: string, pvc: object): Promise<void>;
  deletePvc(ns: string, name: string): Promise<void>;
  /** A SelfSubjectAccessReview: whether this service account may `verb` the `resource` in `ns`. */
  canI(ns: string, verb: string, resource: string): Promise<boolean>;
}

export class KubeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const enc = encodeURIComponent;

/** The client for the cluster the runner runs in, or null outside a cluster (no KUBERNETES_SERVICE_HOST). */
export function inClusterApi(env: NodeJS.ProcessEnv = process.env, dir = SA_DIR): KubeApi | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  const port = Number(env.KUBERNETES_SERVICE_PORT || 443);

  function call(method: string, path: string, body?: object, accept = "application/json"): Promise<string> {
    let token: string, ca: Buffer;
    try {
      token = readFileSync(`${dir}/token`, "utf8").trim();
      ca = readFileSync(`${dir}/ca.crt`);
    } catch (e) {
      return Promise.reject(new KubeError(0, `no service-account token in the runner container (${(e as NodeJS.ErrnoException).code ?? "error"})`));
    }
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        host, port, method, path, ca, timeout: 30_000,
        headers: { authorization: `Bearer ${token}`, accept, ...(data !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(text);
          let msg = text.slice(0, 300);
          try {
            msg = (JSON.parse(text) as { message?: string }).message ?? msg;
          } catch { /* not JSON */ }
          reject(new KubeError(status, `${method} ${path.split("?")[0]}: HTTP ${status} ${msg}`));
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new KubeError(0, `${method} ${path.split("?")[0]}: timed out`)));
      req.on("error", (e) => reject(e instanceof KubeError ? e : new KubeError(0, `${method} ${path.split("?")[0]}: ${e.message}`)));
      req.end(data);
    });
  }
  const gone = (e: unknown) => {
    if (!(e instanceof KubeError && e.status === 404)) throw e;
  };
  const pods = (ns: string) => `/api/v1/namespaces/${enc(ns)}/pods`;
  const pvcs = (ns: string) => `/api/v1/namespaces/${enc(ns)}/persistentvolumeclaims`;

  return {
    listPods: async (ns, selector) => (JSON.parse(await call("GET", `${pods(ns)}?labelSelector=${enc(selector)}`)) as { items: KPod[] }).items,
    createPod: async (ns, pod) => void (await call("POST", pods(ns), pod)),
    deletePod: (ns, name) => call("DELETE", `${pods(ns)}/${enc(name)}?gracePeriodSeconds=5`).then(() => {}, gone),
    podLog: (ns, name, container, limitBytes) => call("GET", `${pods(ns)}/${enc(name)}/log?container=${enc(container)}&limitBytes=${Math.max(1, limitBytes)}`, undefined, "*/*"),
    listPvcs: async (ns, selector) => (JSON.parse(await call("GET", `${pvcs(ns)}?labelSelector=${enc(selector)}`)) as { items: KPvc[] }).items,
    createPvc: async (ns, pvc) => void (await call("POST", pvcs(ns), pvc)),
    deletePvc: (ns, name) => call("DELETE", `${pvcs(ns)}/${enc(name)}`).then(() => {}, gone),
    canI: async (ns, verb, resource) => {
      const r = JSON.parse(await call("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
        apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { namespace: ns, verb, resource } },
      })) as { status?: { allowed?: boolean } };
      return r.status?.allowed === true;
    },
  };
}

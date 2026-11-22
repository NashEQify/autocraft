// Pure rules for a build pod that ended or never started: whether the cluster took it away (disruption, node loss),
// whether the task caused it, and what to do with a pod no node takes. The launcher applies them.
import type { KPod } from "./kube-api.ts";
import { PENDING_LIMIT_MS } from "./pods.ts";

export type PodEnd = "disruption" | "node-lost" | "own-fault" | "ok";
export type PendingKind = "capacity-wait" | "replace" | "wait";

/** Disruptions of one task that are recreated on the same volume; further ones count as failures. */
export const MAX_DISRUPTIONS = 3;

const DISRUPTION_REASONS = new Set(["PreemptionByScheduler", "TerminationByKubelet", "EvictionByEvictionAPI", "DeletionByTaintManager"]);

/**
 * `pod` is null when it vanished. `nodeReady` is the state of its node: true Ready, false NotReady, null missing or unknown.
 */
export function classifyPodEnd(pod: KPod | null, nodeReady: boolean | null): PodEnd {
  if (!pod) return nodeReady === true ? "disruption" : "node-lost";
  const st = pod.status;
  if (st?.conditions?.some((c) => c.type === "DisruptionTarget" && c.status === "True" && DISRUPTION_REASONS.has(c.reason ?? ""))) return "disruption";
  // The kubelet evicts for node pressure ("The node was low on resource: ...") and for the pod's own ephemeral storage or
  // emptyDir size limit; only the first is the cluster's doing.
  if (st?.reason === "Evicted") return /node was low on resource/i.test(st.message ?? "") ? "disruption" : "own-fault";
  const phase = st?.phase;
  if (phase === "Succeeded") return "ok";
  const statuses = [...(st?.initContainerStatuses ?? []), ...(st?.containerStatuses ?? [])];
  const ownFault = st?.reason === "DeadlineExceeded" || statuses.some((s) => s.state?.terminated?.reason === "OOMKilled" || (s.state?.terminated && s.state.terminated.exitCode !== 0));
  if (ownFault) return "own-fault";
  if (phase === "Failed") return nodeReady === true ? "own-fault" : "node-lost";
  if (phase === "Unknown") return nodeReady === true ? "ok" : "node-lost";
  return "ok";
}

/**
 * A pod still Pending. A stage pod pinned to its volume's node cannot move, so insufficient resources there is a wait
 * with no time limit; an unpinned first pod short of room past the pending limit is deleted and placed again.
 */
export function pendingKind(pod: KPod, ageMs: number, pinned: boolean): PendingKind {
  if (pod.status?.phase !== "Pending") return "wait";
  const sched = pod.status.conditions?.find((c) => c.type === "PodScheduled");
  if (sched?.status !== "False") return "wait";
  const short = sched.reason === "Unschedulable" && /insufficient/i.test(sched.message ?? "");
  if (pinned) return short ? "capacity-wait" : "wait";
  return short && ageMs > PENDING_LIMIT_MS ? "replace" : "wait";
}

/** A disruption recreates the stage without using an attempt, up to MAX_DISRUPTIONS per task; `disruptions` counts those so far. */
export function disruptionPolicy(disruptions: number): { recreate: boolean } {
  return { recreate: disruptions < MAX_DISRUPTIONS };
}

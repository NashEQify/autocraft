// The environment claim and launcher pass (package build-a).
import type { Db } from "../../db/index.ts";
import type { ClaimInputs, EnvPassState, NewPodRun, PodRun, PodRunPatch } from "./types.ts";

/** One `together` wave: the environment and its running count, the 500 queued candidates in order, other enabled environments, sizings, warm facts, live repos, started refs, batches and the pending worker update. */
export async function loadClaimInputs(db: Db, envId: string, nowMs: number): Promise<ClaimInputs> { throw new Error("not built: build.loadClaimInputs"); }
/** Every environment of the kind with settings, health and slots, their runs and tasks, and the node reservations, in one wave. */
export async function loadEnvPass(db: Db, kind: "kubernetes" | "workspace"): Promise<EnvPassState> { throw new Error("not built: build.loadEnvPass"); }
/** Inserts a pod run. */
export async function startPodRun(db: Db, row: NewPodRun): Promise<PodRun> { throw new Error("not built: build.startPodRun"); }
/** Updates pod runs with `kx.updateFrom` when patches differ, a plain `set` when equal. */
export async function savePodRuns(db: Db, rows: { taskId: number; patch: PodRunPatch }[]): Promise<number> { throw new Error("not built: build.savePodRuns"); }
/** Deletes pod runs of tasks. */
export async function removePodRuns(db: Db, taskIds: number[]): Promise<number> { throw new Error("not built: build.removePodRuns"); }
/** The environment and key hash of a pod task, for pod-key authentication. */
export async function findPodKey(db: Db, taskId: number): Promise<{ envId: string; keyHash: string; kind: string } | null> { throw new Error("not built: build.findPodKey"); }
/** One update: capabilities, slots, health (with `since` kept while text and state are unchanged), `last_seen_at`, and `confidential_online_at` by `CASE`. */
export async function reportKubeEnv(db: Db, r: { id: string; caps: unknown; slots?: number; health?: { state: string; text: string } | null; priorHealth?: { state: string; text: string; since: string } | null; reachable: boolean; at: string }): Promise<void> { throw new Error("not built: build.reportKubeEnv"); }

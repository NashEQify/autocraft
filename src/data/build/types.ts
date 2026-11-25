import type { Selectable } from "kysely";
import type {
  BuildEnv, BuildSummary, BuildTask, BuildTaskDetail, CacheReport, Requires, TaskFilter, TaskPage, TaskResult, TaskStep, WorkspacePage,
} from "../../../web/src/api/types.ts";
import type { DB } from "../../db/types.ts";
import type { KeySource } from "../keys.ts";

export type { BuildEnv, BuildSummary, BuildTask, BuildTaskDetail, CacheReport, Requires, TaskFilter, TaskPage, TaskResult, TaskStep, WorkspacePage };
import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
export type HiddenRepos = string[] & { visible?: string[] };
/** Which rows a viewer may see: hidden repos are filtered out, and only staff read logs and patches. */
export type ViewScope = { hiddenRepos: HiddenRepos; staff: boolean };
/** A list of ids, or an id subquery from a module's `fragments.ts`. */
export type IdSource = number[] | KeySource;
export type RefSource = Ref[] | KeySource;

export const TERMINAL: readonly TaskState[] = ["done", "failed", "cancelled", "lost"];
export const LOST_AFTER_MS = 2 * 60_000;
/** A task is claimed at most this often: the first time and one requeue after a lost worker. */
export const MAX_ATTEMPTS = 2;
export const MAX_QUEUED = 500;
export const KEEP_MS = 3650 * 24 * 3600_000;
export const ARTIFACT_KEEP_MS = 30 * 24 * 3600_000;
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;
export const WARM_STEP = "warm";
export const PRIVATE_STEPS: readonly string[] = ["fix-check", "scan-test"];
export const WORKSPACE_STATES = ["requested", "starting", "seeding", "ready", "parked", "ended", "failed"] as const;
export type WorkspaceStateName = (typeof WORKSPACE_STATES)[number];
export const LIVE_STATES: WorkspaceStateName[] = ["requested", "starting", "seeding", "ready", "parked"];
export const POD_STATES: WorkspaceStateName[] = ["starting", "seeding", "ready"];

export type TaskState = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled" | "lost";
export type Warm = { key: string; role: "use" | "build" };
export type SandboxEnv = Record<string, string>;
export type TaskRecord = {
  id: number; jobId: number | null; step: string; repo: string; number: number | null; headSha: string; baseSha: string | null; requires: Requires;
  priority: number; plan: TaskStep[]; state: TaskState; envId: string | null; attempts: number; queuedAt: string; claimedAt: string | null;
  startedAt: string | null; endedAt: string | null; heartbeatAt: string | null; cancelRequestedAt: string | null; results: TaskResult[]; summary: string | null;
  logBytes: number; artifactBytes: number; hasPatch: boolean; warmKey: string | null; warmRole: "use" | "build" | null; warmImage: string | null;
  warmVersion: string | null; warmRev: number | null; sandbox: SandboxEnv | null;
};
export type TaskLite = Pick<TaskRecord, "id" | "step" | "repo" | "number" | "headSha" | "state" | "envId" | "queuedAt" | "startedAt" | "endedAt" | "summary" | "jobId">;
export type TaskBrief = TaskLite & { logStep: string | null };
export type TaskStateRow = { state: TaskState; step: string; endedAt: string | null };
export type NewTask = {
  jobId?: number | null; step: string; repo: string; number?: number | null; headSha: string; baseSha?: string | null; requires?: Requires; priority?: number;
  plan: TaskStep[];
  /** Unified git diff applied to the checkout before the plan runs. */
  patch?: string;
  warm?: Warm; warmImage?: string; warmVersion?: string; warmRev?: number;
};
export type CancelOutcome = { id: number; repo: string; was: TaskState; result: "cancelled" | "already" | "missing" };
export type PodRun = Selectable<DB["build_pod_runs"]>;
export type NewPodRun = Omit<PodRun, "id">;
export type PodRunPatch = Partial<Omit<PodRun, "task_id">>;
export type WorkspaceRow = Selectable<DB["workspaces"]>;
export type SessionRow = Selectable<DB["workspace_sessions"]>;
export type WorkspaceCallRow = Selectable<DB["workspace_calls"]>;
export type NewSession = Omit<SessionRow, "id">;
export type ArtifactRow = { taskId: number; name: string; bytes: number; contentType: string; file: string; createdAt: string };

export type TaskCard = { id: number; step: string; state: TaskState; repo: string; number: number | null; startedAt: string | null; endedAt: string | null; logStep: string | null };
export type TaskEvent = { id: number; step: string; state: TaskState; queuedAt: string; startedAt: string | null; endedAt: string | null; summary: string | null; envId: string | null };
export type TaskHistoryStat = { n: number; newestId: number; ended: boolean; states: string };
export type MemRow = { repo: string; step: string; builds: number; peakMemBytes: number };
export type EnvTasks = { runs: PodRun[]; tasks: TaskRecord[] };
export type EnvRecord = BuildEnv & { keyHash?: string; kind: "worker" | "kubernetes" | "workspace" | string; settings: unknown; health: EnvHealth | null; confidentialOnlineAt: string | null };
export type EnvHealth = { state: string; text: string; since: string };
export type HealthPatch = { state: string; text: string };
export type EnvPatch = { id: string; label?: string; kind?: string; enabled?: boolean; settings?: unknown; keyHash?: string; slots?: number };
export type ClaimPick = { id: number; head?: string; base?: string; plan?: TaskStep[] };
export type ClaimFit = (task: TaskRecord) => boolean;
export type ClaimInputs = {
  env: EnvRecord | null; running: number; candidates: TaskRecord[]; otherEnvs: EnvRecord[]; sizings: Map<string, RepoSizing>; warm: Map<string, WarmFacts>;
  liveRepos: Set<string>; startedRefs: Set<Ref>; batches: Map<number, { id: number; repo: string; branch: string; commitSha: string; baseSha: string; fork: string | null; members: number[] }>;
  pendingUpdate: UpdateSpec | null;
};
export type EnvPassState = { envs: EnvRecord[]; tasks: Map<string, EnvTasks>; reservations: { node: string; cpuM: number; memBytes: number }[] };
export type LogTail = { text: string; bytes: number; truncated: boolean };

export type StepMemory = { requestBytes: number; limitBytes: number };
export type WarmTarget = "none" | "tmpfs" | "pvc";
export type MemorySource = "operator" | "history" | "oom" | "environment";
export type WarmSource = "operator" | "auto";
export type RepoSizing = {
  repo: string; memory: StepMemory | null; memorySource: MemorySource;
  /** The history size, also when another source wins; null below the minimum of measured builds. */
  history: (StepMemory & { builds: number }) | null;
  warmTarget: WarmTarget; warmSource: WarmSource; autoWarmTarget: WarmTarget; warmBytes: number | null; updatedAt: string | null; reason: string | null;
};
export type SizePatch = { repo: string; memory?: StepMemory | null; warmTarget?: WarmTarget | null; reset?: boolean; clear?: boolean; reason?: string | null };
export type WarmFacts = {
  head: string | null; atHead: { id: number; state: TaskState; claimedAt: string | null }[]; open: number; newestClaimedAt: string | null; forced: boolean;
};
export type StoredCaches = { version: 1; readAt: number | null; nodes: unknown[]; placement: unknown; placementNote: string | null; mirror: { allowlist: string[] | null; error: string | null; readAt: number } | null };
export type UpdateSpec = { sha: string; ssh: string; keyFile: string; gitDir: string };
export type WorkerUpdate = { pending: UpdateSpec | null; failures: { count: number; error: string } | null };
export type EndpointStatus = Record<string, unknown>;
export type WarmNote = { source: string | null; note: string | null };

export type WorkspaceRequest = { env: string; repo: string; number: number | null; head: string; baseSha?: string | null; purpose: string; requestedBy: string; deadlineSec?: number; warm?: boolean };
export type WorkspaceMove = { id: number; from: WorkspaceStateName[]; to: WorkspaceStateName; set?: Partial<Omit<WorkspaceRow, "id">> };
export type WorkspaceSource = { ids: number[] } | { env: string; states: WorkspaceStateName[] } | { remoteCallIds: number[] } | KeySource;
export type CallActivity = { running: { id: number; tool: string; deadlineAt: string }[]; shell: number };
export type WorkspacePass = { rows: WorkspaceRow[]; calls: Map<number, CallActivity>; bound: Map<number, "queued" | "leased"> };
export type NewWorkspaceCall = Omit<WorkspaceCallRow, "id">;
export type ToolCallQuery = { tool?: string; n?: number; id?: number; ids?: number[]; field?: "text" | "image" };
export type CallPage = { calls: WorkspaceCallRow[]; more: boolean };
export type SessionSource = { ids: number[] } | { workspaceIds: number[] } | { remoteCallId: number };
export type SweptSession = { id: number; workspaceId: number; keep: boolean; jobId: number | null; jobState: string | null; error: string | null };
export type WorkspaceQuery = { state: string; cursor?: string; limit: number };

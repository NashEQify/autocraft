import type { ItemRef } from "../../../web/src/api/types.ts";
import type { HelperStatus, Machine, Readiness, Reserve, TaskBundle, Tier } from "../../remote/protocol.ts";

export type { HelperStatus, Machine, Readiness, Reserve, TaskBundle, Tier };
import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
export type LowerLogin = string;
export type Role = "operator" | "maintainer" | "viewer";

export type CallState = "queued" | "leased" | "done" | "failed";
export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string; bundle: Omit<TaskBundle, "callId">;
  items: ItemRef[]; level: number; maxAttempts: number;
  /** A follow-up turn on the session of this call. */
  parentId?: number;
  referenceRepo?: string;
  /** Only this user's own Task Runners take the call. */
  forLogin?: string;
  boundSlot?: boolean;
};
export type CallSummary = {
  id: number; state: CallState; error: string | null; promptId: string; items: ItemRef[]; userLogin: string | null; ownLane: boolean;
  runId: number | null; since: number; consumedAt: number | null; jobId: number | null;
};
/** A queued call as claims read it: items parsed, the repos it names and its authors, plus the fields the queue view shows. */
export type QueuedCall = {
  id: number; promptId: string; promptVersion: string; tier: Tier; step: string; parentId: number | null; stickyLogin: string | null; seenAt: number;
  timeoutMs: number; refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>; releasedBy: string | null; releasedAt: number | null;
  forLogin: string | null; boundSlot: boolean; refusedToken: number | null; pickedBy: string | null; pickedAt: number | null; pickUntil: number | null;
  askedModel: string; queuedMs: number; queuedSince: number | null; error: string | null; level: number; jobId: number | null; since: number;
};
export type QueueSnapshot = { signature: string; calls: QueuedCall[]; running: { repoN: Map<string, number>; stepN: Map<string, number> } };
export type PollRow = {
  id: number; state: CallState; reply: string | null; error: string | null; runId: number | null; leasedAt: number | null; attempt: number;
  consumedAt: number | null; usage: string | null; turns: number | null; sessionId: string | null;
};
export type CallPoll = { call: PollRow | null; liveness: { alive: boolean; since: number }; lost: boolean; gone: boolean };

export type UserSettings = {
  reserve: Reserve; repos: string[]; maxCalls: number | null; interactiveSlots: number | null; manualOnly: boolean;
  skipTasks: string[]; taskItems: "all" | "started" | "mine"; runnerPrivate: boolean;
};
export type RunnerRow = {
  tokenId: number; login: string; role: Role | null; label: string | null; machine: Machine | null; helperVersion: string | null; createdAt: string; expiresAt: string;
  canAgent: boolean; canAnswer: boolean; readiness: Readiness | null; until: string | null; reason: string | null; harness: string | null;
  models: Partial<Record<Tier, string>>; reserve: Reserve | null; usage: unknown; reportedAt: number | null; slots: number | null; busy: number | null;
  lastError: string | null; idleClaimAt: number | null; idleTiers: Tier[] | null; idleRepos: string[] | null;
  /** Leases outside the own lane. */
  leased: number; ownLaneLeased: number; beatAt: number | null;
};
/** Rows of the workflow module's started-work load: live workflows and the PR of each implement workflow's current attempt. */
export type StartedWork = {
  live: { repo: string; number: number; entry: string; state: string; started_by: string; approved_by: string | null }[];
  prs: { repo: string; prNumber: number; started_by: string; approved_by: string | null }[];
};
export type RunnerSnapshot = {
  at: number; runners: RunnerRow[]; settings: Map<LowerLogin, UserSettings>; cooled: Map<LowerLogin, { until: string; reason: string }>;
  denied: ReadonlySet<string>; leasedByLogin: Map<LowerLogin, { leased: number; interactive: number }>; started: StartedWork;
};
export type LiveLease = { id: number; jobId: number | null; runId: number | null; login: string; promptId: string; items: ItemRef[]; repo: string | null; root: string | null };
export type HelperInfo = {
  tokenId: number; label: string | null; readiness: Readiness | null; until: string | null; reason: string | null; fresh: boolean; lastSeen: string | null;
  harness: string | null; models: Partial<Record<Tier, string>>; reserve: Reserve | null; usage: unknown; slots: number | null; machine: Machine | null;
  helperVersion: string | null; createdAt: string; expiresAt: string; canAgent: boolean; canAnswer: boolean; cooledUntil: string | null; cooledReason: string | null;
};

export type ClaimCaller = { tokenId: number; login: string; role: Role; claimId?: string };
export type ClaimFacts = {
  role: Role | null; idle: boolean; cooled: { until: string; reason: string } | null; settings: UserSettings; leased: number; interactive: number;
  signature: string; orphan: { id: number; runId: number | null; leaseSecretHash: string | null } | null; liveness: { alive: boolean; since: number };
  lost: number[]; gone: number[];
};
export type LeaseSource = {
  bundle: string; baseStdin: string | null; jobId: number | null; step: string; stage: number; promptId: string; promptVersion: string; askedModel: string; items: ItemRef[];
};
export type LeaseRequest = {
  id: number; caller: ClaimCaller; claim: unknown; model: string; caps: { perLogin: number | null; interactive: number | null }; started: StartedWork;
  clearIdle: boolean; bundle: string; live: () => boolean;
};
export type Lease = { id: number; secret: string; runId: number | null; bundle: string; attempt: number };
export type ExpiryResult = { requeued: number[]; failed: number[]; withdrawn: number[]; beaten: string[] };
export type ParsedSubmit = {
  reply: string; model: string | null; usage: unknown; turns: number | null; sessionId: string | null; tools: unknown[]; durationMs: number; refused?: boolean;
};
export type SubmitResult = { ok: boolean; state: CallState; requeued?: boolean; error?: string };
export type RefusalRetry = { tier: Tier; model: string } | null;

/**
 * What the pick rules read. `callState` is the call's state (null: no such call); `call` is read whatever its state. `runners` are the
 * user's live Task Runner credentials. `pickerLogins` are the lowercase logins whose picks count now. `cap`: how long a new pick counts, in ms
 * (null: until it ends otherwise). `max`: the most live picks one user holds whatever their slots (`PICKS_MAX`).
 */
export type PickContext = {
  call: QueuedCall | null; callState: CallState | null; runners: RunnerRow[]; livePicks: number; cooled: { until: string; reason: string } | null;
  pickerLogins: string[]; cap: number | null; max: number;
};
/** `limit`: the user already holds `max` live picks; `taken`: another user's pick counts, or the call is no longer queued. */
export type PickResult = "picked" | "limit" | "taken";
export type ReadyRunner = { login: string; role: string; manual: boolean; tiers: ReadonlySet<Tier>; free: number; repos: ReadonlySet<string> | null; skip: ReadonlySet<string> };
export type TakerSweepPlan = { insertRepos: string[]; deleteRepos: string[]; mark: number[]; clear: number[]; withdraw: { id: number; reason: string }[] };
export type SweepState = { snapshot: RunnerSnapshot; queue: QueueSnapshot; pipelineRepos: string[]; noTakerRepos: Map<string, number>; marked: Map<number, number> };
/**
 * Queued calls with a live caller, counted past each bucket's limit (`queuedMs`, the tier's `tierWaitMs`, `interactiveWaitMs`): `n` of them and
 * `oldestMs`, the epoch ms the oldest was queued (null when none). `ready` counts live credentials with a fresh, ready status, `manualOnly` those of
 * them whose user is Manual only. `noTakerRepos` are the pipeline-on repos marked without a taker for `noTakerMs`, with the mark's epoch ms.
 */
export type RunnerHealth = {
  queued: { total: number; oldestMs: number | null; byTier: Record<string, { n: number; oldestMs: number | null }>; interactive: { n: number; oldestMs: number | null } };
  lastLeaseAt: number | null; ready: number; manualOnly: number; noTakerRepos: { repo: string; since: number }[]; operatorRunners: { login: string; interactiveSlots: number | null }[];
};
export type RelayedCheck = { id: number; runId: number | null; input: string };
export type NewPassage = { callId: number; runId: number | null; login: string; repo: string; passageId: number; page: string; at: number };

/** `repo#number`, the key of the maps loaders return. */
// S1: same as RefKey in ../mirror/types.ts; import it from there once S1 is merged.
export type RefKey = string;
import type { TaskState } from "../build/types.ts";

export type PatchKind = "fixup" | "cifix" | "conflict";
/** NULL in `fixups.source` means "review". */
export type FixupSource = "review" | "premerge" | "operator";
export type FixupState = string;
export type ConflictState = string;
export type CheckKind = "fixup" | "fix";
export type MainFixVerdict = "code" | "infra" | "flaky";

export type Rowbase = { id: number; repo: string; number: number; createdAt: string };
export type FixupRow = Rowbase & {
  fromHead: string; toHead: string | null; state: FixupState; reason: string | null; source: FixupSource | null;
  attempt: number; lintTask: number | null; lintState: "pending" | "requeued" | null; operatorFix: number | null;
};
export type CifixRow = Rowbase & {
  head: string; toHead: string | null; kind: "format" | "code" | "infra"; state: string; reason: string | null;
  attempt: number; taskId: number | null; lintTask: number | null; runs: number[] | null;
};
export type ConflictRow = Rowbase & {
  fromHead: string; toHead: string | null; baseSha: string | null; state: ConflictState; reason: string | null;
  attempt: number; lintTask: number | null; ownDiff: "same" | "changed" | null;
};
/** A patch row that moved a PR head. */
export type PushEdge = {
  kind: PatchKind; id: number; from: string; to: string; state: "pushing" | "pushed" | "merged";
  source: FixupSource | null; ciKind?: string; ownDiff?: string | null; reason: string | null; at: string;
};
/** Rows oldest first by id; `pushes` newest first. */
export type PatchFacts = { fixups: FixupRow[]; cifixes: CifixRow[]; conflicts: ConflictRow[]; pushes: PushEdge[] };

/** A row in state `linting` with its patch. */
export type StoredPatch =
  | { kind: "fixup"; id: number; repo: string; number: number; head: string; source: FixupSource; attempt: number; patch: string; lintTask: number | null; lintRound: number; lintState: "pending" | "requeued"; session: string | null; operatorFix: number | null; changes: string[] }
  | { kind: "cifix"; id: number; repo: string; number: number; head: string; attempt: number; patch: string; files: string[]; lintTask: number | null; lintRound: number; lintState: string; session: string | null }
  | { kind: "conflict"; id: number; repo: string; number: number; head: string; attempt: number; patch: string; baseSha: string; files: string[]; lintTask: number | null; lintRound: number; session: string | null };

export type LintingRow = { kind: PatchKind; id: number; repo: string; number: number; head: string; lintTask: number | null; unsentSibling: number };

export type MainFixRow = {
  repo: string; headSha: string; check: string; verdict: MainFixVerdict; state: string; reason: string | null; runId: number | null;
  runUrl: string | null; excerpt: string | null; issueNumber: number | null; prNumber: number | null; prUrl: string | null; patch: string | null;
  files: string | null; lintTask: number | null; lintRound: number | null; lintState: string | null; session: string | null; createdAt: string; updatedAt: string;
};

export type PatchCheckRow = {
  id: number; kind: CheckKind; repo: string; number: number; subject: string; patchHash: string; round: number;
  verdict: "approve" | "reject"; reasons: string; problems: string[]; model: string; createdAt: string;
};
export type PatchCheckInput = { kind: CheckKind; repo: string; number: number; subject: string; patch: string; round: number; model: string; check: { verdict: "approve" | "reject"; reasons: string; problems: string[] }; at: string };

export type ModelCheckStep = "fixup" | "cifix" | "fixissue";
export type ModelCheckCommand = "fmt" | "clippy" | "check" | "test";
/** `fixissue` stays a step value for existing rows; nothing writes it. */
export type ModelCheckRow = {
  id: number; runId: number | null; step: ModelCheckStep; repo: string; number: number | null; head: string; command: ModelCheckCommand;
  crate: string | null; testName: string | null; taskId: number | null; outcome: string | null; startedAt: string; endedAt: string | null;
};
export type ModelCheckStart = Omit<ModelCheckRow, "id" | "outcome" | "endedAt" | "taskId">;
export type CheckShape = { command: ModelCheckCommand; crate?: string; testName?: string };

export type CifixFacts = { state: string; reason: string | null; attempt: number; formatterEnded: boolean; at: string | null; recorded: string[] };
export type FixupAtHead = { recorded: string[]; unsent?: { count: number; retryAt: string | null } };
export type LintFactOf = { step: PatchKind; source: FixupSource | "carry"; ended: boolean };
export type MadeBy = { kind: PatchKind; from: string; id: number; source: FixupSource | null };
export type OutcomeRow = { kind: PatchKind; state: string; reason: string | null; createdAt: string; unsent: number };
export type TaskStates = ReadonlyMap<number, { state: TaskState; step: string; endedAt: string | null }>;

export type PatchTimelineRow = {
  kind: PatchKind; id: number; head: string; toHead: string | null; state: string; reason: string | null; files: string[];
  attempt: number; taskId: number | null; source: FixupSource | null; createdAt: string;
};
export type PatchEventRow = PatchTimelineRow & { repo: string; number: number };
export type ModelCheckEventRow = ModelCheckRow;
export type PatchCheckEventRow = PatchCheckRow;
export type PatchSignature = { fixups: string; cifixes: string; conflicts: string; modelChecks: number; patchChecks: number; running: boolean };
export type PatchEventFilter = { repo?: string; since?: string; afterId?: number; limit: number };

export type CifixRerunRow = { repo: string; number: number; head: string; runs: number[]; at: string };
export type SessionRow = { kind: PatchKind | "main"; id: number; state: string; session: string };
export type SessionClear = { kind: PatchKind | "main"; id: number };

export type PatchFactsMap = Map<RefKey, PatchFacts>;

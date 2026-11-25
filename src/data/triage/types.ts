import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { RefKey };

export type Level = "P0" | "P1" | "P2" | "P3" | "P4";
export type Size = "S" | "M" | "L" | "XL";

/** A `classifications` row; `flags` and `probs` are JSON text. */
export type ClsRow = { repo: string; number: number; classifier: string; run_id: string; at: string; type_label: string | null; flags: string | null; probs: string | null; reason: string | null; input_hash: string | null };
export type VerdictInput = ClsRow;
/** A verdict row of an evaluation run; the item's title and kind come from `mirror.loadItems`. */
export type RunVerdict = ClsRow;
export type JevFailed = { repo: string; number: number; hash: string };
export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";
export type Referee = { label: string; sure: boolean; reason: string; final?: boolean; failures?: number; failedAt?: string };
export type Settled = {
  status: SettledStatus; label: string | null; source: "jev" | "haiku" | "sonnet" | null; confidence: number | null;
  jevLabel: string | null; haikuLabel: string | null; flags: string[]; referee: Referee | null;
};
export type RefereeRow = { at: string; type_label: string | null; reason: string | null; probs: string | null };
export type ClassifierDuplicates = { of: number[]; by: number[] };

/** `score` is the reach; `savePriorities` writes it only on insert, `rescoreReach` owns it after. */
export type PriorityRow = { repo: string; number: number; impact: Level; textHash: string; jevImpact: Level | null; jevP: number | null; haikuImpact: Level | null; score: number; model: string; reason: string | null; at: string };
export type RankBreakdown = { level: Level; rated: Level | null; security: boolean; type: string | null; size: Size; sizeSource: "lines" | "triage" | "default"; reach: number };
export type RankRow = { score: number; breakdown: RankBreakdown; computedAt: string };
/** An open tracked item with its stored level and reach (null before it was rated) and, for a PR, its changed lines. */
export type RankItemRow = { repo: string; number: number; kind: string; lines: number | null; level: Level | null; reach: number | null };
/** What `loadRankInputs` returns: the items to rank, their settled verdicts (absent: unclassified) and the stored ranks. */
export type RankInputs = { items: RankItemRow[]; settled: Map<RefKey, Settled>; old: Map<RefKey, { score: number; breakdown: RankBreakdown }> };
export type RankPut = { repo: string; number: number; score: number; breakdown: RankBreakdown; computedAt: string };

export type Area = { name: string; description: string };
export type AreaList = { repo: string; version: number; areas: Area[]; at: string; by: string | null; note: string | null };
export type AreaVersion = Omit<AreaList, "repo">;
export type ItemArea = { area: string | null; source: string; confidence: number | null; listVersion: number; at: string };
export type ItemAreaPut = { repo: string; number: number; area: string | null; source: string; confidence: number | null };
export type AreaOverview = { list: AreaList | null; counts: Map<string, number>; unassigned: number; proposals: AreaProposal[] };
export type AreaDue = { repo: string; number: number; kind: string; title: string | null; list_version: number | null };
export type AskedList = { repo: string; list: AreaList | null; items: AreaDue[] };
export type AreaEdit =
  | { op: "add"; name: string; description: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: string; into: string }
  | { op: "remove"; name: string }
  | { op: "describe"; name: string; description: string }
  | { op: "replace"; areas: Area[] };
export type AreaProposal = Selectable<DB["area_proposals"]>;
export type SampleItem = { repo: string; number: number; title: string | null };

export type EmbeddingPut = { repo: string; number: number; model: string; hash: string; vec: Uint8Array };
export type EmbedDiffRow = { repo: string; number: number; hash: string };
export type EmbeddingMark = { rows: number; maxRowid: number | null; tracked: string };
export type StreamedEmbedding = { rid: number; repo: string; number: number; vec: Uint8Array };

export type Pair = { repo: string; a: number; b: number; a_hash: string; b_hash: string; similarity: number };
export type PairKey = Pair;
export type PairVerdictPut = { repo: string; a: number; b: number; a_hash: string; b_hash: string; jev_p: number | null; haiku: string | null; verdict: string; canonical: number | null; checked_at: string };
export type ScanContext = { operatorPairs: Pair[]; scans: Map<RefKey, string>; stored: Set<string> };
export type CanonInfo = { state: string; created_at: string | null; comments_count: number | null; fixedBy: RefKey | null };
export type ComparisonPut = { repo: string; set_key: string; hash: string; verdict: string; reason: string | null; at: string; snapshot: { sizes: Record<string, number>; heads: Record<string, string | null> } };
export type DupeState = { edges: Pair[]; members: Map<RefKey, { kind: string; state: string; head_oid: string | null }>; comparisons: Map<string, Selectable<DB["dupe_comparisons"]>>; drops: Map<string, string> };
export type DupeGroupPut = { id: string; repo: string; source: string; at: string; items: { number: number; kind: string; role: string; target: number | null; detail: string | null }[] };
export type DupeSignal = { groupId: string; role: "keep" | "close" | "stay"; target: number | null; reason: string | null };

export type TriageFacts = {
  score: number | null;
  priority: { impact: Level; hash: string | null } | null;
  embeddedHash: string | null;
  scannedHash: string | null;
  jevFailedHash: string | null;
  verdicts: ClsRow[];
  pairsToCheck: number;
  compare: "rule" | "model" | null;
};
export type TriageFactsCtx = { model: string; run: string | null; nowMs: number };
export type TriageFactsResult = { facts: Map<RefKey, TriageFacts>; compareDueAt: Map<RefKey, number> };

export type ClassifierReport = { runs: { run: string; classifier: string; n: number }[]; agreement: unknown[]; confusion: unknown[] };
export type ClassifierReportFilter = { run?: string; pair?: string; hidden: string[] };
export type DisagreementList = { total: number; rows: { repo: string; number: number; a: string; b: string }[] };
export type ItemTriage = { verdicts: ClsRow[]; settled: Settled | null; priority: PriorityRow | null; area: ItemArea | null; rank: RankRow | null; dupe: DupeSignal | null };

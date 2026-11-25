import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { RefKey };

/** `repo#number@head`: the key of a loader result for one review row. */
export type HeadRef = string;
export type HeadKey = { repo: string; number: number; head: string };

/** One plan part of a review. */
export type ReviewFinding = { file: string; change: string; title?: string; major?: boolean };
export type ReviewRecommendation = { text: string; fix: number[]; drop: number[]; merges: boolean };
export type ReviewWorkflow = { outside_purpose: { lines: number; note: string } | null; recommendation: ReviewRecommendation | null };
export type Verdict = "take" | "take-fix" | "hold" | "close";

/** An `opus_reviews` row with a verdict, JSON parsed once. */
export type ReviewRow = {
  repo: string; number: number; head: string; at: string; run_id: string | null; model: string | null;
  mode: "full" | "delta" | "carried"; base_head: string | null; base_ref: string | null;
  verdict: Verdict; sure: boolean; reason: string;
  fixes: ReviewFinding[]; risks: string[]; conflicts: { id: number; reason: string }[];
  blocked_by: RefKey[]; seen_at: string | null; disc_hash: string | null;
  public_summary: string | null;
  workflow: ReviewWorkflow | null;
};
/** The heavy columns, loaded on demand. */
export type ReviewTexts = { summary: string | null; why: string | null; public_review: string | null; claims: string | null; conflicts: string | null };
export type HistoryRow = {
  rowid: number; head: string; at: string; model: string | null; mode: string | null; verdict: string; sure: boolean; reason: string;
  summary: string | null; risks: string[]; fixes: ReviewFinding[]; claims: string | null; blocked_by: RefKey[]; trigger: string | null; job_id: number | null;
};
export type ReviewPost = { repo: string; number: number; review_id: string; head: string; posted_at: string; edited_at: string | null; opus_at: string | null; posted_as: string | null };
/** The `review_state` row. */
export type ReviewMarks = { staleAt: string | null; rerunDay: string | null; rerunCount: number; failHead: string | null; failCount: number; failAt: string | null };
export type PremergeRow = Selectable<DB["premerge_reviews"]>;
export type Finding = { title: string; detail?: string; file?: string; line?: number; severity?: string; [k: string]: unknown };
export type PostmergeRow = { repo: string; number: number; merge_sha: string; at: string; model: string | null; run_id: string | null; findings: Finding[]; error: string | null; tries: number };
export type Followup = Selectable<DB["postmerge_followups"]>;
export type FollowupKey = { repo: string; number: number; review_at: string; finding: number };
export type PendingDefect = { repo: string; number: number; review_at: string; finding: number; f: Finding; attempts: number; note: string | null };
export type DiscussionStat = { newest: string; maint: string; counted: { id: string; body: string | null }[] | null };
export type MirrorEntry = { id: string; kind: string | null; author: string | null; created_at: string | null; body: string | null; review_state: string | null; counted: boolean; maint: boolean };

export type ReviewFacts = {
  latest: Map<RefKey, ReviewRow>;
  unsureHeads: Set<HeadRef>;
  reviewsToday: Map<RefKey, { n: number; last: string | null }>;
  carriedChains: Map<RefKey, ReviewRow[]>;
  posts: Map<RefKey, ReviewPost>;
  premerge: Map<HeadRef, PremergeRow>;
  postmerge: Map<RefKey, { at: string; error: string | null }>;
  marks: Map<RefKey, ReviewMarks>;
  discussion: Map<RefKey, DiscussionStat>;
  blockerLatest: Map<RefKey, { verdict: Verdict; blocked_by: RefKey[] }>;
};
export type ReviewRecord = { latest: ReviewRow | null; history: HistoryRow[]; premerge: PremergeRow[]; postmerge: PostmergeRow | null; followups: Followup[]; post: ReviewPost | null };
export type ReviewSignature = { history: { n: number; newest: string | null }; reviews: { n: number; newest: string | null }; premerge: { n: number; newest: string | null; tries: number }; postmerge: { n: number; newest: string | null }; followups: string };
export type ReviewEventRow = { kind: "review" | "premerge" | "postmerge"; repo: string; number: number; at: string; verdict: string | null; model: string | null };

/** What the caller loaded for one review save (the module reads no GitHub or model data). */
export type SaveReviewInput = {
  runId: string; repo: string; number: number; head: string; mode: "full" | "delta" | "carried"; base: string | null; baseRef: string | null;
  defaultBranch: string | null; model: string | null; review: Record<string, unknown>; snap?: Record<string, unknown>; blockedBy: RefKey[]; jobId: number | null; trigger?: string | null;
};
export type SaveReviewResult = { repo: string; number: number; head: string; saved: boolean; rebased: boolean };
export type PremergeSave = { repo: string; number: number; head: string; at: string; run_id: string | null; model: string | null; findings: unknown; searched: unknown; error: string | null; final?: boolean; conflicts: unknown; base_ref: string | null; unsure: boolean; claims: string | null };
export type PostmergeSave = { repo: string; number: number; merge_sha: string; at: string; model: string | null; run_id: string | null; findings: Finding[]; error: string | null; followups: { finding: number; title: string; state: string; duplicate_of?: number | null }[] };
export type FollowupRow = Followup;
export type PostSave = ({ kind: "posted" } & ReviewPost) | { kind: "edited"; repo: string; number: number; head: string; edited_at: string; opus_at: string | null; posted_as: string | null };

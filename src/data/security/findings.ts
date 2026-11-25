// Findings (package security).
import type { Db } from "../../db/index.ts";
import type {
  FindingAttention, FindingBoardRow, FindingDetailData, FindingKey, FindingMove, FindingRow, FindingState, FixAdvanceRow, HiddenRepos, LinkRow, NewFinding, Ref, StaleWork,
} from "./types.ts";

/** Full rows; `internal: true` includes `unverified`, `disproved` and `duplicate`. */
export async function loadFindings(db: Db, keys: FindingKey[], o?: { internal?: boolean }): Promise<Map<FindingKey, FindingRow>> { throw new Error("not built: security.loadFindings"); }
/** Every listed finding of the visible repos with its building round and last-attempt rounds. 1 statement. */
export async function loadFindingBoard(db: Db, f: { repos: string[] }): Promise<FindingBoardRow[]> { throw new Error("not built: security.loadFindingBoard"); }
/** The finding page's data in one wave: finding, calls, repeats, scan test, fix log, live rounds. 6 statements. */
export async function loadFindingDetail(db: Db, key: FindingKey): Promise<FindingDetailData | undefined> { throw new Error("not built: security.loadFindingDetail"); }
/** Listed quiet-route findings whose `fix_pr` is the PR. */
export async function loadFixPrFindings(db: Db, prs: Ref[]): Promise<Map<Ref, { number: number; title: string; severity: string; state: string }[]>> { throw new Error("not built: security.loadFixPrFindings"); }
/** Open high findings (count and the oldest) and findings the fix gave up on. 3 statements, 1 RT. */
export async function loadFindingAttention(db: Db, f: { hide?: HiddenRepos }): Promise<FindingAttention> { throw new Error("not built: security.loadFindingAttention"); }
/** `fixing` findings with `env_wait_at`: count and the oldest. */
export async function countEnvWaits(db: Db): Promise<{ n: number; oldest: string | null }> { throw new Error("not built: security.countEnvWaits"); }
/** Automatic-fix candidates: state `new`, verified score high enough, no live fix job, and scan tests settled when that switch is on. */
export async function loadFindingsToFix(db: Db, f: { repo?: string; number?: number; scanTests: boolean }): Promise<FindingKey[]> { throw new Error("not built: security.loadFindingsToFix"); }
/** `fixing` findings with no queued or running job, with a `building` round or waiting on a confidential environment. */
export async function loadFixesToAdvance(db: Db): Promise<FixAdvanceRow[]> { throw new Error("not built: security.loadFixesToAdvance"); }
/** Narrow columns of all findings for `linkRepeatedFindings`; `alone` above 10,000 rows. */
export async function loadFindingsForLinking(db: Db): Promise<LinkRow[]> { throw new Error("not built: security.loadFindingsForLinking"); }
/** Findings by scan, repo and state. */
export async function countFindings(db: Db, f: { scanId?: number; repo?: string; state?: FindingState }): Promise<number> { throw new Error("not built: security.countFindings"); }
/** The three sets `reconcileSecurity` acts on, in one wave. */
export async function loadStaleWork(db: Db, o?: { repo?: string; now: number }): Promise<StaleWork> { throw new Error("not built: security.loadStaleWork"); }
/** Multi-row insert with explicit numbers and `duplicate_of`. */
export async function addFindings(db: Db, repo: string, rows: NewFinding[]): Promise<void> { throw new Error("not built: security.addFindings"); }
/** Batched compare-and-set update, one statement per distinct shape of (from, to, patch keys); returns the keys that moved. */
export async function advanceFindings(db: Db, moves: FindingMove[]): Promise<Set<FindingKey>> { throw new Error("not built: security.advanceFindings"); }
/** Single-key wrapper over `advanceFindings`, for per-effect sites only. */
export async function advanceFinding(db: Db, m: FindingMove): Promise<boolean> { throw new Error("not built: security.advanceFinding"); }
/** Operator dismiss, backlog or reopen; returns the new state per key. */
export async function moveFindings(db: Db, moves: { repo: string; number: number; action: "dismiss" | "backlog" | "reopen"; by: string; reason: string | null }[]): Promise<Map<FindingKey, FindingState>> { throw new Error("not built: security.moveFindings"); }
/** Marks repeats (`updateFrom`, guarded by `state = 'new'`); returns the keys marked. The caller audits in the same transaction. */
export async function markDuplicates(db: Db, rows: { repo: string; number: number; duplicateOf: number }[]): Promise<FindingKey[]> { throw new Error("not built: security.markDuplicates"); }
/** Sets notes of `landing` findings (`updateFrom`). */
export async function setNotes(db: Db, rows: { repo: string; number: number; note: string }[]): Promise<number> { throw new Error("not built: security.setNotes"); }
/** Compare-and-set claim of the advisory id slot; per effect, never inside a transaction. */
export async function claimAdvisoryId(db: Db, key: FindingKey): Promise<boolean> { throw new Error("not built: security.claimAdvisoryId"); }
/** Stores the advisory id. */
export async function setAdvisoryId(db: Db, key: FindingKey, ghsa: string): Promise<void> { throw new Error("not built: security.setAdvisoryId"); }
/** Sets a finding's note; per effect. */
export async function setFindingNote(db: Db, key: FindingKey, note: string): Promise<void> { throw new Error("not built: security.setFindingNote"); }
/** Sets or clears `env_wait_at` (guard `state = 'fixing'`; setting keeps an earlier value). */
export async function setFindingEnvWait(db: Db, key: FindingKey, at: string | null): Promise<void> { throw new Error("not built: security.setFindingEnvWait"); }

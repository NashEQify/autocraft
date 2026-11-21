// Pre-merge review results (table premerge_reviews): one row per PR head, read by the merge queue.
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";

/** A failed head counts as failed after this many tries. */
export { PREMERGE_MAX_TRIES };

export type { PremergeFinding } from "./types.ts";
import type { PremergeFinding } from "./types.ts";
import type { Claim, StatementConflict } from "../review/opus-parse.ts";
import type { Db } from "../db/index.ts";

export type PremergeRow = {
  repo: string; number: number; head_oid: string;
  /** When the row was last written (a review or a failed try). */
  at: string;
  run_id: string | null; model: string | null;
  /** JSON PremergeFinding[]; null while no try has produced a review. */
  findings: string | null;
  /** What the reviewer searched, as free text. */
  searched: string | null;
  /** JSON StatementConflict[]; null when none. */
  conflicts: string | null;
  /** 1 when the review left a claim unverified. */
  unsure: number | null;
  /** JSON Claim[]; null when the review listed none. */
  claims: string | null;
  /** Why the last try stored no review; null once a review is stored. */
  error: string | null;
  tries: number;
  /** The base branch the review read the diff against; null on rows stored earlier. */
  base_ref: string | null;
};

export type PremergeSave = {
  repo: string; number: number; head: string; at: string;
  runId?: string | null; model?: string | null;
  /** A stored review. Without it, `error` records a failed try. */
  findings?: PremergeFinding[];
  searched?: string | null;
  /** The statements the review named as conflicts (a stored review only). */
  conflicts?: StatementConflict[];
  unsure?: boolean;
  claims?: Claim[];
  error?: string | null;
  /** The failure is final: no more tries (the head cannot be reviewed at all). */
  final?: boolean;
  /** The base branch the diff was read against (a stored review only). */
  baseRef?: string | null;
};

/** Stores a review (clears the error) or counts a failed try. */
export async function savePremerge(db: Db, s: PremergeSave): Promise<void> {
  const args = [s.repo, s.number, s.head, s.at, s.runId ?? null, s.model ?? null] as const;
  if (s.findings) {
    await db.prepare(`INSERT INTO premerge_reviews (repo, number, head_oid, at, run_id, model, findings, searched, conflicts, unsure, claims, base_ref, error, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT (repo, number, head_oid) DO UPDATE SET at = excluded.at, run_id = excluded.run_id, model = excluded.model,
        findings = excluded.findings, searched = excluded.searched, conflicts = excluded.conflicts, unsure = excluded.unsure, claims = excluded.claims, base_ref = excluded.base_ref, error = NULL`).run(...args, JSON.stringify(s.findings), s.searched ?? null, s.conflicts?.length ? JSON.stringify(s.conflicts) : null, s.unsure ? 1 : 0, s.claims?.length ? JSON.stringify(s.claims) : null, s.baseRef ?? null);
    return;
  }
  await db.prepare(`INSERT INTO premerge_reviews (repo, number, head_oid, at, run_id, model, error, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number, head_oid) DO UPDATE SET at = excluded.at, run_id = excluded.run_id, model = excluded.model,
      error = excluded.error, tries = CASE WHEN ? THEN excluded.tries ELSE tries + 1 END`).run(...args, s.error ?? "failed", s.final ? PREMERGE_MAX_TRIES : 1, s.final ? 1 : 0);
}

/** The pre-merge review of a head, when it read the diff against the base branch the head's Opus review read (a row or review that recorded none counts as matching). */
export async function premergeAt(db: Db, repo: string, number: number, head: string): Promise<PremergeRow | null> {
  return (await db.prepare(`${premergeSql("")} AND p.repo = ? AND p.number = ? AND p.head_oid = ?`).get(repo, number, head) as PremergeRow | undefined) ?? null;
}

/** The pre-merge reviews that read the diff against the base branch their head's Opus review read (see premergeAt). */
const premergeSql = (extra: string): string => `SELECT p.*${extra} FROM premerge_reviews p
    LEFT JOIN opus_reviews o ON o.repo = p.repo AND o.number = p.number AND o.head_oid = p.head_oid LEFT JOIN repos r ON r.name = p.repo
    WHERE (p.base_ref IS NULL OR COALESCE(o.base_ref, r.default_branch) IS NULL OR p.base_ref = COALESCE(o.base_ref, r.default_branch))`;

/** premergeAt() of every head, keyed by `repo#number@head`; `narrow` adds a condition on `p` with its named parameters. */
export async function premergeRows(db: Db, narrow: { sql: string; p: Record<string, string> } = { sql: "", p: {} }): Promise<Map<string, PremergeRow>> {
  const out = new Map<string, PremergeRow>();
  for (const row of await db.prepare(`${premergeSql(", p.repo || '#' || p.number || '@' || p.head_oid AS k")}${narrow.sql}`).all(narrow.p) as (PremergeRow & { k?: string })[]) {
    const k = row.k!;
    delete row.k;
    out.set(k, row);
  }
  return out;
}

/** The PR already had a pre-merge fix round (any fixups row with source premerge, pushed or not). */
export async function premergeFixUsed(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM fixups WHERE repo = ? AND number = ? AND source = 'premerge' AND state NOT IN ('linting', 'superseded') LIMIT 1").get(repo, number);
}

/** premergeFixUsed() from the PR's fixups rows. */
export const premergeFixUsedIn = (rows: readonly { source: string | null; state: string }[]): boolean =>
  rows.some((r) => r.source === "premerge" && r.state !== "linting" && r.state !== "superseded");

/** Claims of a stored row; empty when none or unreadable. */
export function claimsOf(row: PremergeRow | null): Claim[] {
  try { const v = row?.claims ? (JSON.parse(row.claims) as unknown) : []; return Array.isArray(v) ? (v as Claim[]) : []; } catch { return []; }
}

/** Findings of a stored row; empty when none or unreadable. */
export function findingsOf(row: PremergeRow | null): PremergeFinding[] {
  try { return row?.findings ? (JSON.parse(row.findings) as PremergeFinding[]) : []; } catch { return []; }
}

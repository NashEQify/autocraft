// Pre-merge review results (table premerge_reviews): one row per PR head, read by the merge queue.
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";

/** A failed head counts as failed after this many tries. */
export { PREMERGE_MAX_TRIES };

export type { PremergeFinding } from "./types.ts";
import type { PremergeFinding } from "./types.ts";
import type { Claim, StatementConflict } from "../review/opus-parse.ts";
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { cols, excluded, type Eb } from "../db/kx.ts";

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
  const key = { repo: s.repo, number: s.number, head_oid: s.head };
  if (s.findings) {
    await db.run(db.k.insertInto("premerge_reviews")
      .values({ ...key, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, findings: JSON.stringify(s.findings), searched: s.searched ?? null, conflicts: s.conflicts?.length ? JSON.stringify(s.conflicts) : null, unsure: s.unsure ? 1 : 0, claims: s.claims?.length ? JSON.stringify(s.claims) : null, base_ref: s.baseRef ?? null, error: null, tries: 0 })
      .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet((eb) => ({ ...excluded(["at", "run_id", "model", "findings", "searched", "conflicts", "unsure", "claims", "base_ref"])(eb), error: null }))));
    return;
  }
  await db.run(db.k.insertInto("premerge_reviews")
    .values({ ...key, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, error: s.error ?? "failed", tries: s.final ? PREMERGE_MAX_TRIES : 1 })
    .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet((eb) => ({
      ...excluded(["at", "run_id", "model", "error"])(eb), tries: s.final ? eb.ref("excluded.tries") : eb("premerge_reviews.tries", "+", 1),
    }))));
}

/** The pre-merge review of a head, when it read the diff against the base branch the head's Opus review read (a row or review that recorded none counts as matching). */
export async function premergeAt(db: Db, repo: string, number: number, head: string): Promise<PremergeRow | null> {
  return (await db.get(premergeQuery(db).select(cols("premerge_reviews", "p")).where("p.repo", "=", repo).where("p.number", "=", number).where("p.head_oid", "=", head))) ?? null;
}

/** The pre-merge reviews that read the diff against the base branch their head's Opus review read (see premergeAt). */
const premergeQuery = (db: Db) => db.k.selectFrom("premerge_reviews as p")
  .leftJoin("opus_reviews as o", (j) => j.onRef("o.repo", "=", "p.repo").onRef("o.number", "=", "p.number").onRef("o.head_oid", "=", "p.head_oid"))
  .leftJoin("repos as r", "r.name", "p.repo")
  .where((eb) => eb.or([eb("p.base_ref", "is", null), eb(eb.fn.coalesce("o.base_ref", "r.default_branch"), "is", null), eb("p.base_ref", "=", eb.fn.coalesce("o.base_ref", "r.default_branch"))]));

/** premergeAt() of every head, keyed by `repo#number@head`; `narrow` adds a condition on `p`. */
export async function premergeRows(db: Db, narrow?: (eb: Eb) => Expression<SqlBool>): Promise<Map<string, PremergeRow>> {
  const out = new Map<string, PremergeRow>();
  const q = premergeQuery(db).select((eb) => [...cols("premerge_reviews", "p"), eb(eb(eb(eb(eb.ref("p.repo"), "||", eb.val("#")), "||", eb.cast<string>("p.number", "text")), "||", eb.val("@")), "||", eb.ref("p.head_oid")).as("k")]);
  for (const row of await db.all(narrow ? q.where(narrow) : q)) {
    const { k, ...rest } = row;
    out.set(k, rest);
  }
  return out;
}

/** The PR already had a pre-merge fix round (any fixups row with source premerge, pushed or not). */
export async function premergeFixUsed(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("fixups").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", number).where("source", "=", "premerge").where("state", "not in", ["linting", "superseded"]).limit(1));
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

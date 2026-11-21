// A take or take-fix verdict carries over our own checked fix-up: when the only change since a sure review is the fix-up commit
// whose patch the patch check approved (and whose lint passed, since it was pushed), the new head gets the same verdict without an Opus call.
import { ourCommitsSince } from "./ours.ts";
import type { OpusReview } from "./opus-parse.ts";
import { reviewAfterBaseMerge } from "./own-diff.ts";
import { defaultBranchOf } from "../merge/base.ts";
import type { NotNull } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const CARRIED = "carried";

/**
 * The review to record at `c.head_oid` as carried from the latest earlier review, with that review's discussion mark; null when it does not carry.
 * `stale` is the set of "repo#n@head" whose review is stale (staleReviews): a review that has not read the discussion as it is now is not carried,
 * and a head that already has a review (stale, being reviewed again) is never carried from an earlier one. A review read against
 * another base branch than the PR has now is not carried either; a carried review keeps the base its source read.
 */
export async function carriedReview(db: Db, c: { repo: string; number: number; head_oid: string }, stale: Set<string> = new Set()): Promise<{ review: OpusReview; from: string; seen: string; hash: string | null; baseRef: string | null } | null> {
  const e = await db.get(db.k.selectFrom("opus_reviews").select(["head_oid", "verdict", "sure", "risks", "summary", "why", "conflicts", "fixes", "at", "seen_at", "disc_hash", "model", "base_ref"])
    .$narrowType<{ verdict: NotNull }>().where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "<>", c.head_oid).where("verdict", "is not", null).where("model", "is not", null)
    .orderBy("at", "desc").orderBy(kx.rowid("opus_reviews"), "desc").limit(1));
  if (await db.get(db.k.selectFrom("opus_reviews").select((eb) => eb.lit(1).as("one")).where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "=", c.head_oid).where("verdict", "is not", null).limit(1))) return null;
  if (!e || stale.has(`${c.repo}#${c.number}@${e.head_oid}`) || (e.verdict !== "take" && e.verdict !== "take-fix") || e.sure !== 1) return null;
  const baseRef = e.base_ref ?? await defaultBranchOf(db, c.repo);
  const liveBase = (await db.get(db.k.selectFrom("items").select("base_ref").where("repo", "=", c.repo).where("number", "=", c.number)))?.base_ref ?? null;
  if (baseRef && liveBase && baseRef !== liveBase) return null;
  const path = await ourCommitsSince(db, c.repo, c.number, e.head_oid, c.head_oid);
  const list = <T>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
  const merge = path.complete && path.commits.length === 1 && path.commits[0]!.kind === "base merge"
    ? await db.get(db.k.selectFrom("conflict_merges").select("own_diff").where("repo", "=", c.repo).where("number", "=", c.number).where("to_head", "=", c.head_oid).where("state", "=", "merged")
      .orderBy(kx.rowid("conflict_merges"), "desc").limit(1)) : undefined;
  // Our merge of the base branch: the PR's own diff is what the review read, so an unchanged diff keeps the verdict and its fixes.
  if (merge && reviewAfterBaseMerge(merge.own_diff) === "carry") {
    const review: OpusReview = {
      ref: `${c.repo}#${c.number}`, verdict: e.verdict, sure: true, fixes: list(e.fixes), risks: list<string>(e.risks), summary: e.summary, why: e.why, public: null,
      reason: `carried from ${e.head_oid.slice(0, 7)}: the only change is our merge of the base branch, and the PR's own diff is unchanged`, conflicts: list(e.conflicts), claims: [], blocked_by: [],
    };
    return { review, from: e.head_oid, seen: e.seen_at ?? e.at, hash: e.disc_hash, baseRef };
  }
  // Exactly one commit, ours, a fix-up of the review's own fixes (not a pre-merge or carry-over fix-up).
  if (!path.complete || path.commits.length !== 1 || path.commits[0]!.kind !== "fix-up" || path.sources[0]) return null;
  const approved = await db.get(db.k.selectFrom("patch_checks").select("verdict").where("kind", "=", "fixup").where("repo", "=", c.repo).where("number", "=", c.number).where("subject", "=", e.head_oid)
    .orderBy("id", "desc").limit(1));
  if (approved?.verdict !== "approve") return null;
  const review: OpusReview = {
    ref: `${c.repo}#${c.number}`, verdict: "take", sure: true, fixes: [], risks: list<string>(e.risks), summary: e.summary,
    // A take-fix review's reason names the fixes the fix-up has since made; the carried verdict's reason is the carry itself.
    why: e.verdict === "take-fix" ? null : e.why, public: null,
    reason: `carried from ${e.head_oid.slice(0, 7)}: the only change is our checked fix-up`, conflicts: list(e.conflicts), claims: [], blocked_by: [],
  };
  return { review, from: e.head_oid, seen: e.seen_at ?? e.at, hash: e.disc_hash, baseRef };
}

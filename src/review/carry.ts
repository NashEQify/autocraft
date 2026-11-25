// A take or take-fix verdict carries over our own checked fix-up: when the only change since a sure review is the fix-up commit
// whose patch the patch check approved (and whose lint passed, since it was pushed), the new head gets the same verdict without an Opus call.
import { ourPathIn } from "./ours.ts";
import type { OpusReview } from "./opus-parse.ts";
import { reviewAfterBaseMerge } from "./own-diff.ts";
import type { Db } from "../db/index.ts";
import { loadFixupVerdicts, loadPushEdges, type PushEdge } from "../data/changes/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { loadReviewRows, loadReviewTexts, type ReviewRow } from "../data/review/index.ts";

export const CARRIED = "carried";

export type Carried = { review: OpusReview; from: string; seen: string; hash: string | null; baseRef: string | null };
type Cand = { repo: string; number: number; head_oid: string };

/**
 * The review to record at each `c.head_oid` as carried from the latest earlier review, with that review's discussion mark; a PR that does not carry has no entry.
 * `stale` is the set of "repo#n@head" whose review is stale (staleReviews): a review that has not read the discussion as it is now is not carried,
 * and a head that already has a review (stale, being reviewed again) is never carried from an earlier one. A review read against
 * another base branch than the PR has now is not carried either; a carried review keeps the base its source read.
 */
export async function carriedReviews(db: Db, cs: Cand[], stale: Set<string> = new Set()): Promise<Map<string, Carried>> {
  const out = new Map<string, Carried>();
  if (!cs.length) return out;
  const refs = cs.map((c) => ({ repo: c.repo, number: c.number }));
  const [rows, items, repos, edges] = await db.together(() => Promise.all([
    loadReviewRows(db, refs), loadItems(db, refs, "pr"), loadRepos(db, { names: [...new Set(cs.map((c) => c.repo))] }), loadPushEdges(db, refs),
  ]));
  type Pick = { c: Cand; e: ReviewRow; baseRef: string | null };
  const picked: Pick[] = [];
  for (const c of cs) {
    const all = rows.get(`${c.repo}#${c.number}`) ?? [];
    const e = all.find((r) => r.head !== c.head_oid && r.model !== null);
    if (all.some((r) => r.head === c.head_oid)) continue;
    if (!e || stale.has(`${c.repo}#${c.number}@${e.head}`) || (e.verdict !== "take" && e.verdict !== "take-fix") || !e.sure) continue;
    const baseRef = e.base_ref ?? repos.get(c.repo)?.default_branch ?? null;
    const liveBase = items.get(`${c.repo}#${c.number}`)?.base_ref ?? null;
    if (baseRef && liveBase && baseRef !== liveBase) continue;
    picked.push({ c, e, baseRef });
  }
  if (!picked.length) return out;
  const paths = picked.map((p) => ourPathIn(edges.get(`${p.c.repo}#${p.c.number}`) ?? [], p.e.head, p.c.head_oid));
  const fixups: { ref: string; subject: string }[] = [];
  picked.forEach((p, i) => {
    const path = paths[i]!;
    if (path.complete && path.commits.length === 1 && path.commits[0]!.kind === "fix-up" && !path.sources[0]) fixups.push({ ref: `${p.c.repo}#${p.c.number}`, subject: p.e.head });
  });
  const [texts, verdicts] = await db.together(() => Promise.all([
    loadReviewTexts(db, picked.map((p) => ({ repo: p.c.repo, number: p.c.number, head: p.e.head }))), loadFixupVerdicts(db, fixups),
  ]));
  picked.forEach((p, i) => {
    const { c, e, baseRef } = p, path = paths[i]!, key = `${c.repo}#${c.number}`;
    const t = texts.get(`${key}@${e.head}`);
    const base = { ref: key, summary: t?.summary ?? null, risks: e.risks, conflicts: e.conflicts as unknown as OpusReview["conflicts"], claims: [], blocked_by: [] as string[], public: null };
    const from = e.head, seen = e.seen_at ?? e.at, hash = e.disc_hash;
    const merge = path.complete && path.commits.length === 1 && path.commits[0]!.kind === "base merge"
      ? (edges.get(key) as PushEdge[] | undefined)?.find((x) => x.kind === "conflict" && x.to === c.head_oid && x.state === "merged") : undefined;
    // Our merge of the base branch: the PR's own diff is what the review read, so an unchanged diff keeps the verdict and its fixes.
    if (merge && reviewAfterBaseMerge(merge.ownDiff ?? null) === "carry") {
      out.set(key, { review: { ...base, verdict: e.verdict, sure: true, fixes: e.fixes as OpusReview["fixes"], why: t?.why ?? null,
        reason: `carried from ${e.head.slice(0, 7)}: the only change is our merge of the base branch, and the PR's own diff is unchanged` }, from, seen, hash, baseRef });
      return;
    }
    // Exactly one commit, ours, a fix-up of the review's own fixes (not a pre-merge or carry-over fix-up).
    if (!path.complete || path.commits.length !== 1 || path.commits[0]!.kind !== "fix-up" || path.sources[0]) return;
    if (verdicts.get(`${key}@${e.head}`) !== "approve") return;
    out.set(key, { review: { ...base, verdict: "take", sure: true, fixes: [],
      // A take-fix review's reason names the fixes the fix-up has since made; the carried verdict's reason is the carry itself.
      why: e.verdict === "take-fix" ? null : t?.why ?? null, reason: `carried from ${e.head.slice(0, 7)}: the only change is our checked fix-up` }, from, seen, hash, baseRef });
  });
  return out;
}

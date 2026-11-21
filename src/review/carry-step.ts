// The Carry step: stores the carried review (carry.ts) for each PR whose Plan holds a `carry` action. Calls no model.
import { planned } from "../core/select.ts";
import { staleReviews } from "./discussion.ts";
import { carriedReview, CARRIED } from "./carry.ts";
import { saveOpus } from "./opus.ts";
import { jobItem } from "../runner/job-items.ts";
import type { Db } from "../db/index.ts";

export async function runCarry(db: Db, repo: string, log: (line: string) => void = console.log): Promise<number> {
  const stale = await staleReviews(db, repo);
  const runId = `carry-${repo}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  let n = 0;
  for (const { facts: f, action } of await planned(db, "carry", { repo })) {
    const c = { repo, number: f.number, head_oid: action.head! };
    const k = await carriedReview(db, c, stale);
    if (!k) continue;
    await saveOpus(db, runId, c, { mode: CARRIED, base: k.from, baseRef: k.baseRef, model: CARRIED, review: k.review, snap: { seen: k.seen, hash: k.hash } });
    await jobItem(db, repo, f.number, `carried review: ${k.review.reason}`, log);
    n++;
  }
  return n;
}

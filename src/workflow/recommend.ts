// The one recommendation an item comes back with, and the numbered plan it refers to. Pure: advance.ts gives it the latest
// review and the blocker, and records the result on the workflow row.
//
// The review writes the sentence and says what a yes runs (src/review/opus-parse.ts ReviewRecommendation), so the text and the run
// always agree. A blocker the review cannot speak for (author commits, a failing step, a large fix, files beyond the plan, a merge
// leg that stopped) gets a sentence built here from its facts.
import { t } from "../i18n/index.ts";
import type { ReviewFix, ReviewRecommendation } from "../review/opus-parse.ts";
import type { Found } from "./blockers.ts";
import { listText } from "./status.ts";
import type { PlanPart, Recommendation } from "./types.ts";

const TITLE_CHARS = 80;

/** A part's title: the review's own, else the start of its change. */
const titleOf = (f: ReviewFix): string => f.title ?? (f.change.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) || f.file);

/**
 * The plan of a review's fixes, numbered from 1 in the review's order. A part a person dropped from the plan before (same title)
 * stays dropped; a part with no fix (the review asks for nothing) is no part.
 */
export function planOf(fixes: readonly ReviewFix[], before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(before.filter((p) => p.state === "dropped").map((p) => p.title.toLowerCase()));
  return fixes.map((f, i) => {
    const title = titleOf(f);
    return { n: i + 1, title, source: "review" as const, file: f.file, ...(f.major ? { major: true } : {}), state: dropped.has(title.toLowerCase()) ? "dropped" as const : "planned" as const };
  });
}

export type ReviewView = { verdict: string; sure: boolean; rec: ReviewRecommendation | null };

const planned = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "planned").map((p) => p.n);
const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);

/** "Fix 1 and 2, then merge." / "Fix 1, then come back." */
const fixText = (fix: readonly number[], merges: boolean): string => (merges
  ? t("Fix {parts}, then merge.", { parts: listText(fix) })
  : t("Fix {parts}, then come back with the result.", { parts: listText(fix) }));

/**
 * What the item comes back with when its steps are done and the merge is not approved: the review's recommendation when it gave
 * one (without the parts a person dropped), else one built from its verdict: fix the planned parts then merge, merge, or close.
 */
export function afterSteps(review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const rec = review?.rec;
  if (rec) {
    const fix = rec.fix.filter((n) => !drop.includes(n));
    if (rec.close) return { text: rec.text, parts: { fix: [], drop }, merges: false, close: true };
    // A person dropped every part the review wanted fixed: the sentence no longer says what a yes runs.
    if (!rec.fix.length || fix.length) return { text: fix.length === rec.fix.length ? rec.text : fixText(fix, rec.merge), parts: { fix, drop }, merges: rec.merge };
  }
  const fix = planned(plan);
  if (review?.verdict === "close") return { text: t("Close it, as the review recommends."), parts: { fix: [], drop }, merges: false, close: true };
  if (review && (review.verdict === "hold" || !review.sure) && !fix.length) {
    return { text: t("Review it again after a person looked at the findings, then come back."), parts: { fix: [], drop }, merges: false };
  }
  if (fix.length) return { text: fixText(fix, true), parts: { fix, drop }, merges: true };
  return { text: t("Merge it."), parts: { fix: [], drop }, merges: true };
}

/**
 * What an item stopped at a blocker comes back with. A yes resumes the plan: the merge stays approved, and what the blocker was
 * about is accepted as it is. A major finding or a change outside the purpose takes the review's own recommendation when it gave one.
 */
export function atBlocker(found: Found, review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const go = (text: string): Recommendation => ({ text, parts: { fix: [], drop }, merges: true });
  const p = found.params;
  switch (found.blocker) {
    case "author-commits": return go(t("Review the new commits, then merge."));
    case "failed-twice": return go(t("Try {step} again, then merge.", { step: String(p.step ?? t("the step")) }));
    case "large-fix": return go(t("Keep the fix of {lines} lines, then merge.", { lines: Number(p.lines ?? 0) }));
    case "beyond-agreed": return go(t("Keep the changes to {files}, then merge.", { files: listText((p.files as string[] | undefined) ?? []) }));
    case "outside-purpose":
    case "major-finding": {
      if (review?.rec) return afterSteps(review, plan);
      const fix = planned(plan).filter((n) => plan.find((x) => x.n === n)?.major);
      if (fix.length) return { text: fixText(fix, true), parts: { fix, drop }, merges: true };
      return found.blocker === "outside-purpose" ? go(t("Keep the {lines} lines outside the purpose, then merge.", { lines: Number(p.lines ?? 0) })) : go(t("Merge it as it is."));
    }
    case "other": return go(t("Go on with the merge."));
  }
}

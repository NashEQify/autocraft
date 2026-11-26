// The one recommendation an item comes back with, and the numbered plan it refers to. Pure: advance.ts gives it the latest
// review and the blocker, and records the result on the workflow row.
//
// The review writes the sentence and says what a yes runs (src/review/opus-parse.ts ReviewRecommendation), so the text and the run
// always agree. A blocker the review cannot speak for (author commits, a failing step, a large fix, files beyond the plan, a merge
// leg that stopped) gets a sentence built here from its facts.
import { t } from "../i18n/index.ts";
import { byHand, type ConflictPath } from "../core/decide.ts";
import { PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, PREMERGE_UNSURE_REASON, UNSURE_REASON } from "../core/rules.ts";
import { asSentence } from "../prose.ts";
import type { ReviewFix, ReviewRecommendation } from "../review/opus-parse.ts";
import type { Found } from "./blockers.ts";
import { listText } from "./status.ts";
import type { PlanPart, Recommendation } from "./types.ts";
import { droppedTitles, partTitle } from "./work.ts";

/**
 * The plan of a review's fixes, numbered from 1 in the review's order. A part a person dropped from the plan before (same title)
 * stays dropped; a part with no fix (the review asks for nothing) is no part.
 */
export function planOf(fixes: readonly ReviewFix[], before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(droppedTitles(before));
  return fixes.map((f, i) => {
    const title = partTitle(f);
    return { n: i + 1, title, source: "review" as const, file: f.file, ...(f.major ? { major: true } : {}), state: dropped.has(title.toLowerCase()) ? "dropped" as const : "planned" as const };
  });
}

export type ReviewView = { verdict: string; sure: boolean; rec: ReviewRecommendation | null };

export const planned = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "planned").map((p) => p.n);
export const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);

/** "Fix 1 and 2, then merge." / "Fix 1, then come back." */
const fixText = (fix: readonly number[], merges: boolean): string => (merges
  ? t("Fix {parts}, then merge.", { parts: listText(fix) })
  : t("Fix {parts}, then come back with the result.", { parts: listText(fix) }));

/** The sentence for what a yes runs, when the review's own sentence does not say it. */
export function textFor(r: { fix: readonly number[]; merges: boolean; close?: boolean; again?: "review" | "fixup" }): string {
  if (r.close) return t("Close it, as the review recommends.");
  if (r.fix.length) return fixText(r.fix, r.merges);
  if (r.again === "review") return r.merges ? t("Review it again, then merge.") : t("Review it again, then come back with the result.");
  return r.merges ? t("Merge it.") : t("Review it again, then come back with the result.");
}

/** The planned parts of the review's fixes that nobody makes, dropped: the merge goes on without them. */
export function without(parts: readonly number[], protectedFiles: boolean): Recommendation {
  const vars = { parts: listText(parts) };
  return {
    text: protectedFiles ? t("The review asks for changes to files AutoCraft may not touch. Drop {parts}, then merge.", vars)
      : t("The review asks for fixes that AutoCraft's fix-up cannot make and nobody else is asked for. Drop {parts}, then merge.", vars),
    parts: { fix: [], drop: [...parts] }, merges: true,
  };
}

const STOPS = {
  conflict: (text: string) => t("It conflicts with its base branch. {text}", { text }),
  ci: (text: string) => t("CI fails at its latest commit. {text}", { text }),
};

/** A conflict with the base branch, and who settles it once the merge is approved (src/core/decide.ts conflictPath). */
export type Conflict = { path: ConflictPath | null };

const ON_CONFLICT: Record<Exclude<ConflictPath, "merge">, (text: string) => string> = {
  tomorrow: (text) => t("It conflicts with its base branch, and today's merges of that branch into it are used up, so this goes on tomorrow. {text}", { text }),
  contributor: (text) => t("It conflicts with its base branch, which the contributor has to resolve first. {text}", { text }),
  person: (text) => t("It conflicts with its base branch, which AutoCraft cannot resolve: someone has to do that on its branch first. {text}", { text }),
};

/**
 * The recommendation on a PR that conflicts with its base branch, where no fix-up can be made before that merge. Where the pipeline merges the
 * base in, a yes approves the merge and the fixes follow that merge. Where a person has to resolve the conflict, a yes approves the
 * merge and waits for them: it runs nothing that could ask the same again. A PR with no review to go on from is reviewed again.
 */
export function onConflict(rec: Recommendation, conflict: Conflict | null): Recommendation {
  if (!conflict || rec.close || rec.answer) return rec;
  const { path } = conflict, fixes = rec.parts.fix.length > 0 || rec.again === "fixup";
  if (path === null) return fixes ? { text: textFor({ fix: [], merges: rec.merges, again: "review" }), parts: { fix: [], drop: rec.parts.drop }, merges: rec.merges, again: "review" } : rec;
  if (!fixes && !rec.merges) return rec;
  if (byHand(path)) {
    if (!fixes) return { ...rec, text: ON_CONFLICT[path](rec.text), waits: path };
    return { text: ON_CONFLICT[path](t("Wait for that with the merge approved.")), parts: { fix: [], drop: rec.parts.drop }, merges: true, waits: path };
  }
  const out = rec.merges ? rec : { ...rec, merges: true, text: textFor({ fix: rec.parts.fix, merges: true }) };
  return path === "merge" ? out : { ...out, text: ON_CONFLICT[path](out.text) };
}

/**
 * What the item comes back with when its steps are done and the merge is not approved: the review's recommendation when it gave
 * one (without the parts a person dropped; its sentence written again when the parts changed), else one built from its verdict: fix
 * the planned parts then merge, merge, close, or review again. A yes always runs something. `stop`: what the PR ran into besides the
 * review (unapprovedStop), which the sentence names.
 */
export function afterSteps(review: ReviewView | null, plan: readonly PlanPart[], stop: keyof typeof STOPS | null = null, conflict: Conflict | null = null): Recommendation {
  const rec = onConflict(recommended(review, plan), conflict);
  // Where the sentence is already about the conflict and who settles it, it is not said twice.
  const said = stop === "conflict" && !!conflict?.path && conflict.path !== "merge" && rec.merges;
  return stop && !rec.close && !said ? { ...rec, text: STOPS[stop](rec.text) } : rec;
}

function recommended(review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const rec = review?.rec;
  if (rec) {
    if (rec.close) return { text: rec.text || textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
    const fix = rec.fix.filter((n) => !drop.includes(n));
    // A person dropped every part the review wanted fixed: the rule below decides what is left.
    if (!rec.fix.length || fix.length) {
      const out: Recommendation = { text: "", parts: { fix, drop }, merges: rec.merge, ...(fix.length || rec.merge ? {} : { again: "review" as const }) };
      return { ...out, text: rec.text && fix.length === rec.fix.length ? rec.text : textFor({ fix, merges: rec.merge, ...(out.again ? { again: out.again } : {}) }) };
    }
  }
  const fix = planned(plan);
  if (review?.verdict === "close") return { text: textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
  if (review && (review.verdict === "hold" || !review.sure) && !fix.length) {
    return { text: textFor({ fix: [], merges: false, again: "review" }), parts: { fix: [], drop }, merges: false, again: "review" };
  }
  return { text: textFor({ fix, merges: true }), parts: { fix, drop }, merges: true };
}

/** A question that takes the place of one the author pushed past. */
export const afterPush = (rec: Recommendation): Recommendation => ({ ...rec, text: t("The author pushed commits after the last question. {text}", { text: rec.text }) });

/**
 * What an item stopped at a blocker comes back with. A yes resumes the plan with the merge still approved:
 * - a failing step runs again (the fix-up of the planned parts, a new review for a failing CI fix; a stuck implementation comes back through question.ts);
 * - findings of the pre-merge review (`params.premerge`: their plan parts) are fixed first, never merged as they are;
 * - a major finding or a change outside the purpose takes the review's own recommendation when it gave one;
 * - the author's commits on a PR that merges without a review (`mergeEntry`) are reviewed; on any other they are anyway;
 * - for the rest, what the blocker was about is accepted as it is.
 */
export function atBlocker(found: Found, review: ReviewView | null, plan: readonly PlanPart[], mergeEntry = false): Recommendation {
  const drop = droppedOf(plan);
  const go = (text: string, extra: Partial<Recommendation> = {}): Recommendation => ({ text, parts: { fix: [], drop }, merges: true, ...extra });
  const p = found.params;
  const premerge = (p.premerge as number[] | undefined) ?? null;
  if (premerge) {
    if (premerge.length) return { text: t("Fix the pre-merge review's findings {parts}, then merge.", { parts: listText(premerge) }), parts: { fix: premerge, drop }, merges: true };
    return go(t("Review it again, then merge."), { again: "review" });
  }
  switch (found.blocker) {
    case "author-commits": return go(t("Review the new commits, then merge."), { newCommits: true, ...(mergeEntry ? { again: "review" } : {}) });
    case "failed-twice": {
      if (p.step === "fix-up") {
        const fix = planned(plan);
        return fix.length ? { text: t("Try the fix-up of {parts} again, then merge.", { parts: listText(fix) }), parts: { fix, drop }, merges: true } : go(t("Try the fix-up again, then merge."), { again: "fixup" });
      }
      return go(t("Review it again with the failing checks, then merge."), { again: "review" });
    }
    // The fix-up a leg stopped at pushed nothing.
    case "large-fix": return p.lines === undefined ? afterStop(String(p.reason ?? ""), go) : go(t("Keep the fix of {lines} lines, then merge.", { lines: Number(p.lines ?? 0) }));
    case "beyond-agreed": return go(t("Keep the changes to {files}, then merge.", { files: listText((p.files as string[] | undefined) ?? []) }));
    case "outside-purpose":
    case "major-finding": {
      if (review?.rec) return afterSteps(review, plan);
      const fix = planned(plan).filter((n) => plan.find((x) => x.n === n)?.major);
      if (fix.length) return { text: fixText(fix, true), parts: { fix, drop }, merges: true };
      return found.blocker === "outside-purpose" ? go(t("Keep the {lines} lines outside the purpose, then merge.", { lines: Number(p.lines ?? 0) })) : go(t("Merge it as it is."));
    }
    case "other": {
      return afterStop(String(p.reason ?? ""), go);
    }
  }
}

const afterStop = (reason: string, go: (text: string) => Recommendation): Recommendation =>
  go(reason ? t("Go on with the merge after this stop: {reason}", { reason: asSentence(reason) }) : t("Go on with the merge."));

/** The merge rule's reasons (core/decide.ts queueEntry) as a person reads them; a reason of its own wording is shown as it is. */
const RULE_REASONS: readonly (readonly [(r: string) => boolean, () => string])[] = [
  [(r) => r === UNSURE_REASON, () => t("the review is unsure")],
  [(r) => r === PREMERGE_DEFECT_REASON, () => t("the pre-merge review found a defect")],
  [(r) => r === PREMERGE_UNSURE_REASON, () => t("the pre-merge review could not verify a claim of the description")],
  [(r) => r === PREMERGE_FAILED_REASON, () => t("the pre-merge review failed")],
  [(r) => r.startsWith("conflicts with "), () => t("it goes against an earlier statement of the owners")],
  [(r) => r.startsWith("verification failed") || r.startsWith("verification errored"), () => t("verification failed")],
  [(r) => r.startsWith("the screenshots show"), () => t("the screenshots show a regression")],
];
/** Reasons a sentence names at most. */
const RULE_REASONS_SHOWN = 3;

/** The recommendation of a PR the automatic merge rule took up and stopped, with why the rule does not merge it. */
export function ruleStopped(rec: Recommendation, reasons: readonly string[]): Recommendation {
  const why = [...new Set(reasons.map((r) => RULE_REASONS.find(([is]) => is(r))?.[1]() ?? r))].slice(0, RULE_REASONS_SHOWN);
  return { ...rec, stop: why.length ? listText(why) : t("it needs a person's judgement") };
}

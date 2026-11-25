// Who makes the next fix of an approved PR: one of our steps, the contributor, or nobody but a person. Pure; the merge leg waits for the first two.
import { cifixBucket, decidePr, fixupOf, reviseOf } from "../core/decide.ts";
import { ownImplementation } from "../core/implementation.ts";
import type { PrFacts } from "../core/plan.ts";

export type FixPath = "fix" | "contributor" | null;

/** Our implementation PR whose revision by its session is planned or running: the review's fixes and red CI are its to repair. */
export const revisesNow = (f: PrFacts): boolean => !!reviseOf(f) || ownImplementation(f)?.state === "revising";

/**
 * Who repairs red CI at the leg's head: the CI fix step (or the implementation session), while it works the PR or the planner lists it, or the
 * contributor, who was asked or is asked next. Null when nobody but a person can go on: a step the planner does not list (not approved, held,
 * merge blocked) never moves the PR on, nobody is asked about CI our own push broke, and a PR of our own, or one nothing is said on, has nobody
 * to ask.
 */
export function redCiPath(f: PrFacts | null): FixPath {
  if (!f) return null;
  if (revisesNow(f)) return "fix";
  const b = cifixBucket(f), states = f.cifix?.states ?? [];
  const next = decidePr(f).actions.find((a) => a.kind === "cifix")?.params?.bucket;
  switch (b) {
    case "formatting": case "linting": case "rerun-wait": return "fix";
    case "work": case "collect": case "rerun": return next === b ? "fix" : null;
    case "done":
      if (states.includes("asked")) return f.authorIsPipeline ? null : "contributor";
      return states.includes("pushing") && !states.includes("comment-failed") && f.cifix?.unsent !== "final" ? "fix" : null;
    case "comment-wait": case "failed": case "capped": return !f.quiet && !f.brokeByUs && !f.authorIsPipeline && (b === "comment-wait" || next === "ask") ? "contributor" : null;
    default: return null;
  }
}

/** Who makes the fixes of the take-fix review at the leg's head, as `redCiPath`. */
export function fixPath(f: PrFacts): FixPath {
  const fx = fixupOf(f);
  switch (fx?.bucket) {
    case "fix": return "fix";
    // Pushed, or stored for its lint run; a push the branch refused, or tries used up with nobody asked, moves the PR no more.
    case "hold": return f.fixup?.recorded.some((s) => s === "pushed" || s === "linting") ? "fix" : null;
    case "ask": case "ask-retry": case "asked": return f.authorIsPipeline ? null : "contributor";
    default: return null;
  }
}

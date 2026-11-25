// Who makes the next fix of an approved PR (src/preapproval/paths.ts): the merge leg waits for our own steps and for a contributor who was or
// is asked, and stops for a person otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePr } from "../src/core/decide.ts";
import { fixPath, redCiPath, type FixPath } from "../src/preapproval/paths.ts";
import { prFacts } from "./world.ts";

type Over = Parameters<typeof prFacts>[0];
const NO_COMMENT = { repoFacts: { commentApproved: false } } as const;
const LATER = { unsent: { until: Date.parse("2026-11-04T13:00:00Z") } } as const;
const FINAL = { unsent: "final" } as const;
const red = (o: Record<string, unknown> = {}, over: Over = {}): Over => ({
  ci: "failure", cifix: { states: [], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: "2026-11-04T11:00:00.000Z", ...o } as never, ...over,
});
const takefix = (o: Record<string, unknown> = {}, over: Over = {}): Over => ({ review: { verdict: "take-fix", fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [], ...o } as never, ...over });
const CLOSED = { pushable: false } as const;

const CI: [string, Over, FixPath][] = [
  ["the CI fix can try", red(), "fix"],
  ["a formatter run", red({ states: ["formatting"], formattingTask: 4, formatterEnded: false }), "fix"],
  ["a push under way", red({ states: ["pushing"] }), "fix"],
  ["a rerun waits for approval", red({ infraRuns: [7] }, { repoFacts: { ciApproved: false } }), null],
  ["the tries at the head are used: the contributor is asked next", red({ tries: 2, states: ["failed", "failed"] }), "contributor"],
  ["the pushes of the PR are used: the contributor is asked next", red({ totalPushes: 2 }), "contributor"],
  ["the contributor was asked", red({ states: ["asked"] }), "contributor"],
  ["the ask did not reach GitHub and is posted again", red(LATER), "contributor"],
  ["the ask never reached GitHub", red(FINAL), null],
  ["the ask failed", red({ states: ["comment-failed"] }), null],
  ["nobody can be asked: no comment approval", red({ tries: 2, states: ["failed", "failed"] }, NO_COMMENT), null],
  ["nobody can be asked: a quiet PR", red({ tries: 2, states: ["failed", "failed"] }, { quiet: true }), null],
  ["nobody to ask: a PR of our own", red({ states: ["asked"] }, { authorIsPipeline: true }), null],
  ["our own push broke it and the CI fix gave up", red({ tries: 2, states: ["failed", "failed"] }, { brokeByUs: true }), null],
  ["the push was refused", red({ states: ["push-denied"] }), null],
  ["nothing to fix", red({ states: ["skipped"] }), null],
];

const FIX: [string, Over, FixPath][] = [
  ["the fix-up can run", takefix(), "fix"],
  ["pushed", takefix({ recorded: ["pushed"] }), "fix"],
  ["stored for its lint run", takefix({ recorded: ["linting"] }), "fix"],
  ["the push was refused", takefix({ recorded: ["push-denied"] }), null],
  ["the branch takes no push: the contributor is asked next", takefix({}, CLOSED), "contributor"],
  ["the contributor was asked", takefix({ recorded: ["asked"] }, CLOSED), "contributor"],
  ["too large: the contributor is asked next", takefix({ recorded: ["too-large"] }), "contributor"],
  ["the ask did not reach GitHub and is posted again", takefix(LATER, CLOSED), "contributor"],
  ["the ask never reached GitHub", takefix(FINAL, CLOSED), null],
  ["the ask failed", takefix({ recorded: ["comment-failed"] }, CLOSED), null],
  ["nobody can be asked: no comment approval", takefix({}, { ...CLOSED, ...NO_COMMENT }), null],
  ["tries used up and no comment approval", takefix({ attempts: 2 }, NO_COMMENT), null],
  ["nobody can be asked: a quiet PR", takefix({}, { ...CLOSED, quiet: true }), null],
  ["nobody to ask: a PR of our own", takefix({ recorded: ["asked"] }, { ...CLOSED, authorIsPipeline: true }), null],
];

test("an approved PR waits for the contributor who was or is asked, and stops when nobody can be", () => {
  for (const [rows, path] of [[CI, redCiPath], [FIX, fixPath]] as const) {
    for (const [name, over, want] of rows) {
      const f = prFacts(over);
      assert.equal(path(f), want, name);
      // The leg and the plan wait for the same.
      if (want === "contributor") assert.notEqual(decidePr(f).waitKind, "person", name);
      if (decidePr(f).waitKind === "contributor" && !f.quiet && !f.authorIsPipeline) assert.equal(want, "contributor", name);
    }
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PREMERGE_OPUS, REVIEW_OPUS } from "../src/agents/steps.ts";
import type { OpusPr } from "../src/review/opus-parse.ts";

test("Review and Pre-merge verify claim citations in the reviewed checkout", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "autocraft-review-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(join(checkout, "main.rs"), "first line\r\nsecond line\r\n");
  writeFileSync(join(checkout, "Makefile"), "one line without a final newline");
  writeFileSync(join(checkout, "new guide.md"), "one line");
  const input: OpusPr = {
    ref: "app#1", title: "Updates a check", body: "The check runs on startup.", author_association: null,
    size: "S", lines_changed: 2, ci: "success", mergeable: null, files: ["main.rs", "Makefile", "new guide.md"],
    tests_omitted: [], lockfiles_omitted: [], mode: "full", earlier_opus: null, diff: "",
  };
  const context = { dir: undefined, semantic: undefined, checkout };
  for (const [evidence, resolves] of [
    ["/repo/main.rs:2, Makefile:1 and new guide.md:1", true],
    ["main.rs:2 and missing.rs:1", false],
    ["main.rs:3", false],
    ["main.rs:0", false],
    ["Makefile:2", false],
  ] as const) {
    const claims = [{ claim: "The check runs on startup.", status: "verified", evidence }];
    const reply = JSON.stringify({
      ref: input.ref, verdict: "take", sure: true, reason: "fine", fixes: [], findings: [], claims,
    });
    const review = (await REVIEW_OPUS.parse(reply, input, { attempt: 0, last: true }, context))?.value.review;
    const premerge = (await PREMERGE_OPUS.parse(reply, input, { attempt: 0, last: true }, context))?.value;
    assert.equal(review?.sure, resolves, evidence);
    assert.equal(premerge?.unsure, !resolves, evidence);
    for (const result of [review, premerge]) {
      assert.equal(result?.claims[0]?.status, resolves ? "verified" : "unverified", evidence);
    }
  }
});

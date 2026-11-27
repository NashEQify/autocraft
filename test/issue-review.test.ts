// `review` on an issue: the maintainer's start runs one model review of the issue on their own Task Runner, posts it, and comes back
// with its recommendation, which a yes carries out; `review and implement` goes on to implement without a question.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "../src/fixup/git.ts";
import type { IssueReview } from "../src/issuereview/prompt.ts";
import { runIssueReviews } from "../src/issuereview/run.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { liveWorkflow, workflowHistory } from "../src/workflow/store.ts";
import type { World } from "./world-db.ts";
import { MAINT, run, send, settle, unstarted } from "./workflow-start-world.ts";

const reviewOf = (recommendation: IssueReview["recommendation"], extra: Partial<IssueReview> = {}): IssueReview => ({
  asks: "Return None for an empty slice.", holds: "yes", claims: [{ claim: "first() indexes element 0", status: "holds", where: "src/lib.rs:12" }], related: [],
  size: "S", files: ["src/lib.rs"], approach: "Check the length first.", risks: [], recommendation, reason: "It still panics on an empty slice.", ...extra,
});

/** Runs the issue review job with the review the model gives; returns the logins whose Task Runners were asked and the posted comments. */
async function reviewJob(w: World, review: IssueReview) {
  const asked: string[] = [], posted: string[] = [];
  const exec: Exec = async (_cmd, args, o) => {
    const input = String((o as { input?: string } | undefined)?.input ?? "");
    if (input) posted.push(input);
    return { code: 0, stdout: args.includes("comment") ? "https://github.com/storytold/app/issues/7#issuecomment-1\n" : "", stderr: "" };
  };
  await runIssueReviews(w.db, { repo: "app", by: "pipeline" }, () => {}, {
    checkout: async () => null, exec, mint: async () => "installation-token",
    ask: async (_input, forLogin) => { asked.push(forLogin); return { value: review, model: "claude-opus-5-5" }; },
  });
  await settle(w);
  return { asked, posted };
}

test("review on an issue runs its review on the starter's Task Runner, posts it, and a yes to its close recommendation closes the issue as the review said", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "review", 7);
  assert.equal((await liveWorkflow(w.db, "app", 7))?.entry, "review");
  const jobs = await LANES.find((l) => l.name === "issue-review")!.detect(w.db, await planCtx(w.db));
  assert.deepEqual(jobs.map((j) => j.params.repo), ["app"], "the issue review step is planned for the issue");

  const { asked, posted } = await reviewJob(w, reviewOf("close", { close_as: "not-planned" }));
  assert.deepEqual(asked, [MAINT], "the review runs on the Task Runner of the maintainer who started it");
  const comment = posted.find((p) => p.includes("Recommendation:")) ?? "";
  assert.match(comment, /AI-generated review \(Claude Opus 5\.5\)/, comment);
  assert.match(comment, /src\/lib\.rs:12/);
  assert.match(comment.trimEnd().split("\n").at(-1)!, /^Recommendation: close it as not planned\./);
  assert.ok(!comment.includes("AutoCraft"), comment);

  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.ok(wf.rec?.close, JSON.stringify(wf.rec));
  const o = await send(w, "yes", 7);
  assert.equal(o.outcome, "run", o.line);
  assert.equal((await workflowHistory(w.db, "app", 7)).at(-1)?.state, "closed");
  assert.deepEqual(await w.rows("SELECT kind, close_as FROM workflow_actions WHERE number = 7"), [{ kind: "comment-close", close_as: "not-planned" }]);
});

test("review and implement on an issue goes on to implement when the review recommends it, and asks when it recommends something else", async () => {
  const w = await (await (await unstarted(false)).issue(7)).issue(9);
  await run(w, "review and implement", 7);
  await reviewJob(w, reviewOf("implement"));
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.entry, wf.state, wf.rec], ["implement", "running", null], "implement starts without a question");

  await run(w, "review and implement", 9);
  await reviewJob(w, reviewOf("backlog"));
  const other = (await liveWorkflow(w.db, "app", 9))!;
  assert.deepEqual([other.entry, other.state, other.rec?.issue?.action], ["review", "recommending", "backlog"]);
});

// What the merge step and the planner refuse around a maintainer workflow: an author's push under a push of ours, the time after the
// merge leg ended until the workflow moves on, and an item a person stopped. Each case would merge by the repo's merge rule.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { guard } from "../src/core/guard.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { mergeMay } from "../src/core/gates.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { scopeSettled } from "../src/review/opus.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const command = async (w: World, text: string, number = 1) => {
  const r = await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
};
/** A small bug fix by a whitelisted author, in a repo whose merge rule may merge it: ready at sha1. */
async function ready(): Promise<World> {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await (await (await (await w.pr(1)).review(1)).verified(1)).premerge(1, "clean");
  return w;
}
/** Its merge approved by a person, whose leg handed it over. */
async function handedOver(): Promise<World> {
  const w = await (await ready()).workflow(1, { by: MAINT });
  await advanceWorkflows(w.db);
  for (let i = 0; i < 4; i++) await advancePreapprovals(w.db);
  return w;
}
const setLeg = async (w: World, set: { state?: string; head?: string; reason?: string }) =>
  void await w.db.run(w.db.k.updateTable("main.preapprovals").set({ ...set, updated_at: new Date().toISOString() }).where("number", "=", 1));
/** Whether the PR merges now: the plan has the merge and its gate passes, the merge step's fresh check passes, and the guard right before the write passes. */
async function merges(w: World, head = "sha1"): Promise<boolean[]> {
  const f = (await loadPrFact(w.db, "app", 1))!;
  const planned = (await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.head === head) && mergeMay(f)!.ok;
  const verdict = (await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1)!.ok;
  const g = await guard(w.db, { repo: "app", number: 1 }, { kind: "merge", head }, "pipeline", async () => ({ state: "OPEN", head, draft: false, mergeable: "MERGEABLE" }));
  return [planned, verdict, !("refused" in g)];
}
const ALL = [true, true, true], NONE = [false, false, false];
const refusedBy = async (w: World, head = "sha1") => { const v = (await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1)!; return v.ok ? null : v.why; };

test("an approved PR merges only through its handed-over leg, also where the repo's merge rule would merge it", async () => {
  const w = await (await ready()).workflow(1, { by: MAINT });
  assert.deepEqual(await merges(w), NONE, "approved, its leg not started");
  await advanceWorkflows(w.db);
  assert.deepEqual(await merges(w), NONE, "its leg at work");
  for (let i = 0; i < 4; i++) await advancePreapprovals(w.db);
  assert.deepEqual(await merges(w), ALL, "handed over");
});

test("after the merge leg was cancelled or failed nothing merges before the workflow moved on, nor after it asked", async () => {
  for (const state of ["cancelled", "failed"]) {
    const w = await handedOver();
    assert.deepEqual(await merges(w), ALL);
    await setLeg(w, { state, reason: "the PR conflicts with its base branch" });
    assert.deepEqual(await merges(w), NONE, state);
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "blocked");
    assert.deepEqual(await merges(w), NONE, `${state}, then asked`);
    w.close();
  }
});

test("a stopped PR does not merge on the repo's approval until someone starts it again", async () => {
  const w = await ready();
  assert.deepEqual(await merges(w), ALL, "the rule merges it unstarted");
  await command(w, "review and merge");
  await command(w, "stop");
  assert.deepEqual(await merges(w), NONE);
  assert.match((await refusedBy(w))!, /stopped/);
});

test("the pull request of a stopped issue does not merge on the repo's approval", async () => {
  const w = await (await ready()).issue(7);
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, attempt: 1, state: "pr-opened", pr_number: 1, text_hash: "h", queued_by: MAINT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never));
  await command(w, "implement", 7);
  await command(w, "stop", 7);
  assert.deepEqual(await merges(w), NONE);
  assert.match((await refusedBy(w))!, /stopped/);
});

test("our push on top of an author's push does not merge; two pushes of ours do", async () => {
  const w = await handedOver();
  const push = async (from: string, to: string) => void await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: from, to_head: to, base_sha: "m", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" } as never));
  await w.synced(1, "c");
  await setLeg(w, { head: "c" });
  await push("b", "c");
  assert.match((await refusedBy(w, "c"))!, /author pushed/);
  await push("sha1", "b");
  assert.equal(await refusedBy(w, "c"), null);
});

test("someone else's push to an implementation PR before its merge leg starts brings the issue back", async () => {
  const w = await (await (await (await world()).repo()).acting(MAINT)).issue(7);
  current = w;
  await w.pr(8, { author: "craft-bot" });
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, attempt: 1, state: "pr-opened", pr_number: 8, text_hash: "h", queued_by: MAINT, created_at: new Date(Date.now() + 1000).toISOString(), updated_at: new Date().toISOString() } as never));
  await w.db.run(w.db.k.insertInto("main.own_commits").values([{ repo: "app", sha: "sha8", action: "implement-push", at: "t" }, { repo: "app", sha: "rev", action: "implement-push", at: "t" }]));
  await command(w, "implement and merge", 7);
  await w.synced(8, "rev");
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "implement", action: "implement-push", repo: "app", number: 8, from_oid: "theirs", to_oid: "rev", before_res: "green" }));
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.blocker], ["blocked", "author-commits"]);
  await command(w, "yes", 7);
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.state, "running", "the yes accepted the head it was shown");
});

test("a review gets settled scope once a person approved the merge or started a merging entry, not for a plain review start", async () => {
  const w = await (await ready()).workflow(1, { by: MAINT, approved: false });
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual(scopeSettled(wf), {});
  assert.deepEqual(scopeSettled(undefined), {});
  assert.equal(scopeSettled({ ...wf, approvedBy: "ann" }).scope_settled?.by, "ann");
  for (const entry of ["merge", "fixup", "implement"] as const) assert.equal(scopeSettled({ ...wf, entry }).scope_settled?.by, MAINT);
});

test("started work under the box identity says that it waits for the GitHub App", async () => {
  const w = await (await (await (await world()).repo()).acting(MAINT)).issue(7);
  current = w;
  await command(w, "implement", 7);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(await legWait(w.db, wf), null);
  await w.db.run(w.db.k.updateTable("main.settings").set({ value: "box" }).where("key", "=", "github_identity"));
  assert.match((await legWait(w.db, wf))!, /GitHub App/);
  const step = implementStep((await loadItemFact(w.db, "app", 7))!);
  assert.ok(step && "wait" in step && /GitHub App/.test(step.wait), JSON.stringify(step));
});

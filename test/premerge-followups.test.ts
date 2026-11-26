// An approved merge with green CI stops only at a blocking pre-merge defect; the others become one follow-up issue and the PR merges.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPremergeFollowups } from "../src/premerge/followups.ts";
import { appLane } from "./acting.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import type { World } from "./world-db.ts";
import { mergesAsPerson, review, run, settle, unstarted } from "./workflow-start-world.ts";

const NOT_BLOCKING = { class: null, why: "The empty list fails the same way on the base branch." } as const;
const kinds = async (w: World) => (await w.prPlan(1)).actions.map((a) => (a.kind === "fixup" ? `fixup:${a.params?.source}` : a.kind));
const fixRound = async (w: World) => (await kinds(w)).includes("fixup:premerge");

async function approvedWith(blocking?: { class: "regression" | null; why: string }): Promise<World> {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "merge");
  await w.premerge(1, "defect", true, "off by one", blocking);
  await settle(w);
  return w;
}

test("a defect that does not block is filed in one follow-up issue before the merge, with no fix-up round or question", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  const due = await kinds(w);
  assert.ok(due.includes("followups") && !due.includes("merge") && !due.includes("fixup:premerge"), due.join(", "));
  const made: string[][] = [];
  const exec = async (_c: string, args: string[]) => { made.push(args); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/77\n" : "", stderr: "" }; };
  const deps = { exec, now: () => new Date(), lane: appLane(w.gh.querier) };
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(made.find((a) => a[1] === "create")!.join(" "), /Follow-ups from #1/);
  // Filed once per head: a second run opens nothing, and the merge goes on as the approver.
  assert.deepEqual((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).filed, []);
  await settle(w);
  await mergesAsPerson(w);
  w.close();
});

test("a blocking defect, or one stored before defects were classed, gets the automatic fix-up round and files nothing", async () => {
  for (const blocking of [{ class: "regression" as const, why: "Lists that load on the base branch panic." }, undefined]) {
    const w = await approvedWith(blocking);
    assert.equal(await fixRound(w), true, JSON.stringify(blocking));
    assert.equal((await kinds(w)).includes("followups"), false);
    w.close();
  }
});

test("a later head of ours with the same follow-up posts nothing, and its merge goes on", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  const made: string[][] = [];
  const exec = async (_c: string, args: string[]) => { made.push(args); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/77\n" : "", stderr: "" }; };
  const deps = { exec, now: () => new Date(), lane: appLane(w.gh.querier) };
  assert.deepEqual((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).filed, ["app#1"]);
  // A push of ours (a base update) moves the head; the new head's pre-merge review finds the same defect.
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha2", state: "pushed", attempt: 1, created_at: new Date().toISOString(), source: "premerge" }));
  await w.synced(1, "sha2");
  await review(w, "sha2");
  await (await w.verified(1)).premerge(1, "defect", true, "off by one", NOT_BLOCKING);
  await settle(w);
  assert.ok((await kinds(w)).includes("followups"));
  const posts = made.length;
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps);
  assert.deepEqual([s.repeated, made.length], [["app#1"], posts]);
  await settle(w);
  await mergesAsPerson(w, "sha2");
  w.close();
});

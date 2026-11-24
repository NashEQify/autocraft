// Moving a repo to the maintainer workflow and back (src/workflow/flip.ts).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { getDecision } from "../src/decisions.ts";
import { questionDecisionId } from "../src/implement/questions.ts";
import { setStatusApproval, statusApprovalOf } from "../src/prstatus/approval.ts";
import { FlipRefused, flipRepo } from "../src/workflow/flip.ts";
import { insertWorkflow, liveWorkflows, repoWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MERGE = JSON.stringify([{ key: "merge", label: "Merge" }, { key: "hold", label: "Hold" }, { key: "backlog", label: "Backlog" }]);

/** Repo "app" mid-flight in the legacy pipeline: a pre-approved, fast-tracked PR, open questions of several kinds. */
async function legacyRepo(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  for (const n of [1, 5, 7, 8]) await w.pr(n);
  for (const n of [6, 9]) await w.issue(n);
  await db.run(db.k.insertInto("main.fast_track").values({ repo: "app", number: 1, added_by: "maint", added_at: T0, weight: 8 }));
  await db.run(db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: OPERATOR, at: T0, instructions: "", state: "ci", from_head: "sha1", head: "sha1", updated_at: T0 }));
  const ask = (id: string, kind: string, number: number, options = MERGE) =>
    db.run(db.k.insertInto("main.decisions").values({ id, kind, repo: "app", number, question: "Q?", options, asked_at: T0 }));
  await ask(mergeDecisionId("app", 5, "sha5"), "merge", 5);
  await ask("app#6:scope", "scope", 6, "[]");
  await ask("app#7:duplicate@8", "duplicate", 7, "[]");
  await ask(questionDecisionId("app", 9, 1, 1), "other", 9, "[]");
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  return w;
}

const legacyRows = async (w: World) => ({
  fast: await w.db.all(w.db.k.selectFrom("main.fast_track").select(["number", "added_by", "weight"]).orderBy("number")),
  pre: await w.db.all(w.db.k.selectFrom("main.preapprovals").select(["number", "state", "head", "workflow_id"]).orderBy("id")),
});

const counts = async (w: World) => {
  const db = w.db;
  const n = (r: { n: number } | undefined) => Number(r!.n);
  return {
    workflows: n(await db.get(db.k.selectFrom("main.item_workflows").select((eb) => eb.fn.countAll<number>().as("n")))),
    openDecisions: n(await db.get(db.k.selectFrom("main.decisions").select((eb) => eb.fn.countAll<number>().as("n")).where("answer", "is", null))),
    audit: n(await db.get(db.k.selectFrom("main.audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", "workflow-flip"))),
  };
};

test("a flip starts over: no workflow rows, open Merge? and scope questions withdrawn, the rest kept", async () => {
  const w = await legacyRepo();
  const db = w.db;
  await assert.rejects(flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true, engineReady: false }), FlipRefused, "refused until the planner works workflows");
  const was = await legacyRows(w);
  const dry = await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: false, engineReady: true });
  assert.equal((await counts(w)).openDecisions, 4, "a dry run writes nothing");
  await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true, engineReady: true });
  assert.equal(await repoWorkflow(db, "app"), "new");
  assert.equal((await counts(w)).workflows, 0);
  assert.deepEqual(await legacyRows(w), was, "pre-approvals and fast track are left alone");
  assert.deepEqual(dry.withdrawn.map((d) => d.id).sort(), [mergeDecisionId("app", 5, "sha5"), "app#6:scope"].sort());
  assert.equal(await getDecision(db, mergeDecisionId("app", 5, "sha5")), undefined);
  const set = await db.get(db.k.selectFrom("main.decisions").select("answer").where("id", "like", `${mergeDecisionId("app", 5, "sha5")}~replaced-flip-%`));
  assert.equal(set?.answer, "withdrawn");
  assert.equal((await getDecision(db, "app#7:duplicate@8"))?.answer, null);
  assert.equal((await getDecision(db, questionDecisionId("app", 9, 1, 1)))?.answer, null);
});

test("a flip turns the PR status comment on; a second flip changes nothing unless the switch was turned off", async () => {
  const w = await legacyRepo();
  assert.equal(await statusApprovalOf(w.db, "app"), null);
  const dry = await flipRepo(w.db, "app", { to: "new", by: OPERATOR, apply: false, engineReady: true });
  assert.ok(dry.statusOn && await statusApprovalOf(w.db, "app") === null, "a dry run reports the switch and leaves it");
  await flipRepo(w.db, "app", { to: "new", by: OPERATOR, apply: true, engineReady: true });
  assert.equal((await statusApprovalOf(w.db, "app"))?.by, OPERATOR);
  const before = await counts(w);
  const again = await flipRepo(w.db, "app", { to: "new", by: OPERATOR, apply: true, engineReady: true });
  assert.equal(again.applied, false);
  assert.deepEqual(await counts(w), before);
  // A repo whose switch is off (flipped before the switch came with the workflow) gets it on a re-flip.
  await setStatusApproval(w.db, OPERATOR, "app", false);
  const fixed = await flipRepo(w.db, "app", { to: "new", by: "maint", apply: true, engineReady: true });
  assert.ok(fixed.applied && fixed.statusOn);
  assert.equal((await statusApprovalOf(w.db, "app"))?.by, "maint");
  assert.equal(await repoWorkflow(w.db, "app"), "new");
  await flipRepo(w.db, "app", { to: "legacy", by: OPERATOR, apply: true });
  assert.notEqual(await statusApprovalOf(w.db, "app"), null, "a rollback leaves the switch as it is");
});

test("a flip back to legacy stops the workflows and leaves the legacy rows working", async () => {
  const w = await legacyRepo();
  const db = w.db;
  const was = await legacyRows(w);
  await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true, engineReady: true });
  const id = await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "review", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "dashboard" });
  await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: id }).where("number", "=", 1));
  const back = await flipRepo(db, "app", { to: "legacy", by: OPERATOR, apply: true });
  assert.ok(back.reasked > 0, "the rollback reports the questions the legacy planner asks again");
  assert.equal(await repoWorkflow(db, "app"), "legacy");
  assert.deepEqual(await liveWorkflows(db, "app"), []);
  assert.deepEqual(await legacyRows(w), was, "pre-approvals lose the link and are otherwise as they were");
  // The withdrawn Merge? question's id is free again, so the legacy planner asks it anew.
  await db.run(db.k.insertInto("main.decisions").values({ id: mergeDecisionId("app", 5, "sha5"), kind: "merge", repo: "app", number: 5, question: "Merge?", options: MERGE, asked_at: T0 }));
});

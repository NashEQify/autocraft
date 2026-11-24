// Moving a repo and its in-flight items to the maintainer workflow and back (src/workflow/flip.ts).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { getDecision } from "../src/decisions.ts";
import { questionDecisionId } from "../src/implement/questions.ts";
import { FlipRefused, flipRepo } from "../src/workflow/flip.ts";
import { liveWorkflow, liveWorkflows, repoWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const opts = (o: { key: string; label: string }[]) => JSON.stringify(o);

/** One item of every in-flight kind in the repo "app". */
async function inFlight(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  for (const n of [1, 3, 4, 5, 7, 8]) await w.pr(n);
  for (const n of [2, 6, 9]) await w.issue(n);
  const ft = (number: number, added_by: string, weight = 5) => db.run(db.k.insertInto("main.fast_track").values({ repo: "app", number, added_by, added_at: T0, weight }));
  const pre = (number: number, state: string, o: { reason?: string; fix_id?: number } = {}) => db.run(db.k.insertInto("main.preapprovals").values({
    repo: "app", number, by: OPERATOR, at: T0, instructions: "", state, from_head: `sha${number}`, head: `sha${number}`, reason: o.reason ?? null, updated_at: T0, fix_id: o.fix_id ?? null,
  }));
  const ask = (id: string, kind: string, number: number, options: { key: string; label: string }[], recommended: string | null = null, reason: string | null = null) =>
    db.run(db.k.insertInto("main.decisions").values({ id, kind, repo: "app", number, question: "Q?", options: opts(options), recommended, recommended_reason: reason, asked_at: T0 }));
  const MERGE = [{ key: "merge", label: "Merge" }, { key: "hold", label: "Hold" }, { key: "backlog", label: "Backlog" }];
  await ft(1, "maint", 8);
  await ft(2, "maint");
  await pre(3, "ci", { fix_id: 11 });
  await pre(4, "asked", { reason: "the pre-merge review found 2 defects" });
  await ask(mergeDecisionId("app", 4, "sha4"), "merge", 4, MERGE, "hold", "Two defects need a fix first.");
  await ask(mergeDecisionId("app", 5, "sha5"), "merge", 5, MERGE, "merge");
  await ask("app#6:scope", "scope", 6, [{ key: "in", label: "In scope" }, { key: "out", label: "Out of scope" }]);
  await ask("app#7:duplicate@8", "duplicate", 7, [{ key: "keep-7", label: "Keep #7" }]);
  await ft(9, "maint", 10);
  await ask(questionDecisionId("app", 9, 1, 1), "other", 9, [{ key: "a", label: "Cache the result" }, { key: "b", label: "Compute it lazily" }, { key: "backlog", label: "Backlog" }], "b");
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  return w;
}

const counts = async (w: World) => {
  const db = w.db;
  const n = (r: { n: number } | undefined) => Number(r!.n);
  return {
    workflows: n(await db.get(db.k.selectFrom("main.item_workflows").select((eb) => eb.fn.countAll<number>().as("n")))),
    events: n(await db.get(db.k.selectFrom("main.workflow_events").select((eb) => eb.fn.countAll<number>().as("n")))),
    openDecisions: n(await db.get(db.k.selectFrom("main.decisions").select((eb) => eb.fn.countAll<number>().as("n")).where("answer", "is", null))),
    audit: n(await db.get(db.k.selectFrom("main.audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", "workflow-flip"))),
  };
};

test("a flip maps each in-flight kind and refuses while the identity is box", async () => {
  const w = await inFlight();
  const db = w.db;
  await db.run(db.k.updateTable("main.settings").set({ value: "box" }).where("key", "=", "github_identity"));
  await assert.rejects(flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true }), FlipRefused);
  assert.equal(await repoWorkflow(db, "app"), "legacy");
  await db.run(db.k.updateTable("main.settings").set({ value: "app" }).where("key", "=", "github_identity"));

  const dry = await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: false });
  assert.equal((await counts(w)).workflows, 0, "a dry run writes nothing");
  await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true });
  assert.deepEqual((await liveWorkflows(db, "app")).map((x) => x.number), dry.started.map((s) => s.number));

  const pr1 = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([pr1.entry, pr1.approvedBy, pr1.weight, pr1.state], ["fixup", null, 8, "running"]);
  const issue2 = (await liveWorkflow(db, "app", 2))!;
  assert.deepEqual([issue2.entry, issue2.approvedBy], ["implement", "maint"]);
  const pr3 = (await liveWorkflow(db, "app", 3))!;
  assert.equal(pr3.approvedBy, OPERATOR);
  const p3 = (await db.get(db.k.selectFrom("main.preapprovals").select(["id", "state", "workflow_id"]).where("number", "=", 3)))!;
  assert.deepEqual([pr3.legacyPreapprovalId, p3.state, p3.workflow_id], [p3.id, "ci", pr3.id], "the pre-approval finishes unchanged, owned by the workflow");
  const pr4 = (await liveWorkflow(db, "app", 4))!;
  assert.deepEqual([pr4.state, pr4.blocker, pr4.approvedBy, pr4.rec?.merges], ["blocked", "major-finding", OPERATOR, false]);
  assert.equal(pr4.rec?.text, "Two defects need a fix first.");
  assert.equal((await getDecision(db, mergeDecisionId("app", 4, "sha4")))?.answer, null, "a started PR's question stays open");
  const issue9 = (await liveWorkflow(db, "app", 9))!;
  assert.deepEqual([issue9.state, issue9.plan.map((p) => p.title), issue9.rec?.parts.fix], ["recommending", ["Cache the result", "Compute it lazily"], [2]]);

  assert.equal(await liveWorkflow(db, "app", 5), null);
  assert.equal(await getDecision(db, mergeDecisionId("app", 5, "sha5")), undefined, "an unstarted PR's Merge? question is set aside");
  const set = await db.get(db.k.selectFrom("main.decisions").select("answer").where("id", "like", `${mergeDecisionId("app", 5, "sha5")}~%`));
  assert.equal(set?.answer, "withdrawn");
  assert.equal(await getDecision(db, "app#6:scope"), undefined, "scope questions are withdrawn");
  assert.equal((await getDecision(db, "app#7:duplicate@8"))?.answer, null, "a duplicate question stays");
});

test("a second flip changes nothing", async () => {
  const w = await inFlight();
  await flipRepo(w.db, "app", { to: "new", by: OPERATOR, apply: true });
  const before = await counts(w);
  const again = await flipRepo(w.db, "app", { to: "new", by: OPERATOR, apply: true });
  assert.equal(again.applied, false);
  assert.deepEqual(await counts(w), before);
});

test("a flip back to legacy stops the workflows and leaves the legacy rows working", async () => {
  const w = await inFlight();
  const db = w.db;
  const legacy = async () => ({
    fast: await db.all(db.k.selectFrom("main.fast_track").select(["number", "added_by", "weight"]).orderBy("number")),
    pre: await db.all(db.k.selectFrom("main.preapprovals").select(["number", "state", "reason", "head"]).orderBy("id")),
  });
  const was = await legacy();
  await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true });
  await flipRepo(db, "app", { to: "legacy", by: OPERATOR, apply: true });
  assert.equal(await repoWorkflow(db, "app"), "legacy");
  assert.deepEqual(await liveWorkflows(db, "app"), []);
  assert.deepEqual(await legacy(), was, "fast track and pre-approvals are as they were");
  // The withdrawn Merge? question's id is free again, so the legacy planner asks it anew.
  await db.run(db.k.insertInto("main.decisions").values({ id: mergeDecisionId("app", 5, "sha5"), kind: "merge", repo: "app", number: 5, question: "Merge?", options: "[]", asked_at: T0 }));
  // And the repo can move forward again from the same legacy rows.
  const back = await flipRepo(db, "app", { to: "new", by: OPERATOR, apply: true });
  assert.ok(back.started.some((s) => s.number === 3));
  assert.equal((await liveWorkflow(db, "app", 3))?.approvedBy, OPERATOR);
});

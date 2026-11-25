// A PR the automatic merge rule took up and stopped for a person's judgement comes back with a recommendation, like a started item, and
// whoever answers takes it over; a wait that clears by itself makes no question.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadPrFact } from "../src/core/facts.ts";
import { mergeMay } from "../src/core/gates.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { findAutoStops } from "../src/workflow/auto-stop.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";
import { T0, untilQuiet, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const say = async (w: World, text: string) => (await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: 1 }] })).items[0]!;
const rows = async (w: World, n: number) => (await w.rows(`SELECT id FROM item_workflows WHERE number = ${n}`)).length;

test("the automatic merge rule's unsure stop asks once, the answer makes the merge the answerer's, and a CI wait asks nothing", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await w.pr(1);
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 1, head_oid: "sha1", run_id: "rv", at: T0, model: "m", mode: "full", verdict: "take", sure: 0, reason: "r",
    workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Merge it.", fix: [], merge: true, close: false } }),
  }));
  await (await w.verified(1)).premerge(1, "clean");
  await (await (await (await w.pr(2, { ci: "pending" })).review(2)).verified(2)).premerge(2, "clean");
  const stops = async () => (await w.db.seqs())["auto-stops"] ?? 0;
  const before = await stops();
  await writePlanCache(w.db, await w.plan());
  assert.equal((await w.prPlan(1)).waitCode, "answer");
  assert.ok(await stops() > before, "storing the stop wakes the workflow pass");
  const stored = await stops();
  await writePlanCache(w.db, await w.plan());
  assert.equal(await stops(), stored, "the same plans again wake nothing");

  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.startedBy, wf.approvedBy, wf.recHead], ["recommending", RULE_STARTER, null, "sha1"]);
  assert.match(wf.rec!.text, /^The automatic merge rule stops here: the review is unsure\. Merge it\./);
  assert.equal(await liveWorkflow(w.db, "app", 2), null, "a CI wait is no question");

  await advanceWorkflows(w.db);
  assert.equal(await rows(w, 1), 1, "one row per PR");

  assert.equal((await say(w, "yes")).outcome, "run");
  await untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 8);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.approvedBy, MAINT);
  const may = mergeMay((await loadPrFact(w.db, "app", 1))!);
  assert.ok(may?.ok && may.as === "person" && may.by === MAINT, JSON.stringify(may));

  assert.equal((await say(w, "hold")).outcome, "run");
  assert.deepEqual(await findAutoStops(w.db), [], "an ended workflow is not started again");
  await advanceWorkflows(w.db);
  assert.equal(await rows(w, 1), 1);
});

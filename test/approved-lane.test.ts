// A PR a maintainer approved for merge gets a job of its own for each approved-lane step as soon as it is due: it waits neither for the
// repo's regular job nor for another approved PR's job, and one PR never has two jobs of a step.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { enqueue, getJob } = await import("../src/runner/jobs.ts");
const { Runner } = await import("../src/runner/runner.ts");
const { setStepParallel } = await import("../src/runner/concurrency.ts");
const { applyProposals, detectAutopilot, laneCandidates } = await import("../src/runner/autopilot.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "approved-lane-"));
const db = await connectDb(join(dir, "t.db"));
await db.run(db.k.insertInto("tracked_repos").values({ name: "a", pipeline: 1 }).onConflict((oc) => oc.doNothing()));
// The runner starts the planner's jobs only while the pipeline is on.
await db.run(db.k.insertInto("settings").values({ key: "pipeline_enabled", value: "1" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "1" })));
const runner = new Runner({ db, dbTarget: join(dir, "t.db"), logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });
after(async () => { await runner.stop(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

const state = async (id: number) => (await getJob(db, id)).state;
async function pump(cond: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await runner.tick();
    await new Promise((x) => setTimeout(x, 50));
  }
}

test("approved PRs due while the repo's regular job runs each start a job at once", async () => {
  await setStepParallel(db, 1, "test");
  const regular = await enqueue(db, "test-lane", { repo: "a", ms: 20_000 }, "pipeline");
  await pump(async () => await state(regular.id) === "running");

  // PRs 1 and 2 are approved for merge, PR 3 is regular work of the same repo.
  const due = [{ repo: "a", number: 1, approved: true }, { repo: "a", number: 2, approved: true }, { repo: "a", number: 3, approved: false }];
  const lanes = [{ name: "lane", steps: ["test-lane"], perRepo: true, detect: async () => laneCandidates("test-lane", ["a"], due).map((c) => ({ ...c, params: { ...c.params, ms: 10_000 } })) }];
  const ids = await applyProposals(db, (await detectAutopilot(db, { lanes })).proposals, { lanes });
  const queued = await Promise.all(ids.map((id) => getJob(db, id)));
  assert.deepEqual(queued.map((j) => j.params.number).sort(), [1, 2], "one job per approved PR; the regular work waits for the running regular job");

  await pump(async () => (await Promise.all(ids.map(state))).every((s) => s !== "queued"));
  assert.equal(await state(regular.id), "running", "both approved jobs started beside the regular job, under step_parallel 1");
  assert.deepEqual((await detectAutopilot(db, { lanes })).proposals.length, 0, "a PR with a live job of the step gets no second one");
  await runner.stop();
});

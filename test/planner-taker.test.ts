// User-local mode: the planner proposes no Claude job for a repo that no Task Runner takes and says why; a queued job of such
// a repo shows the reason and holds neither a repo of step_parallel nor part of the daily limit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob } = await import("../src/runner/jobs.ts");
const { noRunnerFor, noRunnerForTask, setStepParallel } = await import("../src/runner/concurrency.ts");
const { applyProposals, detectAutopilot, reservedByJobs } = await import("../src/runner/autopilot.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { parseStatus, storeStatus } = await import("../src/remote/helpers.ts");
const { setInferenceMode } = await import("../src/remote/mode.ts");
const { setUserRepos } = await import("../src/remote/my-repos.ts");
const { setUserTasks, taskOfStep, TASK_CHOICES } = await import("../src/remote/my-tasks.ts");

mkdirSync(SCRATCH, { recursive: true });

test("a Task Runner that takes only deckcraft: deckcraft is planned, photocraft waits with a reason and blocks nothing", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-")), "t.db"));
  await setInferenceMode(db, "user-local", "test");
  for (const r of ["deckcraft", "photocraft"]) await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run(r);
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserRepos(db, "olga", ["deckcraft"]);
  await setStepParallel(db, 1, "test");

  const lane = (repos: string[]) => [{ name: "model", steps: ["test-model"], perRepo: true, detect: async () => repos.map((repo) => ({ step: "test-model", params: { repo } })) }];
  const both = await detectAutopilot(db, { lanes: lane(["photocraft", "deckcraft"]) });
  assert.deepEqual(both.proposals.map((p) => p.params.repo), ["deckcraft"]);
  const photo = await detectAutopilot(db, { lanes: lane(["photocraft"]) });
  assert.equal(photo.proposals.length, 0);
  assert.equal(photo.status?.["test-model"], "No Task Runner takes photocraft");

  // An operator queues photocraft anyway: it stays queued with the reason, and neither holds the step nor its limit.
  const queued = await enqueue(db, "test-model", { repo: "photocraft", limit: 5 }, "olga");
  assert.equal((await getJob(db, queued.id)).waiting, "No Task Runner takes photocraft");
  assert.equal(await reservedByJobs(db, "test-model"), 0);
  const found = await detectAutopilot(db, { lanes: lane(["deckcraft"]) });
  const ids = await applyProposals(db, found.proposals, { lanes: lane(["deckcraft"]) });
  assert.equal(ids.length, 1, "step_parallel 1 is not taken by the photocraft job");
  assert.equal((await getJob(db, ids[0]!)).params.repo, "deckcraft");
  assert.equal((await getJob(db, ids[0]!)).waiting, null);
  assert.equal(await reservedByJobs(db, "test-model"), 5, "only the deckcraft job keeps its limit");
});

test("a Task Runner whose user unticked the step's task: nothing is planned, a queued job waits with the task as the reason", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-task-")), "t.db"));
  await setInferenceMode(db, "user-local", "test");
  await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('deckcraft', 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserTasks(db, "olga", TASK_CHOICES.map((t) => t.id).filter((t) => t !== taskOfStep("test-model")));

  const lane = [{ name: "model", steps: ["test-model"], perRepo: true, detect: async () => [{ step: "test-model", params: { repo: "deckcraft" } }] }];
  const found = await detectAutopilot(db, { lanes: lane });
  assert.equal(found.proposals.length, 0);
  assert.equal(found.status?.["test-model"], noRunnerForTask("deckcraft", "test-model"));
  assert.notEqual(noRunnerForTask("deckcraft", "test-model"), noRunnerFor("deckcraft"), "the runner takes the repo: the reason names the task");
  const queued = await enqueue(db, "test-model", { repo: "deckcraft", limit: 5 }, "olga");
  assert.equal((await getJob(db, queued.id)).waiting, noRunnerForTask("deckcraft", "test-model"));
  assert.equal(await reservedByJobs(db, "test-model"), 0);
});

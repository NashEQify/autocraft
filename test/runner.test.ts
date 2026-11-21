// The runner on fake steps: it runs queued jobs in child processes, records
// success, failure and usage, honours cancels, recovers jobs an earlier runner
// left running, runs one job per step and repo at a time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob, jobDetail, requestCancel } = await import("../src/runner/jobs.ts");
const { DEFAULT_MAX_JOBS, Runner } = await import("../src/runner/runner.ts");
const { STEPS } = await import("../src/runner/steps.ts");
const { FAKE_TOKEN } = await import("./runner-steps.ts");
const { inputHash } = await import("../src/runner/classify.ts");
const { RUNNER_STOPPED } = await import("../src/runner/jobs.ts");
const { setInferenceMode } = await import("../src/remote/mode.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { claimCall, submitCall } = await import("../src/remote/calls.ts");
const { PROTOCOL_VERSION } = await import("../src/remote/protocol.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-test-"));
const dbFile = join(dir, "runner.db");
const db = await connectDb(dbFile);
await db.script("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
const runner = new Runner({ db, dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });

after(async () => {
  await runner.stop();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = async (id: number) => (await getJob(db, id)).state;

describe("runner", () => {
  test("runs a queued job and records its summary, usage and a scrubbed log; a failing job is failed", async () => {
    const ok = await enqueue(db, "test-echo", { n: 7 }, "boss");
    const bad = await enqueue(db, "test-echo", { mode: "fail" }, "boss");
    await until(async () => await state(ok.id) === "done" && await state(bad.id) === "failed");
    const j = await jobDetail(db, ok.id);
    assert.equal(j.summary, "echo 7");
    assert.deepEqual(j.usage, { calls: 1, input: 100, output: 10, costUsd: 0.01 });
    assert.ok(j.startedAt && j.endedAt);
    assert.ok(j.log!.includes("token in the log: [hidden]"), j.log!);
    assert.ok(!j.log!.includes(FAKE_TOKEN));
    assert.equal((await getJob(db, bad.id)).error, "echo failed on purpose");
  });

  test("a job stopped by a runner stop resumes under the same id and reads the reply its Task Runner sent meanwhile", async () => {
    await setInferenceMode(db, "user-local", "test");
    await db.prepare("INSERT INTO access (login, role) VALUES ('bob', 'maintainer')").run();
    const bob = { tokenId: (await createToken(db, "bob", "helper", { kind: "runner" })).row.id, login: "bob", role: "maintainer" as const };
    const opts = { db, dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} };
    const first = new Runner(opts);
    const job = await enqueue(db, "test-remote", {}, "boss");
    const callOf = async () => await db.prepare("SELECT id, state, run_id FROM remote_calls WHERE job_id = ?").all(job.id) as { id: number; state: string; run_id: number | null }[];
    let lease = null;
    for (let i = 0; i < 400 && !lease; i++) {
      await first.tick();
      if ((await callOf()).length) lease = (await claimCall(db, bob, { requestId: `resume-${i}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true)).lease;
      if (!lease) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(lease, "the job's call was leased");
    await first.stop();
    const stopped = await getJob(db, job.id);
    assert.equal(stopped.state, "queued", "the stop queued the job to resume");
    assert.equal((await callOf())[0]!.state, "leased", "the call stays with its Task Runner");
    // The Task Runner answers while no runner runs the job.
    assert.deepEqual(await submitCall(db, lease.secret, { ok: true, text: "the review", model: "claude-opus-4-5", usage: { inputTokens: 10, outputTokens: 2 } }), { accepted: true });

    const second = new Runner(opts);
    try {
      await second.recover();
      for (let i = 0; i < 400 && !["done", "failed"].includes(await state(job.id)); i++) {
        await second.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await second.stop();
    }
    const j = await jobDetail(db, job.id);
    assert.equal(j.state, "done", j.error ?? j.log ?? "");
    assert.equal(j.summary, "reply: the review");
    const calls = await callOf();
    assert.equal(calls.length, 1, "the resumed run adopted the call instead of asking again");
    assert.equal((await db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(calls[0]!.run_id) as { state: string }).state, "done");
    assert.ok(j.log!.includes("resume 1 of 2"), j.log!);

    // A job left running by a runner that is gone resumes too, until it has resumed twice.
    const left = Number((await db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, resumes) VALUES ('test-echo', '{}', 'boss', ?, 'running', ?, 1) RETURNING id").get(new Date().toISOString(), new Date().toISOString()) as { id: number }).id);
    await second.recover();
    assert.equal((await getJob(db, left)).state, "queued");
    await db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(left);
    await second.recover();
    assert.equal((await getJob(db, left)).error, RUNNER_STOPPED);
  });






});

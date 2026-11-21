// The runner on fake steps: it runs queued jobs in child processes, records
// success, failure and usage, honours cancels, recovers jobs an earlier runner
// left running, runs one job per step and repo at a time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
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

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-test-"));
const dbFile = join(dir, "runner.db");
const db = await connectDb(dbFile);
await db.script("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
const runner = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });

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

  test("with AUTOCRAFT_DB_URL set, a job process opens that Postgres database, not a SQLite file", async () => {
    // A stand-in server that records the startup packet a Postgres client sends first (it names the database), then hangs up.
    const seen: Buffer[] = [];
    const server = createServer((s) => s.on("data", (b: Buffer) => { seen.push(b); s.destroy(); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const saved = { url: process.env.AUTOCRAFT_DB_URL, db: process.env.AUTOCRAFT_DB };
    const pgDir = mkdtempSync(join(dir, "pg-"));
    const pgDb = await connectDb(join(pgDir, "jobs.db"));
    process.env.AUTOCRAFT_DB_URL = `postgres://autocraft@127.0.0.1:${port}/childjob`;
    delete process.env.AUTOCRAFT_DB;
    const pgRunner = new Runner({ db: pgDb, logs: join(pgDir, "logs"), killAfterMs: 2000, log: () => {}, detect: async () => ({ proposals: [], logs: [] }), refreshFlow: async () => undefined });
    try {
      const job = await enqueue(pgDb, "test-echo", { n: 1 }, "boss");
      const end = Date.now() + 20_000;
      while (!Buffer.concat(seen).includes("database\0childjob\0")) {
        if (Date.now() > end) throw new Error(`the job process did not connect; job ${job.id} is ${(await getJob(pgDb, job.id)).state}`);
        await pgRunner.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await pgRunner.stop();
      await pgDb.close();
      await new Promise((r) => server.close(r));
      for (const [k, v] of [["AUTOCRAFT_DB_URL", saved.url], ["AUTOCRAFT_DB", saved.db]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

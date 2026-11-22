// The model-call queue: a higher class takes a freed slot first and stale waiters do not block.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { allocation, setCallContext, startClaudeRun } from "../src/agents/call.ts";
import { finishRun } from "../src/agents/runs.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

after(() => setCallContext(null));
allocation.pollMs = 5000; // the in-process wake must be what hands over the slot

const claude = { promptId: "review.opus", promptVersion: "1", provider: "claude" as const, model: "m", items: [], prompt: "p" };
const quiet = () => {};
const ctx = (cls: 0 | 1 | 2) => setCallContext({ jobId: 1, step: "s", stage: 1, class: cls, cancelled: async () => false });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fresh(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `call-queue-${name}-${process.pid}.db`));
  await useTestAccount(db);
  await db.run(db.k.updateTable("claude_accounts").set({ max_concurrent: 1 }).where("id", "=", "t"));
  return db;
}

test("a security waiter takes a freed slot before an older class 0 waiter, and a stale waiter does not block", async () => {
  const db = await fresh("claude");
  ctx(0);
  const first = await startClaudeRun(db, claude, quiet);
  let order: string[] = [];
  const low = startClaudeRun(db, claude, quiet).then((r) => (order.push("low"), r));
  await tick(20);
  ctx(2);
  const high = startClaudeRun(db, claude, quiet).then((r) => (order.push("high"), r));
  // A stale eligible class 2 waiter that nobody polls.
  await db.run(db.k.insertInto("model_waits").values({ provider: "claude", class: 2, step: "x", since: 1, seen_at: Date.now() - 120_000, eligible: 1 }));
  await tick(20);
  await finishRun(db, first.runId, { state: "done" });
  const t0 = Date.now();
  const h = await high;
  assert.ok(Date.now() - t0 < 1000, "the wake hands over the slot without waiting for the poll");
  assert.deepEqual(order, ["high"]);
  await finishRun(db, h.runId, { state: "done" });
  await low;
  assert.deepEqual(order, ["high", "low"]);
  assert.equal((await db.get(db.k.selectFrom("model_waits").select((eb) => eb.fn.countAll<number>().as("n")).where("seen_at", ">", Date.now() - 60_000)))!.n, 0);
});

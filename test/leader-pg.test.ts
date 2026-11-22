// Leader election on Postgres (src/db/leader.ts): one copy leads, a standby takes over when the leader's lock connection
// dies, and the old leader's writes are fenced. Runs only against a server (AUTOCRAFT_TEST_PG_URL; scripts/pg-test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { elect, type Lease } from "../src/db/leader.ts";
import { isFenced, setFence } from "../src/db/fence.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const FAST = { retryMs: 100, checkMs: 100, checkTimeoutMs: 1_000, beatMs: 200, log: () => {} };

test("a standby takes over when the leader's connection dies; the old leader stops and its writes are refused", { skip: needsPg }, async () => {
  const t = await testDatabase("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  const stop = new AbortController();
  try {
    const [dbA, dbB, admin] = [await t.open(), await t.open(), await t.open()];
    const a = (await elect(dbA, "runner", { ...FAST, url: t.target, holder: "a" }))!;
    let standby = false;
    let b: Lease | null = null;
    const bWon = elect(dbB, "runner", { ...FAST, url: t.target, holder: "b", signal: stop.signal, onStandby: () => (standby = true) }).then((l) => (b = l));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(standby && !b, "the second copy waits while the first leads");

    const lostAt = new Promise<number>((r) => a.lost.addEventListener("abort", () => r(Date.now()), { once: true }));
    const killedAt = Date.now();
    await admin.prepare("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 1633905778 AND granted").all();
    const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not within ${ms} ms`)), ms));
    await Promise.race([bWon, timeout(5_000)]);
    const leaseB = b as Lease | null;
    assert.ok(leaseB && leaseB.epoch > a.epoch, "the standby leads under a later epoch");
    assert.ok(await Promise.race([lostAt, timeout(2_000)]) >= killedAt, "the old leader learns that it lost the lock");

    // A write fenced to the old epoch fails; the new leader's goes through.
    setFence({ role: "runner", epoch: a.epoch });
    await assert.rejects(dbA.prepare("INSERT INTO settings (key, value) VALUES ('x', 'a')").run(), (e) => isFenced(e));
    setFence({ role: "runner", epoch: leaseB.epoch });
    await dbB.prepare("INSERT INTO settings (key, value) VALUES ('x', 'b')").run();
    setFence(null);
    assert.equal((await admin.prepare("SELECT value FROM settings WHERE key = 'x'").get() as { value: string }).value, "b");
    await leaseB.release();
  } finally {
    setFence(null);
    stop.abort();
    await t.close();
  }
});

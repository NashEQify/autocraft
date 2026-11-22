// Leader election on Postgres (src/db/leader.ts): a leader rides out a dropped lock connection, a standby takes over
// when another session holds the lock, the old leader's writes are fenced, and a transaction left idle by a client that
// stopped talking no longer holds the writer lock. Runs only against a server (AUTOCRAFT_TEST_PG_URL; scripts/pg-test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { elect, type Lease } from "../src/db/leader.ts";
import { isFenced, setFence } from "../src/db/fence.ts";
import { loadPg } from "../src/db/open.ts";
import type { Db } from "../src/db/index.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const FAST = { retryMs: 100, checkMs: 100, lossMs: 1_500, beatMs: 200, log: () => {} };
const SETTINGS = "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)";
const RUNNER_KEY = 1633905778;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not within ${ms} ms`)), ms));
const holderPid = async (admin: Db): Promise<number | undefined> =>
  (await admin.prepare(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${RUNNER_KEY} AND granted`).get() as { pid: number } | undefined)?.pid;

test("a leader whose lock connection drops takes the lock again and keeps leading", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  try {
    const [db, admin] = [await t.open(), await t.open()];
    const a = (await elect(db, "runner", { ...FAST, url: t.target, holder: "a" }))!;
    const before = await holderPid(admin);
    await admin.prepare(`SELECT pg_terminate_backend(${before})`).all();
    await sleep(1_000);
    const after = await holderPid(admin);
    assert.ok(after !== undefined && after !== before, "the lock is held again, on a new connection");
    await sleep(1_000);
    assert.ok(!a.lost.aborted, "the drop alone is not a loss");
    setFence({ role: "runner", epoch: a.epoch });
    await db.prepare("INSERT INTO settings (key, value) VALUES ('x', 'a')").run();
    await a.release();
  } finally {
    setFence(null);
    await t.close();
  }
});

test("when another session holds the lock, the old leader stops and its writes are refused; the standby then leads", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  const stop = new AbortController();
  const pg = await loadPg();
  const other = new pg.Client({ connectionString: t.target });
  try {
    const [dbA, dbB, admin] = [await t.open(), await t.open(), await t.open()];
    const a = (await elect(dbA, "runner", { ...FAST, url: t.target, holder: "a" }))!;
    let standby = false;
    let b: Lease | null = null;
    const bWon = elect(dbB, "runner", { ...FAST, url: t.target, holder: "b", signal: stop.signal, onStandby: () => (standby = true) }).then((l) => (b = l));
    await sleep(500);
    assert.ok(standby && !b, "the second copy waits while the first leads");

    // Another session takes the lock the moment the leader's session ends, before either copy can.
    await other.connect();
    const lostAt = new Promise<void>((r) => a.lost.addEventListener("abort", () => r(), { once: true }));
    await other.query(`SELECT pg_terminate_backend(${await holderPid(admin)})`);
    await other.query(`SELECT pg_advisory_lock(${RUNNER_KEY})`);
    await Promise.race([lostAt, timeout(3_000)]);
    await other.end();

    await Promise.race([bWon, timeout(3_000)]);
    const leaseB = b as Lease | null;
    assert.ok(leaseB && leaseB.epoch > a.epoch, "the standby leads under a later epoch");
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
    await other.end().catch(() => undefined);
    await t.close();
  }
});

test("a write transaction left idle no longer holds the writer lock once the server ends it", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  try {
    const [a, b] = [await t.open({ idleInTransactionMs: 300 }), await t.open()];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stuck = a.write(async () => {
      await a.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
      await held;
    }).catch((e: unknown) => e);
    await sleep(100);
    const t0 = Date.now();
    await b.write(() => b.prepare("INSERT INTO settings (key, value) VALUES ('b', '1')").run(), { lockTimeoutMs: 5_000 });
    assert.ok(Date.now() - t0 < 3_000, "the waiting writer got the lock well before its limit");
    release();
    assert.ok(await stuck instanceof Error, "the idle transaction was ended, not committed");
    assert.equal(await b.prepare("SELECT value FROM settings WHERE key = 'a'").get(), undefined);
  } finally {
    await t.close();
  }
});

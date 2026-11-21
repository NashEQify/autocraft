// The Db handle on Postgres: transaction semantics, the writer lock, parameter rewriting and value shapes. Runs only
// against a server (AUTOCRAFT_TEST_PG_URL; `pnpm test:pg` starts one) and is skipped with the reason otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countQueries } from "../src/db/counter.ts";
import { isLockTimeout } from "../src/db/errors.ts";
import type { Db } from "../src/db/index.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const SCHEMA = "CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT, b BYTEA)";
const count = async (db: Db): Promise<number> => ((await db.prepare("SELECT count(*) AS c FROM t").get()) as { c: number }).c;

test("a read is one snapshot that refuses writes", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    await a.read(async () => {
      assert.equal(await count(a), 0);
      await b.prepare("INSERT INTO t (v) VALUES ('other')").run();
      assert.equal(await count(a), 0, "a commit after the snapshot began is not visible in it");
    });
    assert.equal(await count(a), 1);
    // A failed statement aborts a Postgres transaction, so the refusal ends the read.
    await assert.rejects(a.read(() => a.prepare("INSERT INTO t (v) VALUES ('mine')").run()), { code: "25006" });
    assert.equal(await count(a), 1);
  } finally {
    await t.close();
  }
});

test("writes take the one writer lock: a second writer waits for the commit, and a short wait fails as a lock timeout", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    let waiter: Promise<number> | undefined;
    let failure: unknown;
    await a.write(async () => {
      await a.prepare("INSERT INTO t (v) VALUES ('a')").run();
      failure = await b.write(async () => undefined, { lockTimeoutMs: 100 }).catch((e: unknown) => e);
      // This one waits for a's commit, then sees a's row: writes run one after another, each seeing the last.
      waiter = b.write(() => count(b));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await count(b), 0, "readers are not blocked and do not see the open write");
    });
    assert.ok(isLockTimeout(failure), String(failure));
    assert.equal(await waiter, 1);
    // The handle that timed out still works: its transaction was rolled back, not left open on a pooled connection.
    await b.write(() => b.prepare("INSERT INTO t (v) VALUES ('b')").run());
    assert.equal(await count(a), 2);
  } finally {
    await t.close();
  }
});

test("a nested write joins the outer one on its connection and rolls back with it", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    await assert.rejects(
      a.write(async () => {
        await a.prepare("INSERT INTO t (v) VALUES ('outer')").run();
        await a.write(async () => {
          assert.ok(a.inTransaction());
          await a.run(a.k.insertInto("t").values({ v: "inner" }));
        });
        // Calls in parallel inside the transaction all run in it.
        const seen = await Promise.all([count(a), count(a), a.read(() => count(a))]);
        assert.deepEqual(seen, [2, 2, 2]);
        assert.equal(await count(b), 0);
        throw new Error("abort");
      }),
      /abort/,
    );
    assert.equal(a.inTransaction(), false);
    assert.equal(await count(a), 0);
  } finally {
    await t.close();
  }
});

test("? and :name placeholders become $n by node:sqlite's binding rules, outside literals and casts", { skip: needsPg }, async () => {
  const t = await testDatabase();
  try {
    const db = await t.open();
    const row = await db.prepare("SELECT ? AS a, :x AS b, '?:y' AS lit, ? AS c, ?::int AS n, :x AS again").get({ x: "X" }, "A", "C", "7");
    assert.deepEqual(row, { a: "A", b: "X", lit: "?:y", c: "C", n: 7, again: "X" });
    await assert.rejects(db.prepare("SELECT ? AS a").get("1", "2"), /Too many parameters/);
  } finally {
    await t.close();
  }
});

test("values come back in node:sqlite's shapes, and run results have no insert id", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const db = await t.open();
    const r = await db.prepare("INSERT INTO t (v, b) VALUES (?, ?), (?, ?)").run("x", new Uint8Array([1, 2]), "y", null);
    assert.equal(r.changes, 2);
    assert.throws(() => r.lastInsertRowid, /RETURNING/);
    const row = await db.prepare("SELECT count(*) AS big, sum(id)::numeric / 2 AS num, bool_or(v = 'x') AS yes, bool_and(v = 'x') AS no, (SELECT b FROM t WHERE v = 'x') AS bin FROM t").get() as Record<string, unknown>;
    assert.equal(typeof row.big, "number");
    assert.equal(typeof row.num, "number");
    assert.deepEqual([row.yes, row.no], [1, 0]);
    assert.equal(Object.getPrototypeOf(row.bin), Uint8Array.prototype);
    assert.deepEqual(row.bin, new Uint8Array([1, 2]));
  } finally {
    await t.close();
  }
});

test("the counter sees round trips, rows and write-lock time on Postgres", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const db = await t.open();
    const { counts, stop } = countQueries(db);
    await db.write(async () => {
      await db.prepare("INSERT INTO t (v) VALUES ('a'), ('b')").run();
      await db.prepare("SELECT v FROM t").all();
    });
    stop();
    // BEGIN with the lock, two statements, COMMIT.
    assert.ok(counts.roundTrips >= 4, String(counts.roundTrips));
    assert.ok(counts.rows >= 2);
    assert.ok(counts.maxWriteLockMs > 0);
    assert.ok([...counts.sites.keys()].some((s) => s.includes("pg-db.test.ts")), [...counts.sites.keys()].join("\n"));
  } finally {
    await t.close();
  }
});

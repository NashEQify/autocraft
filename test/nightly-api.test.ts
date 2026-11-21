import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grid, select, series } from "../src/dash/api/nightly.ts";
import { setFeature } from "../src/build/features.ts";
import { TOPICS } from "../src/live.ts";
import { INPUT_TOPICS } from "../src/runner/autopilot.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });

const req = (json: unknown, params: Record<string, string> = {}): Req =>
  ({ params, query: new URLSearchParams(), json, user: { login: "op", role: "operator", canRead: async () => true } }) as unknown as Req;

test("selection validates names, hidden repos are 404, the grid shows a bench delta, and the topic is not planner input", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "nq-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: "2026-01-01T00:00:00Z", pipeline: 1 }));
  await setFeature(db, "nightly", true, "op");
  await setFeature(db, "nightly", true, "op", "app");

  await assert.rejects(select(db, req({ repo: "app", check: "miri", enabled: true, crates: ["ok", "a b; rm"] })), /crates must be/);
  await assert.rejects(select(db, req({ repo: "app", check: "nope", enabled: true })), /check must be/);
  await assert.rejects(select(db, req({ repo: "other", check: "miri", enabled: true })), /no such repo/);
  const g = await select(db, req({ repo: "app", check: "miri", enabled: true, crates: ["core", "core", "ffi"] }));
  assert.deepEqual(g.repos[0]!.checks.find((c) => c.id === "miri"), { id: "miri", label: "Miri", enabled: true, experimental: false, needs: null, takes: "crates", crates: ["core", "ffi"], targets: [], cells: [] });

  for (let i = 0; i < 8; i++) await db.run(db.k.insertInto("nightly_bench").values({ repo: "app", bench: "parse", sha: `s${i}`, at: `2026-01-0${i + 1}T00:00:00Z`, value: i < 7 ? 100 : 120, unit: "ns/iter" }));
  assert.equal((await grid(db, req({}))).repos[0]!.benches[0]!.deltaPct, 20);
  assert.equal((await series(db, req({}, { repo: "app", bench: "parse" }))).points.length, 8);

  assert.ok(TOPICS.includes("nightly") && !INPUT_TOPICS.includes("nightly"));
});

// A post-merge defect on a test repo holds merges on that repo only; on any other repo it stops merging everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTrips, mergeDefect, resumeStage } from "../src/push-outcomes.ts";
import { connectDb } from "../src/db/open.ts";

test("a test repo's post-merge defect trips its own merge breaker, not the pipeline's", async () => {
  const db = await connectDb(":memory:");
  const merged = async (repo: string) => await db.run(db.k.insertInto("merges").values({ repo, number: 1, head_oid: "h", run_id: "m", at: "2026-01-01T00:00:00Z", path: "operator", method: "squash", outcome: "merged" }));
  await merged("sandbox");
  await merged("real");
  await db.run(db.k.insertInto("settings").values({ key: "test_repo:sandbox", value: "1" }));
  await mergeDefect(db, "sandbox", 1, 1, "2026-01-01T00:10:00Z");
  assert.deepEqual(Object.keys(await activeTrips(db)), ["merge:sandbox"]);
  await resumeStage(db, "merge:sandbox", "op");
  await mergeDefect(db, "real", 1, 1, "2026-01-01T00:20:00Z");
  assert.deepEqual(Object.keys(await activeTrips(db)), ["merge"]);
});

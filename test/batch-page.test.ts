// The batch page: member states and the timeline come from the batch tables and the audit log; who acted is staff-only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchDetail } from "../src/dash/api/batch-page.ts";
import { world } from "./world-db.ts";

const T = (m: number) => `2026-01-02T00:${String(m).padStart(2, "0")}:00Z`;

test("a removed PR shows as removed with its reason in the batch history, and the actor only to staff", async () => {
  const db = (await (await (await (await world()).repo(["comment"])).pr(1)).pr(2)).db;
  await db.run(db.k.insertInto("merge_batches").values({ id: 7, repo: "app", branch: "integration-app-1", state: "superseded", base_sha: "basesha1", commit_sha: "tip", pr_number: 900, summary: "app#2 was removed by an operator", created_at: T(0), updated_at: T(9) }));
  await db.run(db.k.insertInto("merge_batch_prs").values([
    { batch_id: 7, number: 1, head_oid: "sha1", position: 0 },
    { batch_id: 7, number: 2, head_oid: "sha2", position: 1 },
  ]));
  await db.run(db.k.insertInto("audit").values([
    { at: T(2), login: "bot", action: "batch-pr", target: "app:integration-app-1", details: "{}" },
    { at: T(8), login: "op", action: "batch-remove", target: "app#2", details: JSON.stringify({ batch: "integration-app-1" }) },
  ]));
  const staff = await batchDetail(db, 7, true);
  assert.deepEqual(staff.members.map((m) => [m.number, m.state]), [[1, "in"], [2, "removed"]]);
  assert.equal(staff.members[1]!.reason, "removed by an operator");
  assert.deepEqual(staff.events.map((e) => e.kind), ["opened", "pr", "removed", "superseded"]);
  assert.equal(staff.events[2]!.by, "op");
  assert.equal((await batchDetail(db, 7, false)).events[2]!.by, null);
});

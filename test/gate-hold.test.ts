import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gates } from "../src/core/gates.ts";
import { execOf } from "../src/dash/api/decisions.ts";
import { getDecision } from "../src/decisions.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });

test("an answered decision whose act a gate refuses shows the reason, with the repo link for operators only", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "gate-hold-")), "t.db"));
  const f = { repo: "sandbox", pipelineOn: true, repoFacts: { commentApproved: false } } as never;
  const why = gates(f, { kind: "act", bucket: "scope" }, "pipeline");
  assert.equal(why, "Comments in sandbox are not approved");
  const items = [{ repo: "sandbox", number: 1, kind: "issue", action: "act", bucket: "scope", fast: false, rank: null, inFlight: false, next: false, blocked: why }];
  await db.run(db.k.insertInto("lane_next").values({ lane: "act", total: 1, items: JSON.stringify(items), at: "t" }));
  await db.run(db.k.insertInto("decisions").values({ id: "sandbox#1:scope", kind: "scope", repo: "sandbox", number: 1, question: "q", options: "[]", asked_at: "t", answer: "close", answered_by: "op", answered_at: "t", exec_state: "pending" }));
  const d = (await getDecision(db, "sandbox#1:scope"))!;
  const viewer = (operator: boolean) => ({ login: "x", role: operator ? "operator" : "viewer", operator, staff: operator });
  assert.deepEqual(await execOf(db, d, "sandbox", viewer(true)), { state: "pending", reason: "Comments in sandbox are not approved", approvalsRepo: "sandbox" });
  assert.deepEqual(await execOf(db, d, "sandbox", viewer(false)), { state: "pending", reason: "Comments in sandbox are not approved" });
});

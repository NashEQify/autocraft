import assert from "node:assert/strict";
import { test } from "node:test";
import { labelsApproval } from "../src/dash/api/admin.ts";
import { cancel } from "../src/dash/api/pipeline.ts";
import { actOnFinding, continueScan, startScan } from "../src/dash/api/security.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";

// A maintainer who writes to `alpha` (and no other repo).
const as = (login: string, role: "viewer" | "maintainer" | "operator", json: unknown = {}, params: Record<string, string> = {}): Req => ({
  method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), json,
  user: { login, role, canWrite: async (repo: string) => repo === "alpha", canRead: async () => true }, csrf: "", nonce: "",
});

test("a maintainer with write runs their repo's approvals, findings and jobs; others are refused; scans and repo-less jobs stay operator", async () => {
  const db = await connectDb(":memory:");
  for (const name of ["alpha", "beta"]) {
    await db.run(db.k.insertInto("tracked_repos").values({ name }));
    await db.run(db.k.insertInto("repos").values({ name, visibility: "public" }));
  }
  const at = "2026-11-05T00:00:00Z";
  await db.run(db.k.insertInto("security_findings").values({
    repo: "alpha", number: 1, scan_id: 1, area: "psd", title: "Layer length trusted", severity: "high", urgent: 0, state: "new", refs: "[]",
    reach: "open file", impact: "writes outside", fingerprint: "fp1", created_at: at, updated_at: at,
  }));
  const job = async (repo: string | null) => (await db.get(db.k.insertInto("jobs").values({ step: "sync", params: "{}", repo, requested_by: "op", requested_at: at, state: "queued" }).returning("id")))!.id;

  // Approvals: write on the repo, not on another.
  assert.equal((await labelsApproval(db, as("maint", "maintainer", { name: "alpha" }), true)).labels?.approved, true);
  await assert.rejects(labelsApproval(db, as("maint", "maintainer", { name: "beta" }), true), { status: 403 });
  await assert.rejects(labelsApproval(db, as("view", "viewer", { name: "alpha" }), false), { status: 403 });

  // Findings: dismiss on the repo; refused elsewhere.
  const dismiss = (r: Req) => actOnFinding(db, r);
  const f = as("maint", "maintainer", { action: "dismiss", reason: "not reachable" }, { repo: "alpha", n: "1" });
  assert.equal((await dismiss(f)).state, "dismissed");
  await assert.rejects(dismiss(as("view", "viewer", { action: "reopen" }, { repo: "alpha", n: "1" })), (e: { status: number }) => e.status === 403 || e.status === 404);
  await assert.rejects(dismiss(as("maint", "maintainer", { action: "reopen" }, { repo: "beta", n: "1" })), (e: { status: number }) => e.status === 403 || e.status === 404);

  // Advisory and publish open or publish an advisory: operator only.
  for (const action of ["advisory", "publish"]) await assert.rejects(dismiss(as("maint", "maintainer", { action }, { repo: "alpha", n: "1" })), { status: 403 });

  // Continuing a capped scan: a maintainer only with a cap, not above the scan's own.
  await db.run(db.k.insertInto("security_scans").values({ id: 1, repo: "alpha", state: "capped", cap_usd: 10, cost_usd: 5, started_by: "op", started_at: at }));
  const cont = (cap: number | null) => continueScan(db, as("maint", "maintainer", { cap }, { id: "1" }));
  await assert.rejects(cont(null), { status: 403 });
  await assert.rejects(cont(20), { status: 403 });
  assert.notEqual((await cont(8)).state, "capped");

  // Starting a scan spends money: operator only.
  await assert.rejects(startScan(db, as("maint", "maintainer", {}, { repo: "alpha" })), { status: 403 });

  // Jobs: the maintainer cancels a job of their repo, not another repo's, not a repo-less one.
  const own = await job("alpha");
  assert.equal((await cancel(db, as("maint", "maintainer", {}, { id: String(own) }))).id, own);
  await assert.rejects(cancel(db, as("maint", "maintainer", {}, { id: String(await job("beta")) })), { status: 403 });
  assert.equal((await cancel(db, as("maint", "maintainer", {}, { id: String(await job("(security):alpha")) }))).state, "cancelled");
  await assert.rejects(cancel(db, as("maint", "maintainer", {}, { id: String(await job("(security):beta")) })), { status: 403 });
  await assert.rejects(cancel(db, as("maint", "maintainer", {}, { id: String(await job(null)) })), { status: 403 });
  await assert.rejects(cancel(db, as("view", "viewer", {}, { id: String(own) })), { status: 403 });
});

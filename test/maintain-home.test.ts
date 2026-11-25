// The new Home's needs-an-answer list (src/dash/api/maintain.ts): only repos where the reader may act.
import assert from "node:assert/strict";
import { test } from "node:test";
import { home, items, repos, waiting } from "../src/dash/api/maintain.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { addEvent, insertWorkflow } from "../src/workflow/store.ts";

const T = "2026-11-01T00:00:00.000Z";
const as = (role: string, writable: string[]) => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "u1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

test("needs an answer counts only repos where the reader may act", async () => {
  const db = await connectDb(":memory:");
  for (const name of ["app", "lib"]) {
    await db.run(db.k.insertInto("repos").values({ name, visibility: "public" }));
    await db.run(db.k.insertInto("tracked_repos").values({ name, added_by: "op", added_at: T, pipeline: 1 }));
  }
  const rec = { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true };
  const wf = { kind: "pr" as const, entry: "review" as const, startedBy: "m2", startedAt: T, startedVia: "github" as const };
  await insertWorkflow(db, { ...wf, repo: "app", number: 1, state: "recommending", rec });
  await insertWorkflow(db, { ...wf, repo: "lib", number: 2, state: "recommending", rec });
  // An unclear answer on a running item waits for a person too.
  const running = await insertWorkflow(db, { ...wf, repo: "app", number: 3, state: "running" });
  await addEvent(db, { workflowId: running, repo: "app", number: 3, login: "m2", via: "github", kind: "ambiguous" });
  await insertWorkflow(db, { ...wf, repo: "app", number: 4, state: "running" });

  const refs = (rows: { repo: string; number: number }[]) => rows.map((r) => `${r.repo}#${r.number}`).sort();
  assert.deepEqual(refs((await home(db, as("maintainer", ["app"]))).needs), ["app#1", "app#3"]);
  assert.deepEqual(refs((await home(db, as("maintainer", []))).needs), []);
  assert.deepEqual(refs((await home(db, as("operator", []))).needs), ["app#1", "app#3", "lib#2"]);
  const viewer = await home(db, as("viewer", ["app", "lib"]));
  assert.deepEqual(refs(viewer.needs), []);
  assert.deepEqual(refs(viewer.waiting), ["app#1", "app#3", "lib#2"]);
});

test("an item stopped at a blocker shows its recommendation and needs an answer in every list and count; viewers read none of a quiet pull request", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T, pipeline: 1 }));
  for (const number of [1, 2]) {
    await db.run(db.k.insertInto("main.items").values({ repo: "app", number, kind: "pr", state: "OPEN", title: "Fix", body: "", head_oid: "h", author: "a", created_at: T, updated_at: T }));
    await insertWorkflow(db, {
      repo: "app", number, kind: "pr", entry: "merge", state: "blocked", startedBy: "m2", startedAt: T, startedVia: "github", approvedBy: "m2", approvedAt: T, approvedVia: "github", blocker: "other",
      rec: { text: "Merge past the stop.", parts: { fix: [], drop: [] }, merges: true },
    });
  }
  await db.run(db.k.insertInto("security_scans").values({ id: 7, repo: "app", state: "done", started_by: "boss", started_at: T }));
  await db.run(db.k.insertInto("security_findings").values({
    repo: "app", number: 7, scan_id: 7, area: "a", title: "Path escape", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp7", fix_pr: 2, created_at: T, updated_at: T,
  }));
  const shown = (rows: { number: number; line: string | null }[]) => rows.map((r) => [r.number, r.line?.startsWith("Merge past the stop. Reply yes") ?? false]).sort();

  const m = as("maintainer", ["app"]), v = as("viewer", []);
  assert.deepEqual(shown((await home(db, m)).needs), [[1, true], [2, true]]);
  const list = await items(db, m);
  assert.deepEqual([shown(list.rows.filter((r) => r.group === "needs")), list.counts.needs], [[[1, true], [2, true]], 2]);
  assert.deepEqual([await waiting(db, m), (await repos(db, m))[0]!.waiting], [{ app: 2 }, 2]);
  assert.deepEqual(shown((await home(db, v)).waiting), [[1, true], [2, false]]);
  assert.deepEqual(shown((await items(db, v)).rows), [[1, true], [2, false]]);
});

test("a close that was not made is a problem for those who act on the repo, until someone takes the item up again", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T, pipeline: 1 }));
  for (const number of [1, 2]) await db.run(db.k.insertInto("items").values({ repo: "app", number, kind: "issue", state: "OPEN", title: `t${number}`, created_at: T }));
  const wf = { repo: "app", kind: "issue" as const, entry: "review" as const, startedBy: "m2", startedAt: T, startedVia: "github" as const };
  const close = async (number: number, state: string) => {
    const workflow_id = await insertWorkflow(db, { ...wf, number, state: "closed" });
    await db.run(db.k.insertInto("workflow_actions").values({ workflow_id, repo: "app", number, kind: "close", by: "m2", state, reason: "GitHub refused", created_at: T, updated_at: T }));
  };
  await close(1, "failed");
  await close(2, "done");
  const listed = async (role: string, writable: string[]) => (await home(db, as(role, writable))).attention.filter((p) => p.kind === "gave-up").map((p) => [p.title, p.detail]);
  assert.deepEqual(await listed("maintainer", ["app"]), [["app#1: not closed", "GitHub refused"]]);
  assert.deepEqual(await listed("maintainer", []), []);
  await insertWorkflow(db, { ...wf, number: 1, state: "running" });
  assert.deepEqual(await listed("maintainer", ["app"]), []);
});

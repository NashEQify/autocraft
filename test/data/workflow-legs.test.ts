// workflow module, part a: legs, fix-up requests, merge approvals and holds as read by the planner and the merge queue (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { adoptLegs, listWorkflowLegs, loadFixupRequests, loadHolds, loadLandedApprovals, loadLegPass, loadLegs, loadPrWorkflows, recordEvents, saveWorkflows, startWorkflows } from "../../src/data/workflow/index.ts";
import { AT, both, openApp, seedPrs } from "./planner-helpers.ts";

const wf = (repo: string, number: number, o: Record<string, unknown> = {}) => ({ repo, number, kind: "pr" as const, entry: "review" as const, weight: 5, startedBy: "ann", startedVia: "cli" as const, at: AT, ...o });

/** `n` PRs of o/a, each with a live workflow (even numbers approved) and an active leg; PR 1's leg is not linked to a workflow. */
async function seed(db: Db, n: number): Promise<Map<string, number>> {
  const q = queryDb(db);
  const k = q.k as any;
  await seedPrs(db, ["o/a"], n);
  const ids = await startWorkflows(db, Array.from({ length: n }, (_, i) => wf("o/a", i + 1, i % 2 ? { approvedBy: "ann", approvedVia: "cli" } : {})));
  await q.run(k.insertInto("main.preapprovals").values(Array.from({ length: n }, (_, i) => ({
    repo: "o/a", number: i + 1, by: "ann", at: AT, instructions: "", state: i % 2 ? "queued" : "review", from_head: `h${i + 1}`, head: `h${i + 1}`, updated_at: AT, workflow_id: i === 0 ? null : ids.get(`o/a#${i + 1}`)!,
  }))));
  return ids;
}

both("loadLegs: oldest first, active only, latest only; loadLegPass reads each leg's workflow and the go-on time", async ({ db }) => {
  const q = queryDb(db);
  const k = q.k as any;
  const ids = await seed(db, 3);
  // An older, cancelled leg of PR 2.
  await q.run(k.insertInto("main.preapprovals").values({ repo: "o/a", number: 2, by: "ann", at: AT, instructions: "", state: "cancelled", from_head: "old", updated_at: AT, workflow_id: ids.get("o/a#2")! }));
  const keys = [1, 2, 3].map((number) => ({ repo: "o/a", number }));
  assert.deepEqual((await loadLegs(db, keys)).get("o/a#2")!.map((p) => p.state).sort(), ["cancelled", "queued"]);
  assert.deepEqual((await loadLegs(db, keys, { activeOnly: true })).get("o/a#2")!.map((p) => p.state), ["queued"]);
  assert.equal((await loadLegs(db, keys, { latestOnly: true })).get("o/a#2")!.length, 1);
  assert.equal((await loadLegs(db, [], {})).size, 0);
  await recordEvents(db, [{ workflowId: ids.get("o/a#2")!, repo: "o/a", number: 2, login: "bob", kind: "answered", via: "cli", at: "2026-03-01T00:00:00.000Z" }]);
  const pass = await loadLegPass(db);
  assert.equal(pass.rows.length, 3);
  const ctx = (n: number) => pass.context.get(pass.rows.find((r) => r.number === n)!.id);
  assert.equal((ctx(2) as { since: string }).since, "2026-03-01T00:00:00.000Z");
  assert.equal((ctx(3) as { since: string }).since, AT);
  assert.equal((ctx(2) as { approvedBy: string | null }).approvedBy, "ann");
  // PR 1's leg has no workflow id yet: it reads the live workflow of its PR until adoptLegs links it.
  assert.equal((ctx(1) as { workflowId: number }).workflowId, ids.get("o/a#1"));
  assert.equal(await adoptLegs(db, [{ id: pass.rows.find((r) => r.number === 1)!.id, workflowId: ids.get("o/a#1")! }]), 1);
  assert.equal(await adoptLegs(db, [{ id: pass.rows.find((r) => r.number === 2)!.id, workflowId: 999 }]), 0, "a linked leg is not adopted again");
});

both("loadPrWorkflows: a PR's own live workflow, else its leg's, else its issue's implement workflow; listWorkflowLegs finds an issue's legs", async ({ db }) => {
  const q = queryDb(db);
  const k = q.k as any;
  const ids = await seed(db, 4);
  const issues = await startWorkflows(db, [90, 91].map((n) => wf("o/a", n, { kind: "issue", entry: "implement" })));
  const [byLeg, byAttempt] = [issues.get("o/a#90")!, issues.get("o/a#91")!];
  const impl = (number: number, pr: number, attempt: number, state: string) => ({ repo: "o/a", number, queued_by: "ann", state, attempt, text_hash: "h", pr_number: pr, created_at: AT, updated_at: AT });
  await q.run(k.insertInto("main.implementations").values([impl(91, 2, 1, "closed"), impl(91, 4, 2, "pr-opened")]));
  // PR 3 and 4 have no live workflow of their own; PR 3's leg is the first issue's, PR 4 was opened for the second.
  await saveWorkflows(db, [3, 4].map((n) => ({ id: ids.get(`o/a#${n}`)!, patch: { state: "stopped" as const } })));
  await q.run(k.updateTable("main.preapprovals").set({ workflow_id: byLeg }).where("number", "=", 3));
  const refs = [1, 2, 3, 4, 5].map((number) => ({ repo: "o/a", number }));
  assert.deepEqual([...await loadPrWorkflows(db, refs)].map(([key, w]) => [key, w.id]).sort(),
    [["o/a#1", ids.get("o/a#1")], ["o/a#2", ids.get("o/a#2")], ["o/a#3", byLeg], ["o/a#4", byAttempt]]);
  assert.deepEqual((await listWorkflowLegs(db, [byLeg])).map((l) => l.number), [3]);
});

both("loadFixupRequests: queued requests of makers who may act, ordered, narrowed by refs", async ({ db }) => {
  const q = queryDb(db);
  const k = q.k as any;
  await q.run(k.insertInto("main.tracked_repos").values({ name: "o/a" }));
  await q.run(k.insertInto("main.access").values([{ login: "ann", role: "maintainer" }, { login: "bob", role: "viewer" }]));
  const now = new Date().toISOString();
  await q.run(k.insertInto("main.repo_permissions").values([{ login: "ann", repo: "o/a", permission: "write", checked_at: now }, { login: "bob", repo: "o/a", permission: "write", checked_at: now }]));
  await q.run(k.insertInto("main.operator_fixups").values([
    { repo: "o/a", number: 2, from_head: "h", instructions: "b", by: "ann", at: AT, state: "queued" }, { repo: "o/a", number: 1, from_head: "h", instructions: "a", by: "ann", at: AT, state: "queued" },
    { repo: "o/a", number: 3, from_head: "h", instructions: "c", by: "bob", at: AT, state: "queued" }, { repo: "o/a", number: 4, from_head: "h", instructions: "d", by: "ann", at: AT, state: "ended" },
  ]));
  assert.deepEqual((await loadFixupRequests(db, { open: true })).map((r) => r.instructions), ["a", "b"]);
  assert.deepEqual((await loadFixupRequests(db, { open: true, anyMaker: true })).map((r) => r.instructions), ["a", "b", "c"]);
  assert.deepEqual((await loadFixupRequests(db, { refs: [{ repo: "o/a", number: 2 }] })).map((r) => r.instructions), ["b"]);
  assert.deepEqual((await loadFixupRequests(db, { open: true, nowMs: Date.now() + 3_600_000 })).map((r) => r.instructions), [], "an old permission read stops counting");
});

both("loadHolds reads the held PRs of a repo or of refs", async ({ db }) => {
  const q = queryDb(db);
  await q.run((q.k as any).insertInto("main.merge_holds").values([{ repo: "o/a", number: 2, held_by: "ann", held_at: AT }, { repo: "o/b", number: 1, held_by: "bob", held_at: AT }]));
  assert.deepEqual([...await loadHolds(db)].map(([key]) => key), ["o/a#2", "o/b#1"]);
  assert.deepEqual([...await loadHolds(db, { repo: "o/b" })], [["o/b#1", { heldBy: "bob", heldAt: AT }]]);
  assert.equal((await loadHolds(db, { refs: [{ repo: "o/a", number: 2 }, { repo: "o/a", number: 3 }] })).size, 1);
  assert.equal((await loadHolds(db, { refs: [] })).size, 0);
});

async function seeded(n: number): Promise<{ db: Db; run(): Promise<unknown>; close(): Promise<void> }> {
  const o = await openApp("sqlite");
  const q = queryDb(o.db);
  await seed(o.db, n);
  await q.run((q.k as any).insertInto("main.tracked_repos").values({ name: "o/a" }).onConflict((oc: any) => oc.doNothing()));
  const keys = Array.from({ length: n }, (_, i) => ({ repo: "o/a", number: i + 1 }));
  return {
    db: o.db, close: () => o.t.close(),
    run: async () => {
      await loadLegs(o.db, keys, { latestOnly: true });
      await loadLandedApprovals(o.db, keys);
      await loadLegPass(o.db);
      await loadFixupRequests(o.db, { open: true });
      await loadHolds(o.db, { refs: keys });
    },
  };
}

both("the leg loaders issue as many statements for 40 PRs as for 4", async () => {
  await expectFlat(seeded, 4, 40);
});

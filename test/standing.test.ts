// A merge approval and the work a person started stand while GitHub cannot answer on their write access; its own answer stops them for that person.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { addLegs, loadLegs, saveWorkflows, startWorkflows } from "../src/data/workflow/index.ts";
import { savePermissions } from "../src/data/access/index.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => { current?.close(); current = null; });

const MAINT = "maint";
/** An approved PR whose leg waits for its review, with no permission row of its approver (an approval carried over). */
async function fresh(): Promise<World> {
  const w = current = await (await (await (await world()).repo()).pr(1)).issue(2);
  await w.db.run(w.db.k.insertInto("access").values({ login: MAINT, role: "maintainer" }));
  await w.db.run(w.db.k.insertInto("settings").values({ key: "github_identity", value: "app" }));
  const ids = await startWorkflows(w.db, [
    { repo: "app", number: 1, kind: "pr", entry: "review", weight: 5, startedBy: MAINT, startedVia: "github", baseHead: "sha1", approvedBy: MAINT, approvedVia: "github", at: T0 },
    { repo: "app", number: 2, kind: "issue", entry: "implement", weight: 5, startedBy: MAINT, startedVia: "github", baseHead: null, at: T0 },
  ]);
  await addLegs(w.db, [{ repo: "app", number: 1, by: MAINT, workflowId: ids.get("app#1")!, head: "sha1", state: "review" }]);
  return w;
}
const state = async (w: World) => (await loadLegs(w.db, [{ repo: "app", number: 1 }], { latestOnly: true })).get("app#1")!.at(-1)!.state;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** Two passes over a GitHub that answers `permission` (null: it cannot be read): the first starts the read, the second sees the answer. */
async function pass(w: World, permission: string | null): Promise<void> {
  const read = async () => {
    if (permission === null) return { kind: "error" as const, why: "GitHub permission check failed: 502" };
    await savePermissions(w.db, [{ login: MAINT, repo: "app", permission, checkedAt: new Date().toISOString() }]);
    return { kind: "ok" as const, permission };
  };
  for (let i = 0; i < 2; i++) {
    await advancePreapprovals(w.db, () => {}, { permission: read, retryMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
  }
  await advancePreapprovals(w.db, () => {}, { permission: read, retryMs: 0 });
}

test("a merge approval outlives unread, stale and failed permission reads; on GitHub's answer the leg waits for another maintainer's approval", async () => {
  const w = await fresh();
  await pass(w, null);
  assert.equal(await state(w), "review", "never read and GitHub is down");
  await pass(w, "write");
  assert.equal(await state(w), "review", "read through the app");
  for (const age of [11, 61, 24 * 60]) {
    await savePermissions(w.db, [{ login: MAINT, repo: "app", permission: "write", checkedAt: minutesAgo(age) }]);
    await pass(w, null);
    assert.equal(await state(w), "review", `confirmed ${age} minutes ago, GitHub is down`);
  }
  await pass(w, "read");
  await w.review(1);
  await pass(w, "read");
  assert.equal(await state(w), "review", "GitHub says the person has no write access: the leg goes nowhere and stays");
  await w.acting("other");
  const id = Number((await w.rows("SELECT id FROM item_workflows WHERE number = 1"))[0]!.id);
  await saveWorkflows(w.db, [{ id, patch: { approvedBy: "other", approvedVia: "github", approvedAt: new Date().toISOString() } }]);
  await pass(w, "read");
  assert.equal(await state(w), "ci", "another maintainer approved");
});

test("a started implementation waits for GitHub's answer and is not given back to a person meanwhile", async () => {
  const w = await fresh();
  const standing = async () => (await loadItemFact(w.db, "app", 2))!.implement.standing;
  assert.equal(await standing(), "unknown");
  await pass(w, "write");
  assert.equal(await standing(), "yes");
  await savePermissions(w.db, [{ login: MAINT, repo: "app", permission: "write", checkedAt: minutesAgo(90) }]);
  assert.equal(await standing(), "unknown");
  await pass(w, "none");
  assert.equal(await standing(), "no");
});

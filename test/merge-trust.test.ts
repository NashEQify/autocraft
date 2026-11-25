// Merge trust follows the code it covered: an approved merge carries to the head of a base merge that left the PR's own diff unchanged, and to no other head the pipeline made from code nobody reviewed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { advancePreapprovals, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

test("an approved merge carries across a base merge that left the diff unchanged, not across a CI fix or a changed-diff merge", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  for (const n of [1, 2, 3]) {
    await (await (await w.pr(n)).review(n, { verdict: "take" })).workflow(n);
    await preapproveMerge(w.db, { repo: "app", number: n, by: OPERATOR });
  }
  await advancePreapprovals(w.db);
  for (const n of [1, 2, 3]) assert.equal((await preapprovalOf(w.db, "app", n))?.state, "ci");
  const merge = (number: number, from_head: string, to_head: string, own_diff: string) =>
    w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number, from_head, to_head, state: "merged", attempt: 1, created_at: T0, own_diff }));
  await merge(1, "sha1", "sha1m", "same");
  await merge(2, "sha2", "sha2m", "changed");
  await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 3, head: "sha3", to_head: "sha3c", kind: "code", state: "pushed", attempt: 1, created_at: T0 }));
  await (await (await w.synced(1, "sha1m")).synced(2, "sha2m")).synced(3, "sha3c");
  await advancePreapprovals(w.db);
  const p = (await preapprovalOf(w.db, "app", 1))!;
  assert.deepEqual([p.state, p.fromHead, p.head, p.by], ["review", "sha1", "sha1m", OPERATOR]);
  for (const n of [2, 3]) assert.equal((await preapprovalOf(w.db, "app", n))?.state, "cancelled");
  // The base merge's head needs its own review before anything merges it.
  assert.ok(!(await w.prPlan(1)).actions.some((a) => a.kind === "merge"));
});

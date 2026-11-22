// The flowchart counts: each node counts its items under the rule of its stage, for one repo or every tracked repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countAll } from "../src/flow/count.ts";
import { T0, T1, world } from "./world-db.ts";

test("flow counts follow each stage's rows, for one repo and for every tracked repo", async () => {
  const w = await (await world()).repo();
  await w.issue(1); await w.issue(2); await w.pr(10); await w.pr(11); await w.pr(12);
  await w.review(10); await w.review(11, { verdict: "take-fix" }); await w.verified(10);
  const db = w.db, now = Date.parse(T1) + 3600_000;
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 50, kind: "issue", state: "CLOSED", title: "t", author: "a", created_at: T0, updated_at: T1, closed_at: T1 }));
  await db.run(db.k.insertInto("merges").values([
    { repo: "app", number: 10, head_oid: "h", run_id: "r", at: T1, path: "rule", outcome: "merged" },
    { repo: "app", number: 10, head_oid: "h", run_id: "r", at: T1, path: "rule", outcome: "refused" },
    { repo: "app", number: 11, head_oid: "h", run_id: "r", at: T0, path: "rule", outcome: "merged" },
  ]));
  await db.run(db.k.insertInto("fixups").values({ repo: "app", number: 11, from_head: "a", to_head: "b", state: "pushed", attempt: 1, created_at: T1 }));
  await db.run(db.k.insertInto("item_rank").values([{ repo: "app", number: 1, score: 70, breakdown: "{}", computed_at: T1 }, { repo: "app", number: 2, score: 90, breakdown: "{}", computed_at: T1 }]));
  await db.run(db.k.insertInto("decisions").values([
    { id: "s1", kind: "scope", repo: "app", number: 1, question: "q", options: "[]", asked_at: T1 },
    { id: "d1", kind: "duplicate", repo: "app", number: 2, question: "q", options: "[]", asked_at: T0 },
  ]));
  await db.run(db.k.insertInto("stages").values({ repo: "app", number: 1, stage: "labeled", at: T1 }));

  for (const repo of ["app", null]) {
    const { counts, members } = await countAll(db, repo, now);
    assert.deepEqual([counts["synced.issues"], counts["synced.prs"], counts["synced.recent.closed"]], [2, 3, 1], String(repo));
    assert.deepEqual([...members.get("review.take")!], ["app#10"]);
    assert.deepEqual([...members.get("review.take-fix")!], ["app#11"]);
    assert.deepEqual([...members.get("verify.passed")!], ["app#10"]);
    assert.deepEqual([...members.get("merge.merged")!], ["app#10"]);
    assert.deepEqual([counts["merge.recent.merged"], counts["merge.recent.tries"]], [1, 2]);
    assert.deepEqual([...members.get("fixup.pushed")!], ["app#11"]);
    assert.deepEqual([counts["fixup.recent.pushed"], counts["x.ranked"], counts["max.topRank"]], [1, 2, 90]);
    assert.deepEqual([...members.get("decide.open")!], ["app#1"]);
    assert.deepEqual([...members.get("dupes.waiting")!], ["app#2"]);
    assert.deepEqual([...members.get("labels.labelled")!], ["app#1"]);
  }
  assert.equal((await countAll(db, "other", now)).counts["synced.total"], 0, "another repo counts none of these");
});

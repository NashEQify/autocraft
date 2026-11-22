// The flowchart summary marks the repos whose data changed as stale: a batch decision counts for each repo it names, and a
// change to an approval setting marks every repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { markChanged } from "../src/flow/summary.ts";
import { ask } from "../src/decisions.ts";
import { excluded } from "../src/db/kx.ts";
import { world } from "./world-db.ts";

const OPTS = [{ key: "a", label: "A" }, { key: "b", label: "B" }];

test("a batch decision marks the repos it names stale, and an approval setting marks all", async () => {
  const w = await (await (await world()).repo()).issue(1);
  const db = w.db;
  const mine = ["app", "other", "third"];
  for (const name of ["other", "third"]) await db.run(db.k.insertInto("tracked_repos").values({ name, pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  const stale = async () => (await db.all(db.k.selectFrom("main.flow_summary").select("repo").where("stale", "=", 1).orderBy("repo"))).map((r) => r.repo).filter((r) => mine.includes(r));
  const counted = () => db.run(db.k.insertInto("main.flow_summary").values(mine.map((repo) => ({ repo, counts: "{}", counted_at: "now", stale: 0, decisions_sig: null })))
    .onConflict((oc) => oc.column("repo").doUpdateSet(excluded(["stale", "decisions_sig"]))));
  assert.equal(await markChanged(db), -1, "the first pass has no marks to compare with");
  await counted();
  assert.equal(await markChanged(db), 0, "nothing changed since the last pass");

  await ask(db, [{ id: "batch", kind: "scope", repo: null, number: null, items: [{ repo: "app", number: 1 }, { repo: "other", number: 1 }], question: "Batch?", options: OPTS, recommended: "a", summary: "s" }] as never);
  assert.equal((await markChanged(db)) > 0, true);
  assert.deepEqual(await stale(), ["app", "other"]);

  await counted();
  await db.run(db.k.insertInto("main.settings").values({ key: "labels_approved:third", value: "on" }));
  assert.equal(await markChanged(db), -1);
  assert.deepEqual(await stale(), ["app", "other", "third"]);
});

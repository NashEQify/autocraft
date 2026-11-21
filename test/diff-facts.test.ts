// The planner reads a reviewed head's diff facts from the database; the code that writes or removes the cached diff stores them.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadPrFacts } from "../src/core/facts.ts";
import { EXTRAS_PENDING_REASON } from "../src/core/sensitive.ts";
import { EXTRAS_TRIES, buildDiffFacts, cachedDiff, diffFactsOfCache, dropCachedDiff, noteReread, type DiffFetcher } from "../src/review/diff.ts";
import { tmpdir, world, type World } from "./world-db.ts";

// Other test files write the same fixture heads into the shared scratch cache.
process.env.AUTOCRAFT_DIFF_CACHE = tmpdir("diff-facts");
let current: World | null = null;
afterEach(() => current?.close());

// A README change and a script a workflow step could run, read without the workflow steps: sensitive and waiting for its extras.
const TEXT = [
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " # App", "+See the docs.",
  "diff --git a/scripts/build.sh b/scripts/build.sh", "--- a/scripts/build.sh", "+++ b/scripts/build.sh", "@@ -1 +1 @@", "-make", "+make all", "",
].join("\n");
const fetch: DiffFetcher = async () => ({ ok: true, text: TEXT, base: "main", extras: { files: {}, runs: null, complete: false } });

test("the planner's diff facts follow the cached diff's writes, re-reads and removal", async () => {
  const w = (current = world().repo().pr(1, { lines: 500 }).review(1));
  const facts = () => loadPrFacts(w.db, { refs: ["app#1"] })[0]!;
  assert.equal(facts().sensitive, null);

  await cachedDiff(w.db, "app", 1, "sha1", fetch, "main");
  const file = diffFactsOfCache("app", 1, "sha1")!;
  assert.ok(file.pending && file.reasons.length > 0);
  let f = facts();
  assert.deepEqual(f.sensitive, [...file.reasons, EXTRAS_PENDING_REASON]);
  assert.equal(f.lines, file.lines);
  assert.notEqual(f.lines, 500);
  assert.equal(f.diffPending?.lastRead, null);

  noteReread(w.db, "app", 1, "sha1", 1234);
  assert.equal(facts().diffPending?.lastRead, 1234);
  for (let i = 1; i < EXTRAS_TRIES; i++) noteReread(w.db, "app", 1, "sha1", 2000 + i);
  const settled = diffFactsOfCache("app", 1, "sha1")!;
  f = facts();
  assert.equal(settled.pending, false);
  assert.equal(f.diffPending, undefined);
  assert.deepEqual(f.sensitive, settled.reasons);

  dropCachedDiff(w.db, "app", 1, "sha1");
  f = facts();
  assert.equal(f.sensitive, null);
  assert.equal(f.lines, 500);

  // A diff cached before its facts were stored gets them from the startup fill, once.
  await cachedDiff(w.db, "app", 1, "sha1", fetch, "main");
  w.db.exec("DELETE FROM diff_facts");
  assert.equal(buildDiffFacts(w.db), 1);
  assert.deepEqual(facts().sensitive, [...file.reasons, EXTRAS_PENDING_REASON]);
  assert.equal(buildDiffFacts(w.db), null);
});

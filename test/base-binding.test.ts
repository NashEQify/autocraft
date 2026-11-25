import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { baseRefusal } from "../src/merge/base.ts";
import { cachedDiff, diffCacheDir, type DiffFetcher } from "../src/review/diff.ts";
import { decidePr } from "../src/core/decide.ts";
import { authorWrites, ensureAuthorWrites } from "../src/fixup/author-permission.ts";
import { prFacts } from "./world.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "base-binding-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const HEAD = "a".repeat(40);

test("a merge is refused when the base is not the one the review read", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("repos").values({ name: "app", default_branch: "main" }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: HEAD, at: "t", mode: "full", verdict: "take", base_ref: "main" }));
  assert.equal(await baseRefusal(db, "app", HEAD, 7, "main"), null);
  assert.match((await baseRefusal(db, "app", HEAD, 7, "release"))!, /release.*main/);
  // A review that recorded no base allows the default branch only.
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 8, head_oid: HEAD, at: "t", mode: "full", verdict: "take" }));
  assert.equal(await baseRefusal(db, "app", HEAD, 8, "main"), null);
  assert.ok(await baseRefusal(db, "app", HEAD, 8, "release"));
});

test("a diff is stored only for the head it was fetched at, and read again for another base", async () => {
  const db = await connectDb(join(dir, "diff.db"));
  let calls = 0;
  const moved: DiffFetcher = async () => { calls++; return { ok: false, tooLarge: false, error: "head moved" }; };
  assert.equal((await cachedDiff(db, "app", 7, HEAD, moved)).ok, false);
  assert.equal(existsSync(join(diffCacheDir(), "app", `7-${HEAD}.diff`)), false);
  const at = (base: string): DiffFetcher => async () => { calls++; return { ok: true, text: `diff against ${base}`, base }; };
  assert.equal((await cachedDiff(db, "app", 7, HEAD, at("main"), "main") as { text: string }).text, "diff against main");
  assert.equal((await cachedDiff(db, "app", 7, HEAD, at("main"), "main") as { text: string }).text, "diff against main");
  assert.equal(calls, 2);
  assert.equal((await cachedDiff(db, "app", 7, HEAD, at("release"), "release") as { text: string }).text, "diff against release");
  assert.equal(calls, 3);
});

test("a private-org member's PR is pushable once the author's permission is read, and is waiting before", async () => {
  const db = await connectDb(join(dir, "perm.db"));
  await db.run(db.k.insertInto("repos").values({ name: "app", default_branch: "main" }));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 9, kind: "pr", state: "OPEN", author: "ana", author_association: "CONTRIBUTOR", head_repo: "storytold/app", head_ref: "ana/fix" }));
  assert.equal(await authorWrites(db, "app", 9), "unknown");
  let reads = 0;
  const read = async (_repo: string, login: string) => { reads++; return login === "ana" ? "write" : "read"; };
  assert.equal(await ensureAuthorWrites(db, "app", 9, "storytold/app", read), "yes");
  assert.equal(await ensureAuthorWrites(db, "app", 9, "storytold/app", read), "yes");
  assert.equal(reads, 1);
  // An entry over a day old is read again.
  await db.run(db.k.updateTable("author_permissions").set({ checked_at: "2020-01-01T00:00:00.000Z" }));
  await ensureAuthorWrites(db, "app", 9, "storytold/app", async () => "read");
  assert.equal(await authorWrites(db, "app", 9), "no");
  // An author whose permission cannot be read waits, then counts as unable to write after three failed reads.
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 10, kind: "pr", state: "OPEN", author: "bo", head_repo: "storytold/app", head_ref: "bo/x" }));
  for (const want of ["unknown", "unknown", "no"]) assert.equal(await ensureAuthorWrites(db, "app", 10, "storytold/app", async () => null), want);
});

test("a PR aimed at a non-default branch is planned as a single merge only", () => {
  const plan = decidePr(prFacts({ baseOffDefault: true }));
  const merge = plan.actions.find((a) => a.kind === "merge");
  assert.ok(merge);
  assert.equal(merge.params?.singleOnly, true);
  assert.equal(merge.params?.batchable, false);
});

test("a PR stacked on another open PR's branch needs a decision", () => {
  const plan = decidePr(prFacts({ stackedOn: 4, baseOffDefault: true }));
  assert.equal(plan.state, "needs-decision");
  assert.ok(plan.reasons.some((r) => /targets the branch of open #4/.test(r)));
});

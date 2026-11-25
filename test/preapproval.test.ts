// The pre-approved merge: a fix-up pushed, a take review, green CI and the hand-over to the merge queue; and a foreign push that cancels it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { reviewHolds } from "../src/review/gate.ts";
import { advancePreapprovals, cancelPreapproval, preapprovalOf, preapproveMerge, runPipelineStep } from "../src/preapproval/index.ts";
import { operatorEditable, splitChanges } from "../src/fixup/patch.ts";
import { operatorCommentText } from "../src/fixup/template.ts";
import { scopeToTracked } from "../src/repos.ts";
import { excluded } from "../src/db/kx.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";
import { loadLegPass } from "../src/data/workflow/index.ts";
import { queueOriginOf, queuePage } from "../src/dash/api/queue-page.ts";
import type { Req } from "../src/dash/types.ts";
import type { CachedEntry } from "../src/core/plan-read.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";

let current: World | null = null;
const fresh = async (): Promise<World> => (current = await (await world()).repo());
afterEach(() => current?.close());

const start = (w: World, n: number, merge = true) =>
  runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge }, by: OPERATOR });
const fixId = async (w: World, n: number): Promise<number> => ((await w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n))[0]!.id as number);
const fixRow = async (w: World, n: number, state: string, to: string | null = null) =>
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, to_head: to, state, attempt: 1, created_at: T0, source: "operator", operator_fix: await fixId(w, n) }));
const pushed = async (w: World, n: number, to: string) => await fixRow(w, n, "pushed", to);
const kindsOf = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
/** A pre-approved merge whose fix-up pushed `<n>b` and whose sure take review of it exists: it waits in ci for CI and the pre-merge review. */
const inCi = async (w: World, n: number) => {
  await start(w, n);
  await pushed(w, n, `sha${n}b`);
  await (await w.synced(n, `sha${n}b`)).review(n, { head: `sha${n}b` });
  await settle(w);
  assert.equal((await preapprovalOf(w.db, "app", n))?.state, "ci");
};
const settle = async (w: World) => { for (let i = 0; i < 5; i++) await advancePreapprovals(w.db); };

describe("pre-approved merge", () => {

  test("a sure take review does not let the queue merge or ask while the pre-approval waits", async () => {
    const w = await (await (await (await (await fresh()).pr(8)).review(8)).verified(8)).premerge(8, "clean");
    assert.ok((await kindsOf(w, 8)).some((k) => k.startsWith("merge")), (await kindsOf(w, 8)).join());
    await start(w, 8);
    assert.ok(!(await kindsOf(w, 8)).some((k) => k.startsWith("merge") || k.startsWith("ask-merge")), (await kindsOf(w, 8)).join());
  });

  test("a re-review that turns unsure during ci still hands over, after the review", async () => {
    const w = await (await (await fresh()).pr(5)).review(5, { verdict: "take-fix" });
    await inCi(w, 5);
    await w.premerge(5, "clean");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ sure: 0 }).where("number", "=", 5).where("head_oid", "=", "sha5b"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 5))?.state, "queued");
    // The merge queue keeps a Merge answer at an unsure head only when it came after the review.
    const f = (await w.plan()).prs.find((x) => x.facts.number === 5)!.facts;
    assert.ok(f.decision.mergeAnswerAfterReview && f.review!.unsure);
  });

  test("an operator fix-up stored for linting is planned for its lint check, and a dropped one ends the request instead of looping", async () => {
    const w = await (await (await fresh()).pr(11)).pr(12);
    await start(w, 11);
    await fixRow(w, 11, "linting");
    const kinds = await kindsOf(w, 11);
    assert.ok(!kinds.includes("fixup:operator"), kinds.join());
    assert.ok(kinds.includes("lint:operator"), kinds.join());

    await start(w, 12);
    await fixRow(w, 12, "superseded");
    assert.ok(!(await kindsOf(w, 12)).includes("fixup:operator"), (await kindsOf(w, 12)).join());
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "failed");
  });

  test("a fix-up request without merge ends when the head moves, and a pre-approval whose fix-up cannot run asks", async () => {
    const w = await (await (await (await fresh()).pr(13)).pr(14)).review(14, { verdict: "take-fix" });
    await start(w, 13, false);
    await w.synced(13, "moved13");
    await settle(w);
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 13"))[0]!.state, "ended");

    await start(w, 14);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ mergeable: "CONFLICTING" }).where("number", "=", 14));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 14))?.state, "asked");
  });

  test("a cancel is refused while a merge job runs, and a merge that lands after a cancel turns the row into merged", async () => {
    const w = await (await (await fresh()).pr(15)).review(15, { verdict: "take-fix" });
    await inCi(w, 15);
    await w.premerge(15, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "queued");
    const job = (await w.db.get(w.db.k.insertInto("jobs").values({ step: "merge", params: "{}", requested_by: "pipeline", requested_at: T0, state: "running", repo: "app" }).returning("id")))!;
    await assert.rejects(cancelPreapproval(w.db, OPERATOR, "app", 15), /merge of the repo is running/);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "queued");
    await w.db.run(w.db.k.updateTable("jobs").set({ state: "done" }).where("id", "=", job.id));
    await cancelPreapproval(w.db, OPERATOR, "app", 15);
    await w.db.run(w.db.k.insertInto("merges").values({ repo: "app", number: 15, head_oid: "sha15b", run_id: "r", at: new Date().toISOString(), path: "operator", method: "squash", outcome: "merged" }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "merged");
  });

  test("untracking the repo leaves an active row untouched on the scoped connection, and tracking again resumes it", async () => {
    const w = await (await (await fresh()).pr(40)).review(40, { verdict: "take-fix" });
    await start(w, 40);
    await pushed(w, 40, "sha40b");
    await w.synced(40, "sha40b");
    await scopeToTracked(w.db);
    await w.db.run(w.db.k.deleteFrom("main.tracked_repos").where("name", "=", "app"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 40))?.state, "fixup");
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 40"))[0]!.state, "queued");
    await w.db.run(w.db.k.insertInto("main.tracked_repos").values({ name: "app", added_by: OPERATOR, added_at: T0, pipeline: 1 }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 40))?.state, "review");
  });

  test("the pipeline's own CI fix push ends the pre-approval like a foreign push", async () => {
    const w = await (await (await (await (await fresh()).pr(16)).review(16, { verdict: "take-fix" })).pr(17)).review(17, { verdict: "take-fix" });
    await inCi(w, 16);
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 16, head: "sha16b", to_head: "sha16c", kind: "format", state: "pushed", attempt: 1, created_at: T0 }));
    await w.synced(16, "sha16c");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 16))?.state, "cancelled");

    await inCi(w, 17);
    await w.synced(17, "foreign17");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "cancelled");
  });

  test("an operator fix-up may edit any file but the protected ones, and its comment lists the model's changes", () => {
    assert.ok(operatorEditable("docs/guide.txt") && operatorEditable("src/a.rs"));
    for (const f of ["Cargo.toml", "crates/x/Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", ".gitmodules", ".gitattributes", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".claude/settings.json", "sub/AGENTS.md"]) assert.ok(!operatorEditable(f), f);
    assert.ok(!operatorEditable(".github/workflows/ci.yml") && !operatorEditable("build.rs") && !operatorEditable("CLAUDE.md") && !operatorEditable("a/../b"));
    const r = splitChanges("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\nCHANGES:\n1. Renamed a to b.\n2) Fixed the doc.\n");
    assert.deepEqual(r.changes, ["Renamed a to b.", "Fixed the doc."]);
    assert.ok(r.diff.endsWith("+b"));
    const quoted = "Keep the exported file names stable across every release of the tool please";
    const c = splitChanges(`d\n\nCHANGES:\n1. See [the docs](https://example.org/x) and @someone for details\n2. ${quoted} and more\n3. Renamed a to b\n`, quoted);
    assert.deepEqual(c.changes, ["See the docs and someone for details.", "Renamed a to b."]);
    assert.equal(operatorCommentText(["x"], r.changes), "Fixes included:\n1. Renamed a to b.\n2. Fixed the doc.");
  });

  test("a cancel whose batch removal fails leaves no hold the removal set", async () => {
    const w = await (await (await fresh()).pr(19)).review(19, { verdict: "take-fix" });
    await inCi(w, 19);
    await w.premerge(19, "clean");
    await settle(w);
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 6, repo: "app", branch: "integration-app-2", state: "open", base_sha: "b", commit_sha: "t", pr_number: 77, created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: 6, number: 19, head_oid: "sha19b", position: 1 }));
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await assert.rejects(cancelPreapproval(w.db, OPERATOR, "app", 19, failing));
    assert.equal((await w.db.all(w.db.k.selectFrom("merge_holds").select((eb) => eb.lit(1).as("one")).where("number", "=", 19))).length, 0);
    assert.equal((await preapprovalOf(w.db, "app", 19))?.state, "queued");
  });
});

describe("add to merge queue (a pre-approved merge without a fix-up)", () => {

  test("the add asks for no review of its own: running CI still holds the review of the PR's head", async () => {
    const w = await (await fresh()).pr(13);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "pending" }).where("number", "=", 13));
    await preapproveMerge(w.db, { repo: "app", number: 13, by: OPERATOR });
    assert.equal((await (await reviewHolds(w.db))("app", 13, "sha13"))?.kind, "ci");
  });

  test("the label does not stop it: a plugin candidate or an unclassified PR is reviewed, and a label settled later does not flip it out", async () => {
    const w = await (await (await (await fresh()).pr(16, { label: "plugin candidate" })).pr(17)).pr(18, { label: "plugin candidate", flags: ["needs decision"] });
    await w.db.run(w.db.k.deleteFrom("classifications").where("number", "=", 17));
    for (const n of [16, 17]) {
      assert.equal((await w.prPlan(n)).state, "label-not-reviewed");
      await preapproveMerge(w.db, { repo: "app", number: n, by: OPERATOR });
      await settle(w);
      assert.equal((await preapprovalOf(w.db, "app", n))?.state, "review");
      assert.ok((await kindsOf(w, n)).includes("review:"), (await kindsOf(w, n)).join());
    }
    // An open scope question still refuses it, also behind a label that gets no review.
    await assert.rejects(async () => await preapproveMerge(w.db, { repo: "app", number: 18, by: OPERATOR }), /scope question is still open/);
    await w.db.run(w.db.k.insertInto("classifications").values({ repo: "app", number: 17, classifier: "jev", run_id: "r1", at: T0, type_label: "plugin candidate", flags: "[]", probs: '{"top":0.95}' }));
    await w.review(17, { head: "sha17" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "ci");
    await w.premerge(17, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "queued");
  });

  test("the queue row says who added the PR and how; viewers see no login", async () => {
    const w = await (await (await fresh()).pr(14)).pr(15);
    await preapproveMerge(w.db, { repo: "app", number: 14, by: OPERATOR });
    const entry = (number: number) => ({ repo: "app", number, decisionId: null, reviewedAt: T0 }) as unknown as CachedEntry;
    const facts = { legs: (await loadLegPass(w.db)).rows, carried: new Map() };
    const staff = queueOriginOf(facts, true);
    assert.deepEqual({ ...staff(entry(14)), at: null }, { how: "queued", by: OPERATOR, at: null });
    assert.equal(queueOriginOf(facts, false)(entry(14)).by, null);
    assert.deepEqual(staff(entry(15)), { how: "review", by: null, at: T0 });
  });

  test("the Merge tab lists a queued PR before its take review, and drops it once the review makes it a queue row", async () => {
    const w = await (await fresh()).pr(16);
    await preapproveMerge(w.db, { repo: "app", number: 16, by: OPERATOR });
    await refreshPlanCache(w.db);
    const req = { query: new URLSearchParams("tab=merge&repos=all"), user: { login: OPERATOR, role: "operator", canWrite: async () => true } } as unknown as Req;
    const before = await queuePage(w.db, req);
    assert.ok(!before.mergeRows.some((r) => r.number === 16));
    assert.deepEqual(before.pending?.map((p) => [p.number, p.step, p.added.how]), [[16, "review", "queued"]]);
    assert.equal(before.counts.merge, before.mergeRows.length + 1);
    await w.review(16, { verdict: "take" });
    await settle(w);
    await refreshPlanCache(w.db);
    const after = await queuePage(w.db, { ...req, query: new URLSearchParams("tab=merge&repos=all") } as Req);
    assert.ok(after.mergeRows.some((r) => r.number === 16));
    assert.ok(!after.pending?.some((p) => p.number === 16));
  });
});


describe("a maintainer's pre-approval after their dashboard session", () => {
  test("the pipeline reads the write permission again through the app: write keeps it, a failed read keeps it for an hour, read cancels it", async () => {
    const w = await (await (await fresh()).pr(61)).pr(62);
    await w.db.run(w.db.k.insertInto("access").values({ login: "maint", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
    await w.db.run(w.db.k.insertInto("settings").values([{ key: "maintainer_writes", value: "1" }, { key: "github_identity", value: "app" }]).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    const perm = async (permission: string, at: string) =>
      await w.db.run(w.db.k.insertInto("repo_permissions").values({ login: "maint", repo: "app", permission, checked_at: at })
        .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(excluded(["permission", "checked_at"]))));
    await perm("write", new Date().toISOString());
    await preapproveMerge(w.db, { repo: "app", number: 61, by: "maint" });
    // Stands in for appPermission, which writes what GitHub answered to repo_permissions.
    const answer = (permission: string | null) => async () => {
      if (permission === null) return { kind: "error" as const, why: "GitHub permission check failed: 502" };
      await perm(permission, new Date().toISOString());
      return { kind: "ok" as const, permission };
    };
    const pass = async (permission: string | null) => {
      await advancePreapprovals(w.db, () => {}, { permission: answer(permission) });
      await new Promise((r) => setImmediate(r));
      await advancePreapprovals(w.db, () => {}, { permission: answer(permission) });
    };
    await perm("write", stale);
    await pass("write");
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "review");
    await perm("write", stale);
    await pass(null);
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "review");
    await perm("write", stale);
    await pass("read");
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "cancelled");
    // A write permission GitHub last confirmed over an hour ago no longer counts while the reads fail.
    await perm("write", new Date().toISOString());
    await preapproveMerge(w.db, { repo: "app", number: 62, by: "maint" });
    await perm("write", new Date(Date.now() - 61 * 60_000).toISOString());
    await pass(null);
    assert.equal((await preapprovalOf(w.db, "app", 62))?.state, "cancelled");
  });
});


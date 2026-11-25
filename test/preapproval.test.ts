// The merge leg of a workflow (a pre-approved merge): a fix-up pushed, a take review, green CI and the hand-over to the merge queue; and a foreign push that cancels it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { reviewHolds } from "../src/review/gate.ts";
import { advancePreapprovals, cancelPreapproval, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { mergeAllowed } from "../src/core/gates.ts";
import { operatorEditable, splitChanges } from "../src/fixup/patch.ts";
import { operatorCommentText } from "../src/fixup/template.ts";
import { setOptionalCheck } from "../src/optional-checks.ts";
import { scopeToTracked } from "../src/repos.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { expectFlat } from "./helpers/query-count.ts";
import { premergeFix } from "../src/core/decide.ts";
import { CHECK, OPERATOR, T0, world, type World } from "./world-db.ts";
import { addOwnCommits } from "../src/data/control/index.ts";
import { loadLegPass } from "../src/data/workflow/index.ts";
import { queueOriginOf, queuePage } from "../src/dash/api/queue-page.ts";
import type { Req } from "../src/dash/types.ts";
import type { CachedEntry } from "../src/core/plan-read.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";

let current: World | null = null;
/** The repo with an operator who may act on it. */
const fresh = async (): Promise<World> => (current = await (await (await world()).repo()).acting());
afterEach(() => current?.close());

const start = (w: World, n: number, merge = true) => w.fixup(n, merge);
const fixId = async (w: World, n: number): Promise<number> => ((await w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n))[0]!.id as number);
const fixRow = async (w: World, n: number, state: string, to: string | null = null) =>
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, to_head: to, state, attempt: 1, created_at: T0, source: "operator", operator_fix: await fixId(w, n) }));
const pushed = async (w: World, n: number, to: string) => {
  await fixRow(w, n, "pushed", to);
  await addOwnCommits(w.db, [{ repo: "app", sha: to, action: "fixup-push" }]);
};
const kindsOf = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
/** The PR under a running workflow whose merge is approved. */
const take = async (w: World, n: number) => await (await w.pr(n)).workflow(n);
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
  test("fix-up pushed, review take, pre-merge review clean, CI green: the merge queue gets it", async () => {
    const w = await (await take(await fresh(), 1)).review(1, { verdict: "take-fix" });
    await start(w, 1);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "fixup");
    // The planner works the person's fix-up and merges nothing meanwhile.
    const kinds = await kindsOf(w, 1);
    assert.ok(kinds.includes("fixup:operator"), kinds.join());
    assert.ok(!kinds.some((k) => k.startsWith("fixup:review") || k.startsWith("merge")), kinds.join());

    await pushed(w, 1, "sha1b");
    await w.synced(1, "sha1b");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 1))!;
    assert.deepEqual([p.state, p.head], ["review", "sha1b"]);

    await w.review(1, { head: "sha1b" });
    await settle(w);
    // CI is green, but the pre-merge review of the pushed head comes first.
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "ci");
    assert.ok((await kindsOf(w, 1)).includes("premerge:"), (await kindsOf(w, 1)).join());
    await w.premerge(1, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "queued");
    await w.verified(1);
    assert.ok((await kindsOf(w, 1)).some((k) => k.startsWith("merge")), (await kindsOf(w, 1)).join());
    assert.ok((await w.rows("SELECT action FROM audit WHERE target = 'app#1' AND action = 'preapproval'")).length >= 4);
  });

  test("a push by someone else cancels it, and a red CI the CI fix gave up on fails it", async () => {
    const w = await (await take(await (await take(await fresh(), 2)).review(2, { verdict: "take-fix" }), 3)).review(3, { verdict: "take-fix" });
    await start(w, 2);
    await w.synced(2, "foreign");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 2))?.state, "cancelled");
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 2"))[0]!.state, "ended");

    await inCi(w, 3);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "failure" }).where("number", "=", 3));
    // The CI fix step may still repair the red head: the leg waits for it, and ends once it has given up.
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.state, "ci");
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 3, head: "sha3b", kind: "code", state: "capped", attempt: 1, created_at: T0 }));
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 3))!;
    assert.equal(p.state, "failed");
    assert.match(p.reason!, /CI failed/);
  });

  test("an unsure take of the push goes on to CI; a hold review of it fails it", async () => {
    const w = await (await take(await fresh(), 4)).review(4, { verdict: "take-fix" });
    await start(w, 4);
    await pushed(w, 4, "sha4b");
    await (await w.synced(4, "sha4b")).review(4, { head: "sha4b", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 4))?.state, "ci");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ verdict: "hold" }).where("number", "=", 4).where("head_oid", "=", "sha4b"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 4))?.state, "failed");
  });

  test("a defect of the pre-merge review stops the hand-over", async () => {
    const w = await (await take(await fresh(), 10)).review(10, { verdict: "take-fix" });
    await inCi(w, 10);
    await w.premerge(10, "defect", false);
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 10))!;
    assert.equal(p.state, "failed");
    assert.match(p.reason!, /1 defect/);
  });

  test("the defects of an approved PR outside the rule go to the one pre-merge fix-up", async () => {
    const w = await (await (await fresh()).pr(19, { label: "performance" })).review(19, { verdict: "take-fix" });
    await w.workflow(19);
    await inCi(w, 19);
    await (await w.premerge(19, "defect")).verified(19);
    assert.ok((await kindsOf(w, 19)).includes("fixup:premerge"), (await kindsOf(w, 19)).join());
    // While the fix-up's push is under way it is made once, and the PR waits for it.
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 19, from_head: "sha19b", to_head: "sha19c", state: "pushing", attempt: 1, created_at: T0, source: "premerge" }));
    const p = (await w.plan()).prs.find((x) => x.facts.number === 19)!;
    assert.deepEqual([p.plan.state, p.plan.waitKind, premergeFix(p.facts)], ["needs-fix-up", "system", "running"]);
  });

  test("an approved PR in a repo without CI stops", async () => {
    const w = await (await take(await fresh(), 56)).review(56, { verdict: "take-fix" });
    await inCi(w, 56);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "none" }));
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 56))!;
    assert.equal(p.state, "failed");
    assert.match(p.reason!, /no CI/);
  });

  test("cancelling after the hand-over takes the PR out of the merge queue, also out of a batch", async () => {
    const w = await (await take(await (await take(await fresh(), 6)).review(6, { verdict: "take-fix" }), 18)).review(18, { verdict: "take-fix" });
    for (const n of [6, 18]) {
      await inCi(w, n);
      await (await w.premerge(n, "clean")).verified(n);
      await settle(w);
      assert.equal((await preapprovalOf(w.db, "app", n))?.state, "queued");
    }
    assert.equal((await cancelPreapproval(w.db, OPERATOR, "app", 6)).state, "cancelled");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 6))?.state, "cancelled");
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 6))?.state, "blocked");
    assert.equal(mergeAllowed((await w.plan()).prs.find((x) => x.facts.number === 6)!.facts), false, "the merge waits for an answer");

    await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 5, repo: "app", branch: "integration-app-1", state: "open", base_sha: "b", commit_sha: "t", created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: 5, number: 18, head_oid: "sha18b", position: 1 }));
    assert.equal((await cancelPreapproval(w.db, OPERATOR, "app", 18)).state, "cancelled");
    assert.equal((await w.db.get(w.db.k.selectFrom("merge_batches").select("state").where("id", "=", 5)))!.state, "superseded");
    assert.equal((await w.db.all(w.db.k.selectFrom("merge_holds").select((eb) => eb.lit(1).as("one")).where("number", "=", 18))).length, 0);
  });

  test("a sure take review does not let the queue merge or ask while the pre-approval waits", async () => {
    const w = await (await (await (await (await fresh()).pr(8)).review(8)).verified(8)).premerge(8, "clean");
    assert.ok((await kindsOf(w, 8)).some((k) => k.startsWith("merge")), (await kindsOf(w, 8)).join());
    await w.workflow(8);
    await start(w, 8);
    assert.ok(!(await kindsOf(w, 8)).some((k) => k.startsWith("merge") || k.startsWith("ask-merge")), (await kindsOf(w, 8)).join());
  });

  test("a re-review that turns unsure during ci still hands over, after the review", async () => {
    const w = await (await take(await fresh(), 5)).review(5, { verdict: "take-fix" });
    await inCi(w, 5);
    await w.premerge(5, "clean");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ sure: 0 }).where("number", "=", 5).where("head_oid", "=", "sha5b"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 5))?.state, "queued");
    await w.verified(5);
    assert.ok((await kindsOf(w, 5)).some((k) => k.startsWith("merge")), (await kindsOf(w, 5)).join());
  });

  test("a new review after the hand-over of a PR approved for merge: an unsure take still merges, a take-fix is fixed first and its push goes on", async () => {
    const w = await (await take(await fresh(), 50)).review(50, { verdict: "take-fix" });
    await inCi(w, 50);
    await (await w.premerge(50, "clean")).verified(50);
    await settle(w);
    const again = (set: { sure: number; verdict?: string; fixes?: string }) =>
      w.db.run(w.db.k.updateTable("opus_reviews").set({ ...set, at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", 50).where("head_oid", "=", "sha50b"));
    await again({ sure: 0 });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 50))?.state, "queued");
    assert.ok((await kindsOf(w, 50)).some((k) => k.startsWith("merge")), (await kindsOf(w, 50)).join());
    // Not approved for merge, an unsure review merges nothing: on the automatic path, or after a start without approval.
    for (const [n, entry] of [[53, null], [54, "review"], [55, "fixup"]] as const) {
      await (await (await (await w.pr(n)).review(n, { sure: false })).verified(n)).premerge(n, "clean");
      if (entry) await w.workflow(n, { entry, approved: false });
      assert.ok(!(await kindsOf(w, n)).some((k) => k.startsWith("merge")), `${entry}: ${(await kindsOf(w, n)).join()}`);
    }

    await again({ sure: 0, verdict: "take-fix", fixes: JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]) });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 50))?.state, "review");
    const kinds = await kindsOf(w, 50);
    assert.ok(kinds.includes("fixup:review") && !kinds.some((k) => k.startsWith("merge")), kinds.join());
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 50, from_head: "sha50b", to_head: "sha50c", state: "pushed", attempt: 2, created_at: T0, source: "review" }));
    await w.synced(50, "sha50c");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 50))!;
    assert.deepEqual([p.state, p.head], ["review", "sha50c"]);
  });

  test("a queued PR leaves the queue for a failed verification, and not for a transient refusal, a batch or a running merge", async () => {
    const w = await (await take(await fresh(), 51)).review(51, { verdict: "take-fix" });
    await inCi(w, 51);
    await (await w.premerge(51, "clean")).verified(51);
    await settle(w);
    const state = async () => { await settle(w); return (await preapprovalOf(w.db, "app", 51))?.state; };
    await w.db.run(w.db.k.insertInto("merges").values({ repo: "app", number: 51, head_oid: "sha51b", run_id: "r", at: new Date(Date.now() + 1000).toISOString(), path: "operator", method: "squash", outcome: "refused", reason: "safe-merge: HTTP 502 bad gateway", ci: "success", mergeable: "MERGEABLE" }));
    assert.equal(await state(), "queued");
    assert.ok((await kindsOf(w, 51)).some((k) => k.startsWith("merge")), "a transient refusal is tried again");

    await w.db.run(w.db.k.updateTable("verifications").set({ state: "failed", finished_at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", 51));
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 5, repo: "app", branch: "integration-app-1", state: "open", base_sha: "b", commit_sha: "t", created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: 5, number: 51, head_oid: "sha51b", position: 1 }));
    assert.equal(await state(), "queued", "in a batch");
    await w.db.run(w.db.k.updateTable("merge_batches").set({ state: "superseded" }));
    const job = (await w.db.get(w.db.k.insertInto("jobs").values({ step: "merge", params: "{}", requested_by: "pipeline", requested_at: T0, state: "running", repo: "app" }).returning("id")))!;
    assert.equal(await state(), "queued", "a merge of the repo runs");
    await w.db.run(w.db.k.updateTable("jobs").set({ state: "done" }).where("id", "=", job.id));
    assert.equal(await state(), "failed");
    assert.match((await preapprovalOf(w.db, "app", 51))!.reason!, /verification failed/);
  });

  test("a leg on a draft waits where it is until the PR is ready for review", async () => {
    const w = await (await take(await fresh(), 56)).review(56, { verdict: "take-fix" });
    await inCi(w, 56);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ is_draft: 1, overall: "failure" }).where("number", "=", 56));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 56))?.state, "ci");
    assert.equal((await w.prPlan(56)).wait, "the pull request to be marked ready for review");
    await w.db.run(w.db.k.updateTable("pr_checks").set({ is_draft: 0, overall: "success" }).where("number", "=", 56));
    await w.premerge(56, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 56))?.state, "queued");
  });

  test("red CI on an optional check only does not stop the leg, and approved runs that have not finished hold it", async () => {
    const w = await (await take(await fresh(), 52)).review(52, { verdict: "take-fix" });
    await inCi(w, 52);
    await w.premerge(52, "clean");
    await setOptionalCheck(w.db, OPERATOR, "app", "docs", true);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "docs", state: "failure" }, { name: CHECK, state: "success" }]) }).where("number", "=", 52));
    await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 52, head_oid: "sha52b", runs: "[]", approved: "[7]", failed: "{}", checked_at: new Date().toISOString(), approved_at: new Date().toISOString() }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 52))?.state, "ci");
    await w.db.run(w.db.k.updateTable("ci_run_approvals").set({ approved: "[]" }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 52))?.state, "queued");
  });

  test("an operator fix-up stored for linting is planned for its lint check, and a dropped one ends the request instead of looping", async () => {
    const w = await take(await take(await fresh(), 11), 12);
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

  test("a fix-up request without merge ends when the head moves, and a pre-approval whose fix-up cannot run fails with the reason", async () => {
    const w = await (await take(await (await fresh()).pr(13), 14)).review(14, { verdict: "take-fix" });
    await start(w, 13, false);
    await w.synced(13, "moved13");
    await settle(w);
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 13"))[0]!.state, "ended");

    await start(w, 14);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ mergeable: "CONFLICTING" }).where("number", "=", 14));
    await settle(w);
    const p = await preapprovalOf(w.db, "app", 14);
    assert.equal(p?.state, "failed");
    assert.match(p!.reason!, /cannot run: the PR conflicts/);
  });

  test("a pass over the legs in the merge queue reads as much for many as for few", async () => {
    await expectFlat(async (size) => {
      const w = await (await (await world()).repo()).acting();
      for (let n = 1; n <= size; n++) await (await (await (await take(w, n)).review(n)).premerge(n, "clean")).handedOver(n);
      return {
        db: w.db, close: async () => w.close(),
        run: async () => {
          await advancePreapprovals(w.db);
          assert.deepEqual(await w.rows("SELECT DISTINCT state FROM preapprovals"), [{ state: "queued" }]);
        },
      };
    }, 2, 12);
  });

  test("a cancel is refused while a merge job runs, and a merge that lands after a cancel turns the row into merged", async () => {
    const w = await (await take(await fresh(), 15)).review(15, { verdict: "take-fix" });
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
    const w = await (await take(await fresh(), 40)).review(40, { verdict: "take-fix" });
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

  test("the pipeline's own CI fix push carries the pre-approval to its head, and a foreign push ends it", async () => {
    const w = await (await take(await (await take(await fresh(), 16)).review(16, { verdict: "take-fix" }), 17)).review(17, { verdict: "take-fix" });
    await inCi(w, 16);
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 16, head: "sha16b", to_head: "sha16c", kind: "format", state: "pushed", attempt: 1, created_at: T0 }));
    await w.synced(16, "sha16c");
    await settle(w);
    assert.deepEqual([(await preapprovalOf(w.db, "app", 16))?.state, (await preapprovalOf(w.db, "app", 16))?.head], ["review", "sha16c"]);

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
    const w = await (await take(await fresh(), 19)).review(19, { verdict: "take-fix" });
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
    const w = await take(await fresh(), 13);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "pending" }).where("number", "=", 13));
    await preapproveMerge(w.db, { repo: "app", number: 13, by: OPERATOR });
    assert.equal((await (await reviewHolds(w.db))("app", 13, "sha13"))?.kind, "ci");
  });

  test("an unsure take-fix review goes to the pipeline's fix-up, whose push is reviewed again, and an unsure take of it goes on", async () => {
    const w = await take(await fresh(), 12);
    await preapproveMerge(w.db, { repo: "app", number: 12, by: OPERATOR });
    await w.review(12, { head: "sha12", verdict: "take-fix", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "review");
    assert.ok((await kindsOf(w, 12)).includes("fixup:review"), (await kindsOf(w, 12)).join());
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 12, from_head: "sha12", to_head: "sha12b", state: "pushed", attempt: 1, created_at: T0, source: "review" }));
    await w.synced(12, "sha12b");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 12))!;
    assert.deepEqual([p.state, p.head], ["review", "sha12b"]);
    await w.review(12, { head: "sha12b", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "ci");
  });

  test("the label does not stop it: a plugin candidate or an unclassified PR is reviewed, and a label settled later does not flip it out", async () => {
    const w = await (await (await (await (await fresh()).pr(16, { label: "plugin candidate" })).pr(17)).pr(18, { label: "plugin candidate" })).workflow(18);
    await w.db.run(w.db.k.deleteFrom("classifications").where("number", "=", 17));
    for (const n of [16, 17]) {
      assert.ok(!(await kindsOf(w, n)).includes("review:"), (await kindsOf(w, n)).join());
      await w.workflow(n);
      await preapproveMerge(w.db, { repo: "app", number: n, by: OPERATOR });
      await settle(w);
      assert.equal((await preapprovalOf(w.db, "app", n))?.state, "review");
      assert.ok((await kindsOf(w, n)).includes("review:"), (await kindsOf(w, n)).join());
    }
    // A draft still refuses it.
    await w.db.run(w.db.k.updateTable("pr_checks").set({ is_draft: 1 }).where("number", "=", 18));
    await assert.rejects(async () => await preapproveMerge(w.db, { repo: "app", number: 18, by: OPERATOR }), /it is a draft/);
    await w.db.run(w.db.k.insertInto("classifications").values({ repo: "app", number: 17, classifier: "jev", run_id: "r1", at: T0, type_label: "plugin candidate", flags: "[]", probs: '{"top":0.95}' }));
    await w.review(17, { head: "sha17" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "ci");
    await w.premerge(17, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "queued");
  });

  test("a row no workflow owns waits for one to start on its PR, and is the workflow's leg from then on", async () => {
    const w = await (await fresh()).pr(20);
    await assert.rejects(preapproveMerge(w.db, { repo: "app", number: 20, by: OPERATOR }), /is not started/);
    await w.db.run(w.db.k.insertInto("preapprovals").values({ repo: "app", number: 20, by: OPERATOR, at: T0, instructions: "", state: "review", from_head: "sha20", head: "sha20", updated_at: T0, fix_id: null, workflow_id: null }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 20))?.state, "review");
    await w.workflow(20);
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 20))?.state, "review");
    await w.db.run(w.db.k.updateTable("item_workflows").set({ state: "stopped" }).where("number", "=", 20));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 20))?.state, "cancelled");
  });

  test("the queue row says who added the PR and how; viewers see no login", async () => {
    const w = await (await take(await fresh(), 14)).pr(15);
    await preapproveMerge(w.db, { repo: "app", number: 14, by: OPERATOR });
    const entry = (number: number) => ({ repo: "app", number, reviewedAt: T0 }) as unknown as CachedEntry;
    const facts = { legs: (await loadLegPass(w.db)).rows, carried: new Map() };
    const staff = queueOriginOf(facts, true);
    assert.deepEqual({ ...staff(entry(14)), at: null }, { how: "queued", by: OPERATOR, at: null });
    assert.equal(queueOriginOf(facts, false)(entry(14)).by, null);
    assert.deepEqual(staff(entry(15)), { how: "review", by: null, at: T0 });
  });

  test("the Merge tab lists a queued PR before its take review, and drops it once the review makes it a queue row", async () => {
    const w = await take(await fresh(), 16);
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

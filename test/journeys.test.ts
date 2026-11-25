// Journeys: a PR or issue goes through the real planner pass, the real executors and the real guard, with GitHub and the
// models faked (test/world-db.ts). Each test asserts outcomes: rows in the database and the writes that reached GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { withConfig } from "../src/data/control/index.ts";
import { MAINTAINER_ANSWER_WAIT } from "../src/core/decide.ts";
import { CLI_BY, gates } from "../src/core/gates.ts";
import { guard, guardItem, guardRepo, liveOf } from "../src/core/guard.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { implementMay, implementRefusal } from "../src/implement/gate.ts";
import { computeLiveness } from "../src/liveness.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runCifix, type CifixDeps } from "../src/cifix/index.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { selectFixups } from "../src/fixup/select.ts";
import type { Querier } from "../src/mirror.ts";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { setFeature } from "../src/build/features.ts";
import { runAct } from "../src/act/index.ts";
import { runBatches } from "../src/merge/batch.ts";
import { runMerge } from "../src/merge/index.ts";
import { runSingles } from "../src/merge/single.ts";
import { refreshChecks } from "../src/review/checks.ts";
import { prepareOpusInput, saveOpus, type OpusDeps } from "../src/review/opus.ts";
import { premergeCandidates, runPremerge, type PremergeDeps } from "../src/premerge/review.ts";
import { savePremerge } from "../src/premerge/store.ts";
import type { LaneDeps } from "../src/github/user-lane.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { checkRequest } from "../src/runner/jobs.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { CHECK, OPERATOR, T1, tmpdir, world, type World } from "./world-db.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { excluded } from "../src/db/kx.ts";
import * as kx from "../src/db/kx.ts";

process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("diffs"), "cache");

const quiet = () => {};
let current: World | null = null;
const fresh = async (): Promise<World> => (current = await (await world()).repo());
afterEach(() => current?.close());

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
const premergeDeps: PremergeDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), model: "opus", maxChars: 120_000 };
const premergeReply = (n: number) => JSON.stringify({ ref: `app#${n}`, findings: [], searched: "callers" });
const merged = async (w: World) => await w.db.all(w.db.k.selectFrom("merges").select(["number", "head_oid", "outcome"]).orderBy("number"));

describe("PR journeys", () => {
  test("a whitelisted bugfix PR goes from review to merge, and the merge gets the reviewed head", async () => {
    const w = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).models(() => premergeReply(1));
    assert.equal((await w.prPlan(1)).state, "waiting-premerge");
    const s = await runPremerge(w.db, { repo: "app" }, quiet, premergeDeps);
    assert.equal(s.reviewed, 1);
    assert.equal((await w.prPlan(1)).state, "ready");

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
    assert.deepEqual(await merged(w), [{ number: 1, head_oid: "sha1", outcome: "merged" }]);
    assert.equal((await w.prPlan(1)).state, "merged");
  });

  test("both Opus inputs carry the open items that mention the PR's files; the pre-merge input also carries the first review", async () => {
    const w = await (await (await (await fresh()).pr(1)).review(1)).issue(9, { title: "Dropping a file still replaces the frame", body: "Seen in src/lib.rs" });
    const deps: OpusDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }), model: "opus", maxChars: 120_000 };
    const c = { repo: "app", number: 1, title: "PR 1", body: "b", author_association: null, head_oid: "sha1", lines_changed: 20, size: "S" as const, score: null };
    for (const independent of [false, true]) {
      const p = await prepareOpusInput(w.db, "app", c, deps, quiet, { independent });
      assert.equal(p.kind, "ready");
      if (p.kind !== "ready") continue;
      assert.deepEqual(p.input.related_open?.map((r) => [r.number, r.state]), [[9, "open"]]);
      assert.equal(p.input.review_history !== undefined, independent);
    }
  });

  test("a head that moves after the plan is refused, by the merge step and by the guard", async () => {
    const w = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    assert.equal((await w.prPlan(1)).actions[0]!.kind, "merge");
    w.gh.live(1, { head: "sha1-moved" });

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.equal(w.gh.writesOf("merge").length, 0);

    const g = await guard(w.db, { repo: "app", number: 1 }, { kind: "merge", head: "sha1" }, CLI_BY, liveOf(w.db, w.gh.querier));
    assert.ok("refused" in g && /head moved/.test(g.refused), JSON.stringify(g));
    assert.equal(w.gh.writesOf("merge").length, 0);
  });

  test("an unsure review of a started PR comes back with a recommendation; answered with merge, it is reviewed again and merged as the person who answered", async () => {
    const w = await (await (await (await (await (await fresh()).acting("mira")).pr(1)).workflow(1, { by: "mira", approved: false })).review(1, { sure: false })).verified(1);
    await w.premerge(1, "clean");
    const lane: LaneDeps = { vault: { userToken: async (login) => ({ ok: true, access: login === "mira" ? "user-token" : "other" }) }, permission: async () => "write" };
    const tokens: (string | undefined)[] = [];
    const deps = w.gh.mergeDeps();
    const run: typeof deps.run = async (cmd, args, env) => { tokens.push(env?.GH_TOKEN); return await deps.run(cmd, args, env); };
    const merge = () => runMerge(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, { ...deps, run, lane });
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 1))?.state, "recommending");
    assert.deepEqual((await merge()).merged, []);
    assert.deepEqual(w.gh.writes, []);

    const answer = await runCommand(w.db, { login: "mira", canWrite: async () => true }, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] });
    assert.equal(answer.items[0]!.outcome, "run", answer.lines.join());
    const advance = async () => { for (let i = 0; i < 3; i++) { await advanceWorkflows(w.db); await advancePreapprovals(w.db); } };
    await advance();
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => a.kind), ["review"]);
    assert.deepEqual((await merge()).merged, []);
    // The review is unsure again: the approval carries it on.
    await saveOpus(w.db, "rv2", { repo: "app", number: 1, head_oid: "sha1" }, {
      mode: "full", base: null, model: "m",
      review: { ref: "app#1", verdict: "take", sure: false, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] },
    });
    await w.premerge(1, "clean");
    await advance();
    assert.deepEqual((await merge()).merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
    assert.deepEqual(tokens, ["user-token"], "the merge ran with the token of the person who answered");
  });

  test("a PR a person stopped is not merged by the rule", async () => {
    const w = await (await (await (await (await (await fresh()).acting()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    assert.equal((await w.prPlan(1)).state, "ready");
    await w.workflow(1, { approved: false });
    const r = await runCommand(w.db, { login: OPERATOR, canWrite: async () => true }, "dashboard", { parsed: parse("stop"), items: [{ repo: "app", number: 1 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join());
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
  });

  test("with the pipeline switched off the pipeline's own run writes nothing", async () => {
    const w = await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pipeline(false);
    const m = await runMerge(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
    assert.deepEqual(await merged(w), []);
    // An operator's own run is not stopped by the switch.
    assert.deepEqual((await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps())).merged, ["app#1"]);
  });

  test("a batch of two PRs is built, published as one PR and lands together", async () => {
    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    const deps = w.gh.batchDeps();
    const built = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.equal(built.published.length, 1);
    assert.deepEqual(w.gh.writesOf("pr").map((x) => x.number), [900]);
    assert.deepEqual((await w.prPlan(1)).state, "in-batch");
    assert.deepEqual((await w.prPlan(2)).state, "in-batch");
    assert.ok(!(await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.params?.singleOnly), "a member is not merged alone");

    const done = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.deepEqual(done.merged, [1, 2]);
    // Only the batch PR was merged, at the tip that was pushed; the members got merge records.
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.number), [900]);
    assert.equal(w.gh.writesOf("merge")[0]!.head, w.gh.writesOf("push")[0]!.head);
    assert.deepEqual((await merged(w)).map((r) => [r.number, r.head_oid, r.outcome]), [[1, "sha1", "merged"], [2, "sha2", "merged"]]);
  });

  test("the batch PR's runs are approved at the batch tip when people started its members in a repo whose pipeline is off", async () => {
    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    await runBatches(w.db, { repo: "app" }, quiet, w.gh.batchDeps());
    const tip = (await w.db.get(w.db.k.selectFrom("merge_batches").select("commit_sha as c").where("pr_number", "=", 900)))!.c;
    await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 900, head_oid: tip, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: "2026-01-02T00:00:00Z" }));
    await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 900, kind: "pr", state: "OPEN", title: "batch", author: "bot", additions: 1, deletions: 0,
      head_oid: "mirror-lag", head_ref: "batch", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    const plan = async () => await w.prPlan(900);
    assert.deepEqual((await plan()).actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
    await w.db.run(w.db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
    assert.equal((await plan()).state, "out-of-scope");
    for (const n of [1, 2]) await w.workflow(n);
    assert.deepEqual((await plan()).actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
  });

  test("the batch PR's runs are approved for members approved for merge without a take review: a merge entry, and one answered past a hold", async () => {
    const w = await (await (await (await (await (await fresh()).acting()).pr(1)).pr(2)).pr(3)).review(1);
    await w.review(3, { verdict: "hold" });
    await (await w.workflow(2, { entry: "merge" })).workflow(3);
    for (const n of [1, 2, 3]) await (await w.verified(n)).premerge(n, "clean");
    for (const n of [2, 3]) await w.handedOver(n);
    await runBatches(w.db, { repo: "app" }, quiet, w.gh.batchDeps());
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").orderBy("number"))).map((x) => Number(x.number)), [1, 2, 3]);
    // The batch PR is open (the app identity of this world cannot open it).
    await w.db.run(w.db.k.updateTable("merge_batches").set({ state: "open", pr_number: 900, fork: "bot/app" }));
    const tip = (await w.db.get(w.db.k.selectFrom("merge_batches").select("commit_sha as c").where("pr_number", "=", 900)))!.c;
    await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 900, head_oid: tip, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: "2026-01-02T00:00:00Z" }));
    await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 900, kind: "pr", state: "OPEN", title: "batch", author: "bot", additions: 1, deletions: 0,
      head_oid: tip, head_ref: "batch", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    const approves = async () => (await w.prPlan(900)).actions.some((a) => a.kind === "approve-ci");
    assert.equal(await approves(), true);
    const findings = (await w.db.get(w.db.k.selectFrom("premerge_reviews").select("findings").where("number", "=", 2)))!.findings;
    await w.premerge(2, "defect");
    assert.equal(await approves(), false, "a defect of the pre-merge review");
    await w.db.run(w.db.k.updateTable("premerge_reviews").set({ findings }).where("number", "=", 2));
    assert.equal(await approves(), true);
    await w.db.run(w.db.k.updateTable("preapprovals").set({ state: "cancelled" }).where("number", "=", 3));
    assert.equal(await approves(), false, "a member whose approval for merge no longer stands");
  });

  test("a draft is not merged, alone or in a batch, and no refusal is recorded; it goes on once it is ready for review", async () => {
    const one = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    one.gh.live(1, { draft: true });
    const merge = async () => await runMerge(one.db, { repo: "app", dryRun: false }, quiet, one.gh.mergeDeps());
    assert.deepEqual((await merge()).merged, []);
    assert.deepEqual(await one.rows("SELECT * FROM merges"), []);
    const plan = await one.prPlan(1);
    assert.deepEqual([plan.state, plan.waitKind, plan.actions.map((a) => a.kind)], ["draft", "contributor", []]);
    one.gh.live(1, { draft: false });
    await refreshChecks(one.db, one.gh.querier, "app", [1]);
    assert.deepEqual((await merge()).merged, ["app#1"]);

    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    const deps = w.gh.batchDeps();
    assert.equal((await runBatches(w.db, { repo: "app" }, quiet, deps)).published.length, 1);
    w.gh.live(2, { draft: true });
    const done = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.deepEqual([done.merged, done.superseded.length], [[], 1]);
    const newest = (await w.db.get(w.db.k.selectFrom("merge_batches").select(["id", "state"]).orderBy("id", "desc").limit(1)))!;
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", newest.id))).map((x) => Number(x.number)), [1]);
    assert.deepEqual(w.gh.writesOf("merge"), []);
  });

  test("a take-fix patch is linted before the push: clippy findings go back to the model, the clean patch is pushed with the format changes folded in", async () => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["fixup", "fix", git.head]]);
    const edit = (to: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n${to}`;
    const asked: { previous?: { findings: string[] } }[] = [];
    const deps = git.deps(w);
    deps.ask = async (_db, input) => {
      asked.push(input[0] as (typeof asked)[number]);
      return asked.length === 1 ? git.patch : edit("+fn b() {  }\n+fn main() { b(); }\n");
    };

    // Round 1: the patch is stored, not pushed.
    const first = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(first.pushed, []);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round", "lint_state"])), [{ state: "linting", lint_round: 1, lint_state: "pending" }]);
    assert.deepEqual((await w.prPlan(1)).actions, []);
    const t1 = (await w.rows("SELECT id, state FROM build_tasks"))[0] as { id: number; state: string };
    assert.equal(t1.state, "queued");

    // Clippy finds something on a line the patch changed: the model is asked again with the finding.
    await endLint(w, t1.id, { diagnostics: [{ line: 1 }] });
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["lint", "fixup"]]);
    const second = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(second.pushed, []);
    assert.equal(asked.length, 2);
    assert.match(asked[1]!.previous!.findings[0]!, /needless at line 1/);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round"])), [{ state: "linting", lint_round: 2 }]);

    // Round 2 is clean; rustfmt wants `{}`: one push whose commit has the format change.
    const t2 = ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;
    assert.notEqual(t2, t1.id);
    await endLint(w, t2, { format: "diff -uN a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\t2026-01-01\n+++ b/src/lib.rs\t2026-01-01\n@@ -1,2 +1,2 @@\n-fn b() {  }\n+fn b() {}\n fn main() { b(); }\n" });
    const third = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(third.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.equal(sh(git.fork, "show", `${pushed}:src/lib.rs`), "fn b() {}\nfn main() { b(); }");
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "from_head", "to_head"])), [{ state: "pushed", from_head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("comment").length, 1);

    // Sync sees the new head; it is reviewed, verified and pre-merge reviewed like any head.
    await w.synced(1, pushed);
    assert.equal((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), false);
    await (await (await w.review(1, { head: pushed })).verified(1)).premerge(1, "clean");
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.head), [pushed]);
  });
});

describe("lint findings resume the patch session", () => {
  const edit = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
  /** Round 1 stores the patch and its session; clippy finds something; round 2 runs `minutes` later. */
  const second = async (minutes: number) => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    const deps = git.deps(w);
    let clock = Date.parse(T1);
    deps.now = () => new Date(clock);
    const stores = [tmpdir("session-a"), tmpdir("session-b")];
    const asked: { previous?: unknown; resume?: { session: { id: string }; message: string } }[] = [];
    deps.ask = async (_db, input, _checkout, _tool, session) => {
      const n = asked.push({ previous: (input[0] as { previous?: unknown }).previous, resume: session?.resume });
      session!.kept = { id: `s${n}`, dir: stores[session?.resume ? 0 : n - 1]!, account: "a", checkout: "/c" };
      return n === 1 ? git.patch : edit;
    };
    await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    const stored = async () => JSON.parse((await w.db.get(w.db.k.selectFrom("fixups").select("session")))!.session!) as Record<string, { id: string; dir: string }>;
    assert.equal((await stored())[""]!.id, "s1");
    await endLint(w, ((await w.rows("SELECT id FROM build_tasks"))[0] as { id: number }).id, { diagnostics: [{ line: 1 }] });
    clock += minutes * 60_000;
    await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    return { asked, stored, stores };
  };

  test("findings within 60 minutes continue the stored session with the findings", async () => {
    const { asked, stored, stores } = await second(59);
    assert.equal(asked[1]!.resume!.session.id, "s1");
    assert.match(asked[1]!.resume!.message, /needless at line 1/);
    assert.equal((await stored())[""]!.dir, stores[0]);
    assert.equal(existsSync(stores[0]!), true);
  });

  test("findings after 60 minutes start a new call with the earlier patch, and the old session is removed", async () => {
    const { asked, stored, stores } = await second(61);
    assert.equal(asked[1]!.resume, undefined);
    assert.match(JSON.stringify(asked[1]!.previous), /needless at line 1/);
    assert.equal((await stored())[""]!.id, "s2");
    assert.equal(existsSync(stores[0]!), false);
    assert.equal(existsSync(stores[1]!), true);
  });
});

describe("conflict resolution lint", () => {
  const resolved = (line: string) => JSON.stringify({ sections: [{ id: 1, content: line }] });
  const setup = async () => {
    const git = gitWorld(1, undefined, true);
    const w = await (await (await (await fresh()).pr(1, { head: git.head, mergeable: "CONFLICTING" })).review(1, { verdict: "take" })).verified(1);
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("repo", "=", "app").where("number", "=", 1));
    const deps = git.deps(w);
    const asked: { previous?: { findings: string[] } }[] = [];
    const answers = ["// both\nfn main() { a(); b(); }\n", "// both\nfn main() { a(); a(); }\n"];
    deps.resolve = async (_db, input) => { asked.push(input[0] as (typeof asked)[number]); return resolved(answers[asked.length - 1]!); };
    return { git, w, deps, asked };
  };
  const run = (w: World, deps: FixupDeps) => runFixup(w.db, { repo: "app", dryRun: false }, process.env.DBG ? console.log : quiet, deps);
  const lastTask = async (w: World) => ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;

  test("clippy findings on a resolution go back to the model; the clean second resolution is merged in", async () => {
    const { git, w, deps, asked } = await setup();
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["conflict", "merge"]]);
    assert.deepEqual((await run(w, deps)).pushed, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "lint_round"])), [{ state: "linting", lint_round: 1 }]);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["lint", "conflict"]]);

    assert.deepEqual((await run(w, deps)).pushed, []);
    assert.equal(asked.length, 2);
    assert.match(asked[1]!.previous!.findings[0]!, /needless at line 2/);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "lint_round"])), [{ state: "linting", lint_round: 2 }]);

    await endLint(w, await lastTask(w));
    assert.deepEqual((await run(w, deps)).pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.equal(sh(git.fork, "show", `${pushed}:src/lib.rs`), "fn a() {}\n// both\nfn main() { a(); a(); }");
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "to_head"])), [{ state: "merged", to_head: pushed }]);
  });

  test("findings after the second lint round fail the try with the reason", async () => {
    const { git, w, deps, asked } = await setup();
    await run(w, deps);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    await run(w, deps);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    const s = await run(w, deps);
    assert.deepEqual(s.pushed, []);
    assert.equal(asked.length, 2);
    assert.deepEqual(git.pushes, []);
    const row = (await w.db.get(w.db.k.selectFrom("conflict_merges").select(["state", "reason"])))!;
    assert.equal(row.state, "rejected");
    assert.match(row.reason!, /clippy findings remain after 2 rounds: needless/);
  });
});

describe("patch model build tool", () => {
  test("the model checks its patch with clippy, fixes the finding and re-checks; the harness's lint then passes on the first round", async () => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    const dirty = git.patch.replace("+fn b() {}\n", "+fn b() { return; }\n");
    assert.notEqual(dirty, git.patch);
    const deps = git.deps(w);
    const outcomes: string[] = [];
    let asked = 0;
    // The fake worker: a queued task of a patch with `return;` has a clippy finding on line 1, any other is clean.
    let busy = false;
    const worker = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const t of await w.rows("SELECT id, patch FROM build_tasks WHERE state = 'queued'") as { id: number; patch: string }[]) await endLint(w, t.id, { diagnostics: t.patch.includes("return;") ? [{ line: 1 }] : [] });
      } finally {
        busy = false;
      }
    }, 5);
    deps.ask = async (_db, _input, _checkout, tool) => {
      asked++;
      tool!.pollMs = 5;
      const first = await tool!.run({ patch: dirty, command: "clippy" }, null);
      outcomes.push(first.text);
      const second = await tool!.run({ patch: git.patch, command: "clippy" }, null);
      outcomes.push(second.text);
      clearInterval(worker);
      return git.patch;
    };
    const first = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps).finally(() => clearInterval(worker));
    assert.equal(asked, 1);
    assert.match(outcomes[0]!, /clippy: 1 finding/);
    assert.match(outcomes[1]!, /clippy: 0 findings/);
    assert.deepEqual(await w.rows("SELECT step, command, outcome FROM model_checks ORDER BY id"), [
      { step: "fixup", command: "clippy", outcome: "1 finding" }, { step: "fixup", command: "clippy", outcome: "0 findings" },
    ]);

    // The harness's own lint task is the third task; it is clean, so the first round pushes.
    assert.deepEqual(first.pushed, []);
    const lint = ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;
    assert.equal(((await w.rows("SELECT COUNT(*) AS n FROM build_tasks"))[0] as { n: number }).n, 3);
    await endLint(w, lint);
    const second = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(second.pushed, ["app#1"]);
    assert.equal(asked, 1);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round"])), [{ state: "pushed", lint_round: 1 }]);
  });
});

describe("CI fix journey", () => {
  test("a PR whose CI fails gets a fix pushed to its branch for the reviewed head", async () => {
    const git = gitWorld(1, "fn a() {}\nfn main() { b(); }\n");
    const w = await (await (await fresh()).pr(1, { head: git.head, ci: "failure" })).review(1);
    await reportingTaskRunner(w.db);
    assert.equal((await w.prPlan(1)).state, "ci-failed");
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["cifix", "work", git.head]]);

    const s0 = await runCifix(w.db, { repo: "app", dryRun: false }, quiet, git.cifixDeps(w));
    assert.deepEqual(s0.pushed, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("ci_fixes").select("state")), [{ state: "linting" }]);
    await endLint(w, ((await w.rows("SELECT id FROM build_tasks"))[0] as { id: number }).id);
    const s = await runCifix(w.db, { repo: "app", dryRun: false }, quiet, git.cifixDeps(w));
    assert.deepEqual(s.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.notEqual(pushed, git.head);
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("ci_fixes").select(["kind", "state", "head", "to_head"])), [{ kind: "code", state: "pushed", head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("merge").length, 0);
  });
});

/** The sandbox finished a lint task: the formatter's diff (if it changed anything) and clippy's JSON lines come back as artifacts. */
describe("a repo with no step approvals", () => {
  /** No approvals; `mira` and the operator may act. The Task Runner takes every call. */
  const unapproved = async (): Promise<World> => {
    current = await (await (await world()).repo(["merge", "push", "comment", "ci", "fixissue"])).acting("mira", OPERATOR);
    await reportingTaskRunner(current.db);
    return current;
  };
  const say = async (w: World, text: string, n: number, login = "mira") => {
    const r = await runCommand(w.db, { login, canWrite: async () => true }, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: n }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join());
    for (let i = 0; i < 3; i++) { await advanceWorkflows(w.db); await advancePreapprovals(w.db); }
  };
  /** The jobs the lane proposes, each taken by the queue's own check. */
  const jobs = async (w: World, lane: string): Promise<string[]> => {
    const found = await LANES.find((l) => l.name === lane)!.detect(w.db, await planCtx(w.db));
    for (const c of found) await checkRequest(w.db, c.step, c.params);
    return found.map((c) => c.step);
  };
  const actions = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => [a.kind, a.params?.bucket, a.params?.source].filter(Boolean).join(":"));
  /** Pushes go out as the box account in these fakes; the app has no keys here. */
  const boxWrites = async (w: World) => void await w.db.run(w.db.k.deleteFrom("settings").where("key", "=", "github_identity"));
  const lastTask = async (w: World) => ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;

  test("a merge a person started runs as them; a PR nobody started is left alone, also when the same job works the repo", async () => {
    const w = await unapproved();
    // #1 nobody started: ready by the rule. #2 is started.
    for (const n of [1, 2]) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
    assert.equal((await w.prPlan(1)).state, "ready");
    assert.deepEqual(await jobs(w, "merge"), []);
    await say(w, "merge", 2);
    assert.deepEqual(await actions(w, 2), ["merge"]);
    assert.deepEqual(await jobs(w, "merge"), ["merge"]);
    const lane: LaneDeps = { vault: { userToken: async () => ({ ok: true, access: "token" }) }, permission: async () => "write" };
    const s = await runSingles(w.db, { repo: "app", by: "pipeline" }, quiet, { ...w.gh.mergeDeps(), lane }, async () => ({ ok: true, text: DIFF }));
    assert.deepEqual(s?.merged, ["app#2"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.number), [2]);
    assert.deepEqual(await jobs(w, "merge"), []);
  });

  test("the checks of a merge a person started are read again while its CI runs; a PR nobody started is not polled", async () => {
    const w = await unapproved();
    await (await w.pr(1, { ci: "pending" })).review(1);
    assert.equal((await w.prPlan(1)).state, "waiting-ci");
    assert.deepEqual(await jobs(w, "merge"), []);
    await say(w, "merge", 1);
    assert.equal((await w.prPlan(1)).state, "waiting-ci");
    assert.deepEqual(await jobs(w, "merge"), ["checks"]);
  });

  test("the failed pre-merge review of an approved PR wakes the planner for its retry", async () => {
    const w = await unapproved();
    await (await (await w.pr(1)).review(1)).verified(1);
    await w.workflow(1, { by: "mira" });
    const at = Date.now();
    await savePremerge(w.db, { repo: "app", number: 1, head: "sha1", at: new Date(at).toISOString(), runId: "pm", error: "retry: no answer" });
    const wake: number[] = [];
    assert.deepEqual(await premergeCandidates(w.db, { repo: "app", at, wake }), []);
    assert.equal(wake.length, 1);
    assert.deepEqual((await premergeCandidates(w.db, { repo: "app", at: wake[0]! })).map((c) => c.number), [1]);
  });

  test("a person's fix-up is pushed; the review fixes of a PR nobody started are not", async () => {
    const git = gitWorld(2);
    const w = await unapproved();
    await (await w.pr(1)).review(1, { verdict: "take-fix" });
    await (await w.pr(2, { head: git.head })).review(2, { verdict: "take-fix" });
    assert.deepEqual(await jobs(w, "fixup"), []);
    await say(w, "fix-up", 2);
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ at: new Date().toISOString() }).where("number", "=", 2));
    assert.deepEqual((await actions(w, 2)).filter((a) => a.startsWith("fixup")), ["fixup:fix:review"]);
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    await boxWrites(w);
    await runFixup(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.deps(w));
    await endLint(w, await lastTask(w));
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    const s = await runFixup(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.deps(w));
    assert.deepEqual(s.pushed, ["app#2"]);
    assert.deepEqual(git.pushes.map((p) => p.lease), [git.head]);
  });

  test("the CI fix of an approved PR is pushed; the red CI of a PR nobody started is left alone", async () => {
    const git = gitWorld(2, "fn a() {}\nfn main() { b(); }\n");
    const w = await unapproved();
    await (await w.pr(1, { ci: "failure" })).review(1);
    await (await w.pr(2, { head: git.head, ci: "failure" })).review(2);
    assert.deepEqual(await jobs(w, "cifix"), []);
    assert.deepEqual([(await w.prPlan(1)).wait, (await w.prPlan(1)).waitKind], ["push approval for the repo", "person"]);
    await say(w, "merge", 2);
    assert.deepEqual(await actions(w, 2), ["cifix:work"]);
    assert.deepEqual(await jobs(w, "cifix"), ["cifix"]);
    await boxWrites(w);
    await runCifix(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.cifixDeps(w));
    await endLint(w, await lastTask(w));
    assert.deepEqual(await jobs(w, "cifix"), ["cifix"]);
    const s = await runCifix(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.cifixDeps(w));
    assert.deepEqual(s.pushed, ["app#2"]);
  });

  test("the base is merged into a conflicting PR that was queued without a review, and its pre-merge fix-up is worked", async () => {
    const git = gitWorld(2, undefined, true);
    const w = await unapproved();
    await w.pr(2, { head: git.head, mergeable: "CONFLICTING" });
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("number", "=", 2));
    await say(w, "merge", 2);
    assert.deepEqual((await actions(w, 2)).filter((a) => a !== "verify:plan"), ["conflict:merge"]);
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    assert.equal((await selectFixups(w.db, "app")).conflictMerge.length, 1);

    await (await (await (await w.pr(3)).review(3)).verified(3)).premerge(3, "defect");
    await w.workflow(3, { by: "mira" });
    assert.deepEqual(await actions(w, 3), ["fixup:fix:premerge"]);
    assert.deepEqual((await selectFixups(w.db, "app")).fix.map((c) => [c.number, c.source]), [[3, "premerge"]]);
  });

  test("a person's implement command reaches its job; an issue nobody queued does not, and the implementation's PR is revised on the command", async () => {
    const w = await unapproved();
    await setFeature(w.db, "implement", true, OPERATOR, "app");
    await (await w.issue(4)).issue(5);
    assert.deepEqual(await jobs(w, "implement"), []);
    assert.match(await implementRefusal(w.db, "app", 5) ?? "", /not queued/);
    await say(w, "implement", 5);
    const found = await LANES.find((l) => l.name === "implement")!.detect(w.db, await planCtx(w.db));
    assert.deepEqual(found.map((c) => [c.step, c.params.number, c.params.bucket]), [["implement", 5, "plan"]]);
    await checkRequest(w.db, found[0]!.step, found[0]!.params);
    const grant = async (n: number) => await guardItem(w.db, { repo: "app", number: n }, { kind: "implement", bucket: "plan" }, "pipeline");
    assert.ok(!("refused" in await grant(5)));
    assert.match((await grant(4) as { refused: string }).refused, /issue is not queued/);
    const repoGrant = async (n: number) => await guardRepo(w.db, "app", "fix-issue", "pipeline", undefined, { members: [await implementMay(w.db, "app", n)] });
    assert.ok(!("refused" in await repoGrant(5)));
    assert.ok("refused" in await repoGrant(4));

    // Its PR came back with fixes: the session revises it.
    await (await w.pr(6, { author: "pipeline-bot" })).review(6, { verdict: "take-fix" });
    await w.db.run(w.db.k.insertInto("implementations").values({ repo: "app", number: 5, pr_number: 6, state: "pr-opened", text_hash: "h", attempt: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), queued_by: "mira" }));
    const f = (await w.plan()).prs.find((p) => p.facts.number === 6)!.facts;
    assert.equal(gates(f, { kind: "implement", bucket: "revise" }, "pipeline"), null);
    assert.match(gates({ ...f, implementation: { ...f.implementation!, queuedBy: null } }, { kind: "implement", bucket: "revise" }, "pipeline") ?? "", /not queued/);
  });

  test("a started PR nobody approved that conflicts or has red CI comes back with one recommendation", async () => {
    const w = await unapproved();
    await w.pr(1, { mergeable: "CONFLICTING" });
    await w.pr(2, { ci: "failure" });
    for (const n of [1, 2]) {
      await (await (await w.review(n)).verified(n)).workflow(n, { by: "mira", approved: false });
      assert.deepEqual([(await w.prPlan(n)).wait, (await w.prPlan(n)).waitKind], [MAINTAINER_ANSWER_WAIT, "person"]);
    }
    await advanceWorkflows(w.db);
    for (const n of [1, 2]) {
      const wf = await liveWorkflow(w.db, "app", n);
      assert.equal(wf?.state, "recommending");
      assert.ok(wf?.rec?.merges);
      assert.match(wf.rec.text, n === 1 ? /conflicts/ : /CI fails/, "it names what stopped the PR");
    }
    await writePlanCache(w.db, await w.plan());
    assert.deepEqual((await withConfig(w.db, () => computeLiveness(w.db))).items.filter((i) => i.verdict === "stuck"), []);
  });

  test("a repo whose fix-up selection fails leaves the lane to the others", async () => {
    const w = await unapproved();
    await w.db.run(w.db.k.insertInto("tracked_repos").values({ name: "bad", added_by: OPERATOR, added_at: T1, pipeline: 1 }));
    await (await w.pr(2)).review(2, { verdict: "take-fix" });
    await w.fixup(2, false);
    const ctx = await planCtx(w.db);
    assert.deepEqual(await actions(w, 2), ["fixup:fix:operator"]);
    const good = ctx.plans!.prs.find((p) => p.facts.number === 2)!;
    ctx.plans!.prs.push({ facts: { ...good.facts, repo: "bad", review: null, may: { ...good.facts.may!, repoPush: { by: OPERATOR, at: T1 } } }, plan: { ...good.plan, repo: "bad", actions: [{ kind: "fixup", head: good.plan.head, params: { bucket: "fix", source: "review" } }] } });
    ctx.tracked = ["bad", "app"];
    assert.deepEqual((await LANES.find((l) => l.name === "fixup")!.detect(w.db, ctx)).map((c) => c.params.repo), ["app"]);
    assert.match(ctx.notes!.fixup ?? "", /bad/);
  });
});

async function putLint(w: World, id: number, o: { format?: string; diagnostics?: { line: number }[]; file?: string } = {}): Promise<void> {
  const put = async (name: string, text: string) => { const tmp = tempPath(id); writeFileSync(tmp, text); await storeArtifact(w.db, id, name, tmp); };
  const diag = (line: number) => JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "needless", code: { code: "clippy::needless_return" }, spans: [{ file_name: o.file ?? "src/lib.rs", line_start: line, line_end: line, is_primary: true }], rendered: `warning: needless at line ${line}\n` } });
  await put("clippy.txt", [...(o.diagnostics ?? []).map((d) => diag(d.line)), JSON.stringify({ reason: "build-finished", success: !o.diagnostics?.length })].join("\n") + "\n");
  if (o.format) await put("format.txt", o.format);
}

async function endLint(w: World, id: number, o: Parameters<typeof putLint>[2] = {}): Promise<void> {
  await putLint(w, id, o);
  await w.db.run(w.db.k.updateTable("build_tasks").set({ state: "done", results: "[]", ended_at: T1 }).where("id", "=", id));
}

const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A contributor's fork on disk (branch fix-<n>) that stands in for both GitHub URLs; git runs for real, gh is faked. */
function gitWorld(n: number, lib = "fn a() {}\nfn main() { a(); }\n", conflict = false) {
  const root = tmpdir("git");
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  sh(work, "init", "-q", "-b", conflict ? "main" : `fix-${n}`);
  writeFileSync(join(work, "src/lib.rs"), lib);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "contributor");
  if (conflict) {
    // The PR and the default branch both change line 2 of the file.
    sh(work, "checkout", "-q", "-b", `fix-${n}`);
    writeFileSync(join(work, "src/lib.rs"), lib.replace("main() { a(); }", "main() { a(); a(); }"));
    sh(work, "commit", "-q", "-am", "contributor change");
    sh(work, "checkout", "-q", "main");
    writeFileSync(join(work, "src/lib.rs"), lib.replace("main() { a(); }", "main() { a(); b(); }"));
    sh(work, "commit", "-q", "-am", "base change");
    sh(work, "checkout", "-q", `fix-${n}`);
  }
  const head = sh(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  sh(root, "clone", "-q", "--bare", work, fork);
  sh(fork, "update-ref", `refs/pull/${n}/head`, head);
  const pushes: { lease: string; to: string }[] = [];
  const edit = (from: string, to: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n${from}${to}`;
  const patch = lib.includes("main() { a(); }")
    ? edit("-fn a() {}\n-fn main() { a(); }\n", "+fn b() {}\n+fn main() { b(); }\n")
    : edit("-fn a() {}\n-fn main() { b(); }\n", "+fn b() {}\n+fn main() { b(); }\n");
  return {
    head, pushes, fork, patch,
    branchHead: () => sh(fork, "rev-parse", `refs/heads/fix-${n}`),
    deps(w: World): FixupDeps {
      const querier: Querier = {
        ...w.gh.querier,
        query: async (query: string, vars: object) => query.includes("headRefName")
          ? { repository: { pullRequest: { id: `P${n}`, state: "OPEN", isDraft: false, headRefOid: head, headRefName: `fix-${n}`, maintainerCanModify: true, mergeable: conflict ? "CONFLICTING" : "MERGEABLE", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } }
          : w.gh.querier.query(query, vars),
      } as Querier;
      const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
        if (cmd === "gh") {
          if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
          w.gh.writes.push({ kind: "comment", number: n, detail: o.input });
          return { code: 0, stdout: "", stderr: "" };
        }
        // GitHub's URLs point at the fork on disk, which needs the file protocol.
        const toFork = args.map((a) => (a.startsWith("https://github.com/") ? fork : a));
        const local = toFork.filter((a, i) => a !== "protocol.file.allow=never" && !(a === "-c" && toFork[i + 1] === "protocol.file.allow=never"));
        if (args.includes("push")) {
          const lease = args.find((a) => a.startsWith("--force-with-lease="))!.split(":")[1]!;
          const to = args.find((a) => /^[0-9a-f]{40}:/.test(a))!.split(":")[0]!;
          pushes.push({ lease, to });
          w.gh.writes.push({ kind: "push", number: n, head: to });
        }
        return exec("git", local, { ...o });
      };
      return {
        querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
        fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
        ask: async () => patch,
        check: async () => JSON.stringify({ verdict: "approve", reasons: "matches the listed fix", problems: [] }),
      };
    },
    /** The CI fix step's deps: the failed check's log names src/lib.rs. */
    cifixDeps(w: World): CifixDeps {
      const base = this.deps(w);
      const log = "test\tcargo test\t2026-01-01T00:00:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-01-01T00:00:01Z  --> src/lib.rs:2:20\n";
      return {
        ...base,
        ask: base.ask as unknown as CifixDeps["ask"],
        gh: async (args) => {
          if (args[0] === "api" && args[1]!.includes("/pulls/")) return `${"b".repeat(40)}\n`;
          if (args[0] === "api") return JSON.stringify({ check_runs: [{ name: CHECK, status: "completed", conclusion: "failure", completed_at: "2026-01-03T12:00:00Z", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" }] });
          return log;
        },
        check: async () => JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] }),
      };
    },
  };
}

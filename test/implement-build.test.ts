// The build of an implementation: AutoCraft's own check findings go back to the same session as a follow-up and a clean
// round makes it ready for its PR; findings that survive three follow-ups make it stuck with a decision, whose Try again
// starts a new attempt with the answer's note as guidance.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome } from "../src/remote/calls.ts";
import type { WorkspaceCallRequest } from "../src/build/workspace-call.ts";
import { runBuild, type BuildDeps, type BuildRun } from "../src/implement/build.ts";
import type { Pod } from "../src/implement/checks.ts";
import { implementDecisionId, STUCK_OPTIONS } from "../src/implement/stuck.ts";
import { currentImplementation, implementationById, roundsOf, setImplementationState, startImplementation } from "../src/implement/store.ts";
import type { PlanReply, SessionReport } from "../src/implement/types.ts";
import { textHash } from "../src/fixissue/candidates.ts";
import { OPERATOR, world } from "./world-db.ts";

const BASE = "b".repeat(40);
const PLAN: PlanReply = {
  ready: true, kind: "bugfix", summary: "Return None for an empty slice.", plan: "Guard first().", acceptance: ["first() of an empty slice is None"],
  verification: { tests: ["cargo test -p app"], app: null }, size: "S", risks: [], questions: [],
};
const REPORT: SessionReport = { status: "done", summary: "first() checks the length before it indexes.", changes: ["guard in first()"], tests_run: [{ command: "cargo test", exit: 0 }], shots: [], deviations: [] };
const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -9,0 +10 @@\n+    let x = 1;\n";
const WARNING = JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "unused variable: `x`", code: { code: "unused_variables" }, spans: [{ file_name: "src/lib.rs", line_start: 10, line_end: 10, is_primary: true }], rendered: "warning: unused variable: `x`" } });

async function setup() {
  const w = await (await (await world()).repo()).issue(7);
  const db = w.db, at = new Date().toISOString();
  const ws = Number((await db.get(db.k.insertInto("workspaces").values({ repo: "app", base_sha: BASE, base_commit: BASE, env_id: "k", state: "ready", state_at: at, created_at: at, updated_at: at }).returning("id")))!.id);
  const it = (await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", "app").where("number", "=", 7)))!;
  const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: textHash(it.title ?? "", it.body ?? ""), baseSha: BASE });
  await setImplementationState(db, impl.id, "planned", { plan: PLAN, planMd: PLAN.plan, workspaceId: ws });

  const queued: WorkspaceCallRequest[] = [];
  let checksRound = 0;
  const clippyFails = { rounds: new Set<number>() };
  const pod: Pod = {
    async run(what) {
      if (what === "implement-changes") checksRound++;
      return { exit: 0, state: "exited" };
    },
    async file(path) {
      const name = path.split("/").pop()!;
      const failing = clippyFails.rounds.has(checksRound);
      const files: Record<string, string> = {
        "diff.txt": DIFF, "meta.exit": "0", "meta.json": JSON.stringify({ packages: [{ name: "app", manifest_path: "/work/src/Cargo.toml" }] }),
        "fmt.exit": "0", "fmt.txt": "", "clippy.err": "", "clippy.exit": failing ? "101" : "0",
        "clippy.json": failing ? `${WARNING}\n{"reason":"build-finished","success":false}\n` : `{"reason":"build-finished","success":true}\n`,
        "tests.exit": "0", "tests.txt": "test result: ok. 3 passed",
      };
      return name in files ? Buffer.from(files[name]!) : null;
    },
  };
  const deps: BuildDeps = {
    calls: {
      async queue(_db, r) { queued.push(r); return 1000 + queued.length; },
      async await(): Promise<Outcome> { return { state: "done", text: JSON.stringify(REPORT), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as never, byModel: null, costUsd: 1, turns: 5, sessionId: "s", runId: null }; },
    },
    pod: () => pod,
    diffCheck: async () => ({ ok: false }),
  };
  const run: BuildRun = { db, log: () => {}, progress: async () => {}, cancelled: async () => false, stopping: async () => false, startedMs: Date.now(), noPr: true };
  return { db, impl, deps, run, queued, clippyFails };
}

test("check findings go back to the same session as a follow-up, and a clean round leaves the attempt ready for its PR", async () => {
  const s = await setup();
  s.clippyFails.rounds.add(1);
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "fixing", "a finding on a changed line sends the attempt to a follow-up");
  await runBuild(s.run, "app", 7, s.deps);
  const done = (await implementationById(s.db, s.impl.id))!;
  assert.equal(done.state, "opening");
  assert.equal(s.queued.length, 2);
  assert.equal(s.queued[0]!.parentId, undefined);
  assert.equal(s.queued[1]!.parentId, 1001, "the follow-up continues the first session");
  assert.match(s.queued[1]!.stdin, /unused variable/);
  assert.ok(s.queued.every((q) => q.forLogin === OPERATOR && q.boundSlot === true && q.keepSession === true), "every turn runs in a slot of the queuer's Task Runner");
  const kinds = (await roundsOf(s.db, s.impl.id)).map((r) => r.kind);
  assert.deepEqual(kinds, ["session", "checks", "follow-up", "checks"]);
});

test("findings that survive three follow-ups make the attempt stuck, and Try again starts a new attempt with the note as guidance", async () => {
  const s = await setup();
  for (const r of [1, 2, 3, 4]) s.clippyFails.rounds.add(r);
  for (let i = 0; i < 4; i++) await runBuild(s.run, "app", 7, s.deps);
  const stuck = (await implementationById(s.db, s.impl.id))!;
  assert.equal(stuck.state, "stuck");
  assert.equal(s.queued.filter((q) => q.parentId !== undefined).length, 3);
  const id = implementDecisionId("app", 7);
  const d = (await s.db.get(s.db.k.selectFrom("decisions").select(["options", "answer"]).where("id", "=", id)))!;
  const keys = (JSON.parse(d.options) as { key: string }[]).map((o) => o.key);
  assert.ok(keys.includes(STUCK_OPTIONS.tryAgain.key) && keys.includes(STUCK_OPTIONS.close.key) && keys.includes("backlog"));
  assert.ok(!keys.includes(STUCK_OPTIONS.draft.key), "a change that fails the diff check is not offered as a draft PR");

  await s.db.run(s.db.k.updateTable("decisions").set({ answer: STUCK_OPTIONS.tryAgain.key, answer_note: "Keep the old signature.", answered_by: OPERATOR, answered_at: new Date().toISOString() }).where("id", "=", id));
  await runBuild(s.run, "app", 7, s.deps);
  const next = (await currentImplementation(s.db, "app", 7))!;
  assert.notEqual(next.id, s.impl.id);
  assert.equal(next.state, "planning");
  assert.deepEqual((await roundsOf(s.db, next.id)).map((r) => [r.kind, (r.result as { text?: string }).text]), [["guidance", "Keep the old signature."]]);
});

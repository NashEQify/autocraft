// A started item never waits on a person unasked (src/workflow/ask.ts): each person wait of its plan, and an approver who lost access, comes
// back as one question; a yes to it runs something and does not bring the same question back.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { needsQuestion } from "../src/core/codes.ts";
import { decidePr, worksOn } from "../src/core/decide.ts";
import { startAttempt } from "../src/data/implement/index.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { textHash } from "../src/core/open-prs.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { questionFor } from "../src/workflow/ask.ts";
import { parse } from "../src/workflow/parse.ts";
import { resolve } from "../src/workflow/resolve.ts";
import { yesClause } from "../src/workflow/status.ts";
import { eventsOf, liveWorkflow } from "../src/workflow/store.ts";
import type { ItemWorkflow } from "../src/workflow/types.ts";
import { legWait } from "../src/workflow/waits.ts";
import { setFeature } from "../src/build/features.ts";
import { factsOf, prng, randomPrRows, rnd } from "./random-pr.ts";
import { T0, T1, world, type World } from "./world-db.ts";

const MAINT = "mira", ANN = "ann";
let current: World | undefined;
afterEach(() => current?.close());

const pause = () => new Promise((r) => setTimeout(r, 5));
const say = async (w: World, text: string, by = MAINT, number = 1) => {
  await pause();
  const actor: Actor = { login: by, canWrite: async () => true };
  const o = (await runCommand(w.db, actor, "github", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
  assert.equal(o.outcome, "run", o.line);
  return o.line;
};
const settle = async (w: World) => { for (let i = 0; i < 5; i++) { await advanceWorkflows(w.db); await advancePreapprovals(w.db); } };
const wf = async (w: World, number = 1) => (await liveWorkflow(w.db, "app", number))!;
const leg = async (w: World) => (await w.rows("SELECT state FROM preapprovals ORDER BY id DESC"))[0]?.state;
const shown = async (w: World, number = 1) => { const x = await wf(w, number); return [x.state, x.blockerParams?.code ?? null, x.approvedBy]; };
const actions = async (w: World) => (await w.prPlan(1)).actions.map((a) => a.kind);

/** A PR with a take review, green CI and a clean pre-merge review, `text` said on it by MAINT. */
async function started(text: string, o: { review?: boolean } = {}): Promise<World> {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  await w.pr(1, { label: "feature" });
  await (await w.verified(1)).premerge(1, "clean");
  await say(w, text);
  if (o.review !== false) {
    await w.review(1);
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  }
  await settle(w);
  return w;
}
const loseAccess = async (w: World, login = MAINT) =>
  void await w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission: "read", checked_at: new Date().toISOString() }).where("login", "=", login));

test("a person wait of a started PR has a question that a yes runs, unless its person acts elsewhere", () => {
  const seed = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : (Date.now() & 0x7fffffff);
  const x = rnd(prng(seed));
  let asked = 0;
  for (let i = 0; i < 6_000; i++) {
    const rows = randomPrRows(x), f = factsOf(rows);
    const w = f.may.workflow;
    if (!f.workflow || w?.state !== "running" || !f.inScope || f.ghState !== "OPEN") continue;
    const p = decidePr(f), approved = w.approvedBy !== null;
    const q = questionFor(f, p, { approved, review: null, parts: [], conflict: null });
    const at = `INVARIANT_SEED=${seed}: ${JSON.stringify({ code: p.waitCode, who: p.waitKind, state: p.state, approved, q })}`;
    const refused = (a: (typeof p.actions)[number]) => (a.permission && !a.permission.ok ? a.permission.why : null);
    const busy = p.actions.some((a) => worksOn(a) && (refused(a)?.who !== "person" || refused(a)?.code === "blocked"));
    const gone = f.standing?.merge?.standing === "no" || f.standing?.work?.standing === "no" || !!f.mergeLacksAccess;
    const own = p.waitCode === "implement-stuck" || p.waitCode === "implement-question" || (approved && p.state === "opus-hold");
    if (!gone && !busy && !own && p.waitCode && needsQuestion(p.waitCode, p.waitKind!)) assert.ok(q, at);
    if (!q) continue;
    asked++;
    if (!gone && p.state !== "opus-close" && p.state !== "opus-hold") assert.ok(p.waitCode && needsQuestion(p.waitCode, p.waitKind!) && !busy, at);
    assert.ok(yesClause(q.rec), at);
    assert.equal(approved && !q.rec.merges, false, at);
    const row = { entry: w.entry, state: approved ? "blocked" : "recommending", approvedBy: w.approvedBy, plan: [], rec: q.rec, blocker: q.blocker } as unknown as ItemWorkflow;
    const r = resolve({ kind: "yes", items: [] }, { kind: "pr", workflow: row });
    assert.ok(r.kind === "run" && (r.run.again || r.run.merges || r.run.goesOn || r.run.end || r.run.fix.length), at);
  }
  assert.ok(asked > 50, `only ${asked} questions came up`);
});

test("an approver who lost access is asked for, wherever the merge is; another maintainer's yes takes their place", async () => {
  for (const at of ["review", "ci", "queued"] as const) {
    const w = await started("review and merge", { review: at !== "review" });
    if (at === "ci") {
      await w.db.run(w.db.k.updateTable("main.preapprovals").set({ state: "ci" }));
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "pending" }));
    }
    assert.equal(await leg(w), at);
    await loseAccess(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "actor-gone", MAINT], at);
    assert.match((await wf(w)).rec!.text, new RegExp(MAINT));
    assert.equal(await leg(w), "cancelled", at);
    await say(w, "yes", ANN);
    await settle(w);
    assert.deepEqual(await shown(w), ["running", null, ANN], at);
    assert.equal(await leg(w), at, at);
    w.close();
  }
});

test("a merge that could not be made as its approver is asked for, and their own yes tries it again; one that waits for a sign-in is not", async () => {
  for (const [state, code] of [["waiting-permission", "actor-gone"], ["waiting-token", null]] as const) {
    const w = await started("review and merge");
    assert.equal(await leg(w), "queued");
    const row = await wf(w), at = new Date().toISOString();
    await w.db.run(w.db.k.insertInto("main.workflow_actions").values({ workflow_id: row.id, repo: "app", number: 1, kind: "merge", by: MAINT, head: "sha1", state, reason: "no write access", created_at: at, updated_at: at }));
    await settle(w);
    assert.deepEqual(await shown(w), [code ? "blocked" : "running", code, MAINT]);
    if (code) {
      await say(w, "yes");
      await settle(w);
      assert.deepEqual(await shown(w), ["running", null, MAINT]);
      assert.ok((await actions(w)).includes("merge"));
    }
    w.close();
  }
});

test("started work whose person lost access is asked for before anything merges, and goes on for whoever says yes", async () => {
  const w = await started("fix-up", { review: false });
  await loseAccess(w);
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.rec?.merges, x.rec?.goes], ["recommending", false, "on"]);
  await say(w, "yes", ANN);
  await settle(w);
  assert.deepEqual([(await wf(w)).state, (await wf(w)).approvedBy], ["running", null]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "review" && a.permission?.ok));
});

test("a PR that failed alone in a batch, or whose screenshots show a regression, is not merged until a yes, which merges it without asking again", async () => {
  for (const what of ["batch-failed", "screenshots"] as const) {
    const w = await started("review and merge");
    assert.equal(await leg(w), "queued");
    await pause();
    const at = new Date().toISOString();
    if (what === "batch-failed") {
      const id = Number((await w.db.get(w.db.k.insertInto("main.merge_batches").values({ repo: "app", branch: "b", base_sha: "b", commit_sha: "c", state: "failed", summary: "a test fails", created_at: at, updated_at: at }).returning("id")))!.id);
      await w.db.run(w.db.k.insertInto("main.merge_batch_prs").values({ batch_id: id, number: 1, head_oid: "sha1", position: 0 }));
    } else await w.db.run(w.db.k.insertInto("main.screenshot_runs").values({ repo: "app", number: 1, head_sha: "sha1", state: "compared", verdict: "regression", clear: 1, held: 1, comparison: "The handles moved.", created_at: at, finished_at: at }));
    assert.ok(!(await actions(w)).includes("merge"), what);
    if (what === "screenshots") assert.equal((await mergeVerdicts(w.db, "app", [{ number: 1, head: "sha1" }], { batch: true })).get(1)!.ok, false, "a batch that holds it goes on without it");
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", what, MAINT]);
    await say(w, "yes", ANN);
    await settle(w);
    assert.deepEqual([...await shown(w), await leg(w)], ["running", null, MAINT, "queued"], what);
    assert.ok((await actions(w)).includes("merge"), what);
    w.close();
  }
});

test("a regression in the screenshots keeps a PR nobody started off the merge rule", async () => {
  const w = current = await (await world()).repo();
  await (await (await (await w.pr(1)).review(1)).verified(1)).premerge(1, "clean");
  assert.ok((await actions(w)).includes("merge"));
  await w.db.run(w.db.k.insertInto("main.screenshot_runs").values({ repo: "app", number: 1, head_sha: "sha1", state: "compared", verdict: "regression", clear: 1, held: 1, comparison: "The handles moved.", created_at: T1, finished_at: T1 }));
  const p = await w.prPlan(1);
  assert.deepEqual([p.actions.some((a) => a.kind === "merge"), p.waitCode, p.waitKind], [false, "screenshots", "person"]);
});

const checks = (w: World, set: { overall?: string; mergeable?: string }) => w.db.run(w.db.k.updateTable("main.pr_checks").set(set).where("number", "=", 1));
/** What a person settles on GitHub: how it comes about, and how it is settled there. */
const ON_GITHUB = {
  "base-off-default": {
    cause: async (w: World) => {
      await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "release" }).where("number", "=", 1));
      await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ base_ref: "release" }));
    },
    settle: (w: World) => w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1)),
  },
  "no-ci": { cause: (w: World) => checks(w, { overall: "none" }), settle: (w: World) => checks(w, { overall: "success" }) },
  "mergeable-stuck": {
    cause: async (w: World) => {
      await checks(w, { mergeable: "UNKNOWN" });
      await w.db.run(w.db.k.insertInto("main.merge_state").values({ repo: "app", number: 1, head: "sha1", since: T0, reads: 9, rereads: 3, stuck: 1 }));
    },
    settle: (w: World) => checks(w, { mergeable: "MERGEABLE" }),
  },
  "ci-approval-failed": {
    cause: (w: World) => w.db.run(w.db.k.insertInto("main.ci_run_approvals").values({ repo: "app", number: 1, head_oid: "sha1", cross_repo: 1, runs: JSON.stringify([{ id: 7, event: "pull_request" }]), approved: "[]", failed: JSON.stringify({ 7: 99 }), checked_at: T1 })),
    settle: (w: World) => w.db.run(w.db.k.updateTable("main.ci_run_approvals").set({ runs: "[]" })),
  },
} as const;

test("what a person settles on GitHub is asked about; a yes looks again, and once it is settled the question closes by itself and the approved merge goes on", async () => {
  for (const code of Object.keys(ON_GITHUB) as (keyof typeof ON_GITHUB)[]) {
    const w = await started("review and merge");
    await ON_GITHUB[code].cause(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", code, MAINT]);
    assert.notEqual(await leg(w), "queued", code);
    await say(w, "yes");
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", code, MAINT], `${code}: nothing changed`);
    await ON_GITHUB[code].settle(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["running", null, MAINT], code);
    assert.ok(["review", "ci", "queued"].includes(String(await leg(w))), code);
    assert.match(String((await eventsOf(w.db, "app", 1)).at(-1)!.line), /closed without an answer/, code);
    w.close();
  }
});

test("a question whose cause went stays one where the author pushed meanwhile", async () => {
  const w = await started("review and merge");
  await checks(w, { overall: "none" });
  await settle(w);
  await w.synced(1, "theirs");
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.blocker, x.approvedBy], ["blocked", "author-commits", MAINT]);
});

test("an approver who can act again goes on with their approval, unasked; where the merge itself was refused for their access, once it is to be tried again", async () => {
  for (const lane of [false, true]) {
    const w = await started("review and merge");
    const row = await wf(w), at = new Date().toISOString();
    const access = (permission: string) => w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission, checked_at: new Date().toISOString() }).where("login", "=", MAINT));
    await w.db.run(w.db.k.insertInto("main.workflow_actions").values({ workflow_id: row.id, repo: "app", number: 1, kind: "merge", by: MAINT, head: "sha1", state: "waiting-permission", reason: "no write access", created_at: at, updated_at: at }));
    if (!lane) await access("read");
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "actor-gone", MAINT]);
    await access("write");
    await settle(w);
    if (lane) {
      assert.equal((await wf(w)).state, "blocked", "their access was never in doubt here");
      await w.db.run(w.db.k.updateTable("main.workflow_actions").set({ state: "pending" }));
      await settle(w);
    }
    assert.deepEqual([...await shown(w), await leg(w)], ["running", null, MAINT, "queued"]);
    assert.ok((await actions(w)).includes("merge"));
    w.close();
  }
});

test("a yes does not bring the question of a pre-merge stop back: where no fix is known, it asks to fix the defects", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT, ANN);
  await w.pr(1, { label: "feature" });
  await (await w.verified(1)).premerge(1, "defect", false);
  await say(w, "review and merge");
  await w.review(1);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.rec?.parts.fix.length, x.rec?.again], ["blocked", 1, undefined], x.rec?.text ?? "");
  await say(w, "yes");
  await settle(w);
  assert.deepEqual([(await wf(w)).state, await leg(w)], ["running", "fixup"]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator"));
});

test("a merge refused for good is asked about, and a yes tries it again", async () => {
  const w = await started("review and merge");
  await pause();
  await w.db.run(w.db.k.insertInto("main.merges").values({ repo: "app", number: 1, head_oid: "sha1", run_id: "r", at: new Date().toISOString(), path: "operator", method: "squash", outcome: "refused", reason: "safe-merge: a workflow file may not be changed", ci: "success", mergeable: "MERGEABLE" }));
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.approvedBy, /workflow file/.test(x.rec!.text)], ["blocked", MAINT, true]);
  await say(w, "yes", ANN);
  await settle(w);
  assert.deepEqual([(await wf(w)).state, await leg(w)], ["running", "queued"]);
  assert.ok((await actions(w)).includes("merge"));
});

test("CI fixes that failed twice are the contributor's first, and a question once they were asked before", async () => {
  const w = await started("review and merge");
  const failed = async (head: string) => {
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }).where("number", "=", 1));
    for (const attempt of [1, 2]) await fix(head, "rejected", attempt);
  };
  const fix = (head: string, state: string, attempt: number) =>
    w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 1, head, kind: "test", state, attempt, created_at: new Date(Date.now() + 1000).toISOString() }));
  await failed("sha1");
  await settle(w);
  assert.deepEqual(await shown(w), ["running", null, MAINT]);
  assert.deepEqual((await w.prPlan(1)).actions.filter((a) => a.kind === "cifix").map((a) => a.params?.bucket), ["ask"]);
  await fix("sha1", "asked", 3);
  await settle(w);
  assert.equal((await wf(w)).state, "running");
  const p = await w.prPlan(1);
  assert.equal(p.waitCode, "ci-contributor");
  await w.db.run(w.db.k.insertInto("main.item_plans").values({ repo: "app", number: 1, kind: "pr", head: "sha1", state: p.state, actions: "[]", wait: p.wait, reasons: "[]", note: null, view: JSON.stringify({ waitKind: p.waitKind, waitCode: p.waitCode }), planned_at: T0 }));
  assert.match((await legWait(w.db, await wf(w)))!, /contributor/);

  // A push of ours, whose CI fix fails as well: they were asked already.
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "conflict", action: "conflict-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1b", before_res: "unknown" }));
  await w.synced(1, "sha1b");
  await w.review(1, { head: "sha1b" });
  await failed("sha1b");
  await advanceWorkflows(w.db);
  const x = await wf(w);
  assert.deepEqual([x.state, x.blocker], ["blocked", "failed-twice"]);
});

test("an implementation that ended without a pull request is asked about, and a yes implements the issue again", async () => {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  await w.issue(7);
  await setFeature(w.db, "implement", true, MAINT, "app");
  await say(w, "implement", MAINT, 7);
  await pause();
  await startAttempt(w.db, { repo: "app", number: 7, textHash: textHash("Panic when the slice is empty", "first() indexes element 0."), queuedBy: MAINT });
  // It ended while the pass that asks was reading: after the pass began.
  await w.db.run(w.db.k.updateTable("main.implementations").set({ state: "failed", updated_at: new Date(Date.now() + 1000).toISOString() }));
  await settle(w);
  const x = await wf(w, 7);
  assert.deepEqual([x.state, x.rec?.goes], ["recommending", "on"]);
  await say(w, "yes", MAINT, 7);
  assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "plan" });
  await settle(w);
  assert.equal((await wf(w, 7)).state, "running");
});

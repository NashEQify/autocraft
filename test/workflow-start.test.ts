// A person's command is the approval of what it starts: it works in a repo with no merge or push approval, with the pipeline off and
// on an item someone stopped, and a refusal writes nothing. Through the command entry point every surface uses.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { textHash } from "../src/core/open-prs.ts";
import { addOwnCommits } from "../src/data/control/index.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { mergeMay } from "../src/core/gates.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { doCard } from "../src/conversations/act.ts";
import { parseReply } from "../src/conversations/cards.ts";
import { ensureConversation, insertTurn } from "../src/conversations/store.ts";
import { retryItemPreapproval } from "../src/dash/api/operator.ts";
import type { Req } from "../src/dash/types.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { eventsOf, insertWorkflow, liveWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const send = async (w: World, text: string, number = 1, head?: string) =>
  (await runCommand(w.db, actor, "github", { parsed: parse(text), items: [{ repo: "app", number }], ...(head ? { head } : {}) })).items[0]!;
const run = async (w: World, text: string, number = 1) => {
  const o = await send(w, text, number);
  assert.equal(o.outcome, "run", `${text}: ${o.line}`);
};

/** A feature PR nobody started, in a repo that approved neither merges nor pushes; its facts are ready for a merge at sha1. */
async function unstarted(pipeline = true): Promise<World> {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT);
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ pipeline: pipeline ? 1 : 0 }));
  return await (await (await w.pr(1, { label: "feature" })).verified(1)).premerge(1, "clean");
}
const settle = async (w: World) => {
  for (let i = 0; i < 5; i++) { await advanceWorkflows(w.db); await advancePreapprovals(w.db); }
};
/** The newest leg is handed over, belongs to the live workflow, and the planner merges the PR at `head` as MAINT. */
async function mergesAsPerson(w: World, head = "sha1"): Promise<void> {
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const leg = (await w.rows("SELECT state, workflow_id, reason FROM preapprovals WHERE number = 1 ORDER BY id DESC"))[0];
  assert.deepEqual({ state: leg?.state, workflow: leg?.workflow_id }, { state: "queued", workflow: wf.id }, String(leg?.reason ?? ""));
  assert.equal(wf.approvedBy, MAINT);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.head === head), JSON.stringify(await w.prPlan(1)));
  assert.deepEqual(mergeMay((await loadPrFact(w.db, "app", 1))!), { ok: true, as: "person", by: MAINT });
  assert.deepEqual((await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1), { ok: true, as: "person", by: MAINT });
}
const review = async (w: World, head = "sha1") => {
  // The review a start asked for: newer than the start.
  await w.review(1, { head });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", 1));
};

for (const pipeline of [true, false]) {
  test(`merge on an unstarted PR of a repo without merge approval, its pipeline ${pipeline ? "on" : "off"}, merges as the sender`, async () => {
    const w = await unstarted(pipeline);
    await run(w, "merge");
    await settle(w);
    await mergesAsPerson(w);
  });
}

test("an approved review start in such a repo merges after its review", async () => {
  const w = await unstarted(false);
  await run(w, "review and merge");
  await settle(w);
  assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
  await review(w);
  await settle(w);
  await mergesAsPerson(w);
});

test("an item someone stopped, closed or put in the backlog starts again with every entry, and merges", async () => {
  for (const end of ["stop", "backlog", "close"]) {
    const w = await unstarted(end !== "stop");
    for (const start of ["review", "fix-up", "review and merge", "fix-up and merge", "merge"]) {
      await run(w, start);
      const wf = (await liveWorkflow(w.db, "app", 1))!;
      assert.notEqual((await w.prPlan(1)).state, "out-of-scope", `${start} after ${end}`);
      const open = await w.rows("SELECT workflow_id FROM preapprovals WHERE number = 1 AND state = 'review'");
      assert.deepEqual(open.map((l) => l.workflow_id), start.includes("merge") ? [wf.id] : [], `${start} after ${end}`);
      await run(w, end);
      assert.equal(await liveWorkflow(w.db, "app", 1), null);
    }
    await run(w, "merge");
    assert.deepEqual((await w.rows("SELECT state FROM workflow_actions WHERE state IN ('pending', 'waiting-token', 'waiting-permission')")).length, 0, "the start took back the close");
    await settle(w);
    await mergesAsPerson(w);
    w.close();
  }
});

test("a stopped issue can be implemented again", async () => {
  const w = await (await unstarted(false)).issue(7);
  for (const end of ["stop", "backlog", "close"]) {
    await run(w, "implement and merge", 7);
    assert.ok(implementStep((await loadItemFact(w.db, "app", 7))!), `planned again after ${end}`);
    await run(w, end, 7);
    assert.equal(implementStep((await loadItemFact(w.db, "app", 7))!), null);
  }
});

test("a refused start writes nothing", async () => {
  const w = await unstarted();
  await run(w, "close");
  const tables = ["item_workflows", "preapprovals", "review_state", "operator_fixups", "workflow_events", "workflow_actions"];
  const all = async () => await Promise.all(tables.map(async (t) => await w.rows(`SELECT * FROM ${t} ORDER BY 1`)));
  const before = await all();
  const refused = async (text: string, head?: string) => {
    const o = await send(w, text, 1, head);
    assert.equal(o.outcome, "refused", `${text}: ${o.line}`);
    assert.deepEqual(await all(), before, text);
  };
  await refused("merge", "older");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  for (const text of ["merge", "review and merge", "fix-up and merge"]) await refused(text);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 0 }));
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED" }));
  await refused("merge");
});

test("a refused answer writes nothing", async () => {
  const w = await unstarted();
  await run(w, "review");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  const before = await liveWorkflow(w.db, "app", 1);
  for (const text of ["merge", "fix-up and merge"]) assert.equal((await send(w, text)).outcome, "refused", text);
  assert.deepEqual(await liveWorkflow(w.db, "app", 1), before);
  assert.deepEqual([await w.rows("SELECT id FROM preapprovals"), await w.rows("SELECT id FROM operator_fixups")], [[], []]);
});

test("an approval while the merge leg of the PR's issue works is refused", async () => {
  const w = await (await unstarted()).issue(7);
  const id = await insertWorkflow(w.db, { repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard", approvedBy: MAINT, approvedAt: T0, approvedVia: "dashboard" });
  await w.db.run(w.db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: MAINT, at: T0, instructions: "", state: "review", from_head: "sha1", head: "sha1", updated_at: T0, fix_id: null, workflow_id: id }));
  assert.equal((await send(w, "merge")).outcome, "refused");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
});

/** Presses a card of the PR's conversation that proposes the command. */
async function press(w: World, text: string): Promise<void> {
  await ensureConversation(w.db, "app", 1, MAINT);
  const p = (await parseReply(w.db, "app", 1, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps: [{ kind: "command", text }] }])}\n\`\`\``))!;
  const turn = await insertTurn(w.db, "app", 1, { kind: "opus", login: "opus", body: "Text.", block: "x", cards: p.cards });
  const id = Number((await w.db.get(w.db.k.selectFrom("main.conversation_cards").select("id").where("turn_id", "=", turn)))!.id);
  const { card } = await doCard(w.db, id, MAINT, { canWrite: async () => true });
  assert.equal(card.state, "done", card.error ?? "");
}
/** The fix-up of the PR's newest request pushed `to`, and its review, checks and pre-merge review are clean. */
async function pushed(w: World, from: string, to: string): Promise<void> {
  const fix = (await w.rows("SELECT id FROM operator_fixups WHERE number = 1 ORDER BY id DESC"))[0]!.id as number;
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: from, to_head: to, state: "pushed", attempt: 1, created_at: new Date().toISOString(), source: "operator", operator_fix: fix }));
  await w.synced(1, to);
  await review(w, to);
  await (await w.verified(1)).premerge(1, "clean");
}

test("a fix-up-and-merge card pressed on a workflow nobody approved approves it as the presser", async () => {
  const w = await unstarted(false);
  await run(w, "review");
  assert.equal((await liveWorkflow(w.db, "app", 1))!.approvedBy, null);
  await press(w, "fix-up, merge");
  await pushed(w, "sha1", "sha1b");
  await settle(w);
  await mergesAsPerson(w, "sha1b");
});

test("a fix-up-and-merge card pressed on an unstarted PR starts it, approved by the presser", async () => {
  const w = await unstarted(false);
  await press(w, "fix-up, merge");
  await review(w);
  await settle(w);
  await mergesAsPerson(w);
});

test("trying a failed merge again approves as the person who pressed it, whatever became of its workflow", async () => {
  for (const ended of [false, true]) {
    const w = await unstarted(false);
    await run(w, "review");
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    await w.db.run(w.db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: "ann", at: T0, instructions: "rename a to b", state: "failed", from_head: "sha1", updated_at: T0, fix_id: 99, workflow_id: wf.id }));
    if (ended) await run(w, "stop");
    const req = { params: { repo: "app", n: "1" }, user: { login: MAINT, role: "maintainer", canWrite: async () => true, canRead: async () => true } } as unknown as Req;
    await retryItemPreapproval(w.db, req);
    if (ended) await review(w);
    else await pushed(w, "sha1", "sha1b");
    await settle(w);
    await mergesAsPerson(w, ended ? "sha1" : "sha1b");
    w.close();
  }
});

/** An attempt of issue 7 an earlier workflow made, with its PR 8. */
async function earlier(w: World, o: { state: string; pr: "CLOSED" | "MERGED" | "OPEN" }): Promise<number> {
  await w.pr(8, { author: "craft-bot" });
  await w.db.run(w.db.k.updateTable("main.items").set({ state: o.pr, closed_at: o.pr === "OPEN" ? null : T0 }).where("number", "=", 8));
  const it = (await w.db.get(w.db.k.selectFrom("main.items").select(["title", "body"]).where("number", "=", 7)))!;
  const im = (await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: textHash(it.title ?? "", it.body ?? "") }, T0))!;
  await recordSteps(w.db, [{ id: im.id, to: o.state as "closed", patch: { prNumber: 8, branch: "fix-8", prUrl: "https://example.invalid/8" } }], T0);
  return im.id;
}

test("implement on an issue whose earlier implementation ended starts afresh", async () => {
  const cases = [{ state: "closed", pr: "CLOSED" }, { state: "merged", pr: "MERGED" }, { state: "pr-opened", pr: "CLOSED" }, { state: "stuck", pr: "CLOSED" }, { state: "closed", pr: "OPEN" }] as const;
  for (const c of cases) {
    const w = await (await unstarted(false)).issue(7);
    await setFeature(w.db, "implement", true, MAINT, "app");
    const id = await earlier(w, c);
    await run(w, "implement and merge", 7);
    await settle(w);
    const why = `attempt ${c.state}, its PR ${c.pr}`;
    assert.equal((await liveWorkflow(w.db, "app", 7))?.state, "running", why);
    // What is left of an attempt whose PR is over is recording its end.
    if (c.state === "pr-opened" || c.state === "stuck") {
      if (c.state === "pr-opened") assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "revise" }, why);
      await recordSteps(w.db, [{ id, to: "closed" }]);
      await settle(w);
    }
    assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "plan" }, why);
    if (c.pr === "OPEN") {
      // The earlier attempt's PR, reopened, is no part of it: it starts on its own.
      await run(w, "review", 8);
      assert.equal((await liveWorkflow(w.db, "app", 8))?.startedBy, MAINT);
    }
    w.close();
  }
});

test("a PR closed during the workflow that opened it ends the workflow", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "implement and merge", 7);
  const id = await earlier(w, { state: "pr-opened", pr: "OPEN" });
  await settle(w);
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED", closed_at: new Date().toISOString() }).where("number", "=", 8));
  await recordSteps(w.db, [{ id, to: "closed" }]);
  await settle(w);
  assert.equal(await liveWorkflow(w.db, "app", 7), null);
});

test("a PR that a live implement workflow works on takes no workflow of its own, and the issue's approved merge goes on", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "implement and merge", 7);
  await earlier(w, { state: "pr-opened", pr: "OPEN" });
  await addOwnCommits(w.db, [{ repo: "app", sha: "sha8", action: "implement-push" }]);
  await settle(w);
  const legs = async () => await w.rows("SELECT workflow_id, state FROM preapprovals WHERE number = 8");
  const before = await legs();
  assert.deepEqual(before.map((l) => l.state), ["review"]);
  for (const text of ["review", "fix-up", "merge", "review and merge", "stop", "yes", "urgent"]) {
    const o = await send(w, text, 8);
    assert.equal(o.outcome, "refused", `${text}: ${o.line}`);
    assert.match(o.line, /app#7/, "it names where the work runs");
    assert.match(o.line, new RegExp(MAINT), "and who started it");
  }
  assert.equal(await liveWorkflow(w.db, "app", 8), null);
  assert.deepEqual(await legs(), before);

  // Stopped on the issue, the PR can be started on its own; then the issue is not started over it.
  await run(w, "stop", 7);
  await run(w, "review", 8);
  const o = await send(w, "implement", 7);
  assert.equal(o.outcome, "refused", o.line);
  assert.match(o.line, /app#8/);
});

/** Runs `fn` once, before the next write transaction of `db` starts. */
function before(db: World["db"], fn: () => Promise<unknown>): void {
  const write = db.write;
  db.write = (async (f: () => Promise<unknown>, o?: never) => {
    db.write = write;
    await fn();
    return await write.call(db, f, o);
  }) as typeof write;
}

test("a command resolved on a workflow the pass changed meanwhile runs on what it is now", async () => {
  const w = await unstarted();
  await run(w, "review");
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  // The pass comes back with a recommendation after the command read the workflow and before it writes.
  before(w.db, () => updateWorkflow(w.db, wf.id, { state: "recommending", rec, recAt: T0, recHead: "sha1" }));
  await run(w, "merge");
  const now = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([now.state, now.rec, now.approvedBy], ["running", null, MAINT]);
  assert.equal((await eventsOf(w.db, "app", 1)).at(-1)!.kind, "answered", "the approval answers the recommendation");
});

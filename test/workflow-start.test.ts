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
import { statusDue } from "../src/prstatus/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { recommendationText } from "../src/workflow/status.ts";
import { eventsOf, insertWorkflow, liveWorkflow, updateWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { loadPrWorkflows } from "../src/data/workflow/index.ts";
import { selectFixups } from "../src/fixup/select.ts";
import { implementMay, implementRefusal, moveTurns } from "../src/implement/gate.ts";
import { setMergeApproval } from "../src/merge/approval.ts";
import { noteMergeable, unknownOf } from "../src/merge/mergeable.ts";
import type { PrChecks } from "../src/review/checks.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { T0, T1, world, type World } from "./world-db.ts";

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
  assert.deepEqual((await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1), { ok: true, as: `user:${MAINT}`, by: { kind: "person", login: MAINT } });
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

/** Issue 7 implemented (approved when `text` says so), PR 8 opened by it at sha8. */
async function implementing(text: string): Promise<World> {
  const w = await (await unstarted(false)).issue(7);
  await run(w, text, 7);
  await earlier(w, { state: "pr-opened", pr: "OPEN" });
  await addOwnCommits(w.db, [{ repo: "app", sha: "sha8", action: "implement-push" }]);
  await settle(w);
  return w;
}
const legs8 = async (w: World) => await w.rows("SELECT workflow_id, state FROM preapprovals WHERE number = 8 ORDER BY id");

test("a PR that a live implement workflow works on starts no work of its own, and the issue's approved merge goes on", async () => {
  const w = await implementing("implement and merge");
  const before = await legs8(w);
  assert.deepEqual(before.map((l) => l.state), ["review"]);
  for (const text of ["review", "fix-up", "implement", "backlog", "review and merge", "fix-up, urgent"]) {
    const o = await send(w, text, 8);
    assert.equal(o.outcome, "refused", `${text}: ${o.line}`);
    assert.match(o.line, /app#7/, "it names where the work runs");
    assert.match(o.line, new RegExp(MAINT), "and who started it");
  }
  assert.equal(await liveWorkflow(w.db, "app", 8), null);
  assert.deepEqual(await legs8(w), before);

  // Stopped on the issue, the PR can be started on its own; then the issue is not started over it.
  await run(w, "stop", 7);
  await run(w, "review", 8);
  const o = await send(w, "implement", 7);
  assert.equal(o.outcome, "refused", o.line);
  assert.match(o.line, /app#8/);
});

test("stop on the PR of an implement workflow halts the issue's workflow, its merge leg and what is queued on the PR, on every surface", async () => {
  for (const via of ["github", "discord", "dashboard", "agent"] as const) {
    const w = await implementing("implement and merge");
    await w.db.run(w.db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 8, from_head: "sha8", instructions: "x", by: MAINT, at: T0 }));
    const r = await runCommand(w.db, actor, via, { parsed: parse(via === "discord" ? "stop: app#8" : "stop"), items: via === "discord" ? [] : [{ repo: "app", number: 8 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
    assert.match(r.lines[0]!, /app#7: On hold/);
    const [wf] = await workflowHistory(w.db, "app", 7);
    assert.deepEqual([wf!.state, wf!.stoppedBy], ["stopped", MAINT]);
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    assert.deepEqual((await w.rows("SELECT state FROM operator_fixups")).map((x) => x.state), ["ended"]);
    const e = (await eventsOf(w.db, "app", 7)).at(-1)!;
    assert.deepEqual([e.kind, e.workflowId, e.via], ["stopped", wf!.id, via]);
    assert.match(e.line!, /app#8/, "where it was said");
    await w.db.run(w.db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/issues/7" }).where("number", "=", 7));
    assert.match((await statusDue(w.db, "app")).find((d) => d.number === 7)!.line, /Held by mira/, "the issue's status comment says so");
    assert.deepEqual(await workflowHistory(w.db, "app", 8), [], "the PR gets no workflow");
    assert.equal((await send(w, "stop", 8)).outcome, "refused", "nothing is left running");
    w.close();
  }
});

test("a stop halts the issue's workflow and the one its PR has of its own, from either item", async () => {
  for (const number of [8, 7]) {
    const w = await implementing("implement and merge");
    await insertWorkflow(w.db, { repo: "app", number: 8, kind: "pr", entry: "review", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard" });
    const o = await send(w, "stop", number);
    assert.equal(o.outcome, "run", o.line);
    assert.match(o.line, new RegExp(`app#${15 - number} is held too`));
    for (const n of [7, 8]) {
      assert.deepEqual((await workflowHistory(w.db, "app", n)).map((x) => x.state), ["stopped"]);
      assert.equal((await eventsOf(w.db, "app", n)).at(-1)!.kind, "stopped");
    }
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    w.close();
  }
});

test("a list that names the issue and its PR stops them once", async () => {
  const w = await implementing("implement and merge");
  const r = await runCommand(w.db, actor, "agent", { parsed: parse("stop: app#8 app#7"), items: [] });
  assert.deepEqual(r.items.map((o) => o.outcome), ["run", "refused"], r.lines.join("\n"));
});

test("an answer, the approval, the weight and a drop on the PR act on the issue's workflow", async () => {
  const w = await implementing("implement");
  const wf = async () => (await liveWorkflow(w.db, "app", 7))!;
  await run(w, "urgent", 8);
  assert.equal((await wf()).weight, 10);
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  await updateWorkflow(w.db, (await wf()).id, { state: "recommending", rec, recAt: T0, recHead: "sha8", plan: [{ n: 1, title: "typo", source: "review", state: "planned" }] });
  const unclear = await send(w, "maybe", 8);
  assert.equal(unclear.outcome, "ambiguous");
  assert.equal((await eventsOf(w.db, "app", 7)).at(-1)!.kind, "ambiguous", "it waits for a clear answer on the issue");
  await run(w, "drop 1, merge", 8);
  const on = await wf();
  assert.deepEqual([on.state, on.rec, on.approvedBy, on.plan[0]!.state], ["running", null, MAINT, "dropped"]);
  assert.deepEqual((await legs8(w)).map((l) => [l.state, l.workflow_id]), [["review", on.id]]);
  assert.equal((await eventsOf(w.db, "app", 7)).at(-1)!.kind, "answered");
  const again = await send(w, "merge", 8);
  assert.deepEqual([again.outcome, /app#7: Already approved/.test(again.line)], ["refused", true], again.line);
});

test("a yes on the PR answers the issue's recommendation, at the head it was made for", async () => {
  const w = await implementing("implement");
  const id = (await liveWorkflow(w.db, "app", 7))!.id;
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  await updateWorkflow(w.db, id, { state: "recommending", rec, recAt: T0, recHead: "older" });
  assert.equal((await send(w, "yes", 8, "sha8")).outcome, "refused");
  await updateWorkflow(w.db, id, { recHead: "sha8" });
  const o = await send(w, "yes", 8, "sha8");
  assert.equal(o.outcome, "run", o.line);
  assert.match(o.line, /app#7: Merging/);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 7))!.approvedBy, (await legs8(w)).map((l) => l.state)], [MAINT, ["review"]]);
});

test("close on the PR of an implement workflow closes the PR and ends the issue's workflow; a stop on either takes the close back", async () => {
  for (const number of [8, 7]) {
    const w = await implementing("implement and merge");
    await run(w, "close", 8);
    assert.deepEqual((await workflowHistory(w.db, "app", 7)).map((x) => x.state), ["closed"]);
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    const closes = async () => (await w.rows("SELECT number, head, state FROM workflow_actions")).map((x) => [x.number, x.head, x.state === "stopped" ? "stopped" : "open"]);
    assert.deepEqual(await closes(), [[8, "sha8", "open"]]);
    await run(w, "stop", number);
    assert.deepEqual(await closes(), [[8, "sha8", "stopped"]]);
    w.close();
  }
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

/** The newest review of the PR, made after its workflow's start. */
const reviewed = async (w: World, number: number, o: Parameters<World["review"]>[1]): Promise<void> => {
  await w.review(number, o);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", number));
};
const acts = async (w: World, number: number) => (await w.prPlan(number)).actions.map((a) => [a.kind, a.params?.bucket].filter(Boolean).join(":"));
const steps = async (w: World, number: number) => (await acts(w, number)).filter((a) => /^(fixup|cifix|implement)/.test(a));
const fails = async (w: World, number: number) =>
  void await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }).where("number", "=", number));
const implementJobs = async (w: World) =>
  (await LANES.find((l) => l.name === "implement")!.detect(w.db, await planCtx(w.db))).map((c) => [c.params.number, c.params.bucket]);

test("the PR of a stopped implementation, started on its own, gets the normal fix-up and CI fix; while the issue's work is live its session makes them", async () => {
  const w = await implementing("implement");
  await setFeature(w.db, "implement", true, MAINT, "app");
  await reviewed(w, 8, { verdict: "take-fix" });
  assert.deepEqual(await steps(w, 8), ["implement:revise"]);
  await run(w, "stop", 7);
  await run(w, "fix-up and merge", 8);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 2000).toISOString() }).where("number", "=", 8));
  assert.deepEqual(await steps(w, 8), ["fixup:fix"]);
  await settle(w);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 8))!.state, (await legs8(w)).at(-1)!.state], ["running", "review"]);

  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ verdict: "take", fixes: null }).where("number", "=", 8));
  await fails(w, 8);
  assert.deepEqual(await steps(w, 8), ["cifix:work"]);
});

test("a revision runs for whoever last answered, approved or started the issue's work and may act; one nobody may run waits visibly and hides no other work", async () => {
  const w = await (await implementing("implement and merge")).issue(9);
  await setFeature(w.db, "implement", true, MAINT, "app");
  await w.acting("ann");
  await reviewed(w, 8, { verdict: "take-fix" });
  const ann: Actor = { login: "ann", canWrite: async () => true };
  const say = async (text: string, number: number) => {
    const o = (await runCommand(w.db, ann, "github", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
    assert.equal(o.outcome, "run", o.line);
  };
  await say("implement", 9);
  assert.deepEqual(await implementJobs(w), [[7, "revise"]]);

  await w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission: "read", checked_at: new Date().toISOString() }).where("login", "=", MAINT));
  assert.deepEqual(await steps(w, 8), []);
  const plan = await w.prPlan(8);
  assert.deepEqual([plan.waitKind, plan.wait?.includes(MAINT)], ["person", true], plan.wait ?? "");
  const issue = implementStep((await loadItemFact(w.db, "app", 7))!);
  assert.ok(issue && "wait" in issue && issue.wait.text.includes(MAINT), JSON.stringify(issue));
  assert.deepEqual(await implementJobs(w), [[9, "plan"]]);

  // The plans may be older than the access they were made on: the job that may not run is passed over.
  const ctx = await planCtx(w.db);
  const p8 = ctx.plans!.prs.find((p) => p.facts.number === 8)!;
  p8.plan.actions.push({ kind: "implement", head: p8.plan.head, params: { bucket: "revise", issue: 7 } });
  assert.deepEqual((await LANES.find((l) => l.name === "implement")!.detect(w.db, ctx)).map((c) => c.params.number), [9]);

  // Another maintainer's yes frees it: the revision, the approval and the next turns are theirs.
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.state, "blocked");
  await say("yes", 7);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.approvedBy, "ann");
  assert.deepEqual(await steps(w, 8), ["implement:revise"]);
  assert.deepEqual(await implementJobs(w), [[7, "revise"]]);
  assert.equal(await implementRefusal(w.db, "app", 7), null);
  assert.deepEqual(await implementMay(w.db, "app", 7), { ok: true, as: "person", by: "ann" });
  await moveTurns(w.db, "app", 7);
  assert.deepEqual(await w.rows("SELECT queued_by FROM implementations"), [{ queued_by: "ann" }]);
});

/** The push of the conflict merge of sha1 went through. */
const pushRecorded = (w: World) => w.db.run(w.db.k.insertInto("main.push_outcomes").values({
  at: new Date().toISOString(), stage: "fixup", action: "conflict-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1b", before_res: "unknown",
}));

test("the recommendation on a conflicting PR runs on a yes: the merge is approved, the base is merged in, then the fixes nobody dropped are made", async () => {
  const fixes = [{ file: "src/lib.rs", change: "rename a to b", title: "rename a" }, { file: "src/lib.rs", change: "drop the copy", title: "drop the copy" }];
  for (const text of ["yes", "fix 1, drop 2, merge", "fix-up and merge", "drop 2"]) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
    await reviewed(w, 1, { verdict: "take-fix", fixes });
    await settle(w);
    const rec = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(rec.state, "recommending");
    assert.match(rec.rec!.text, /conflicts/);
    await run(w, text);
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy], ["running", MAINT], `${text}: ${JSON.stringify(wf.rec)}`);
    assert.ok((await acts(w, 1)).includes("conflict:merge"), `${text}: ${await acts(w, 1)}`);
    assert.deepEqual((await w.rows("SELECT state FROM preapprovals")).map((l) => l.state), ["review"], text);

    // The base is merged in; the review of the new head asks for the same.
    await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", base_sha: "base", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" }));
    await pushRecorded(w);
    // The mirror does not show the push yet: the leg waits for it.
    await settle(w);
    assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.state, ...(await w.rows("SELECT state FROM preapprovals")).map((l) => l.state)], ["running", "review"], text);
    await w.synced(1, "sha1b");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ fetched_at: new Date().toISOString() }));
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: T0 }));
    await w.review(1, { verdict: "take-fix", fixes, head: "sha1b" });
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("head_oid", "=", "sha1b"));
    await settle(w);
    assert.deepEqual(await acts(w, 1), ["fixup:fix"], text);
    const drop = text.includes("drop");
    assert.deepEqual((await selectFixups(w.db, "app")).fix.map((c) => c.fixes.map((f) => f.change)), [fixes.slice(0, drop ? 1 : 2).map((f) => f.change)], text);

    if (drop) {
      // With every fix dropped the review asks for nothing more.
      await updateWorkflow(w.db, wf.id, { plan: (await liveWorkflow(w.db, "app", 1))!.plan.map((p) => ({ ...p, state: "dropped" as const })) });
      await settle(w);
      assert.deepEqual(await acts(w, 1).then((a) => a.filter((x) => x.startsWith("fixup"))), []);
      assert.equal((await w.rows("SELECT state FROM preapprovals"))[0]!.state, "ci");
    }
    w.close();
  }
});

test("a yes on a conflicting PR with nothing to fix approves the merge, and the leg goes on until the base is merged in, whatever CI says", async () => {
  for (const ci of ["success", "pending", "failure", "none"]) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING", overall: ci }));
    await reviewed(w, 1, { verdict: "take" });
    await settle(w);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.rec?.text, "It conflicts with its base branch. Merge it.", ci);
    await run(w, "yes");
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy], ["running", MAINT], `${ci}: ${wf.rec?.text}`);
    assert.deepEqual((await w.rows("SELECT state, reason FROM preapprovals")).map((l) => l.state), ["ci"], ci);
    assert.ok((await acts(w, 1)).includes("conflict:merge"), `${ci}: ${await acts(w, 1)}`);
    await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", base_sha: "base", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" }));
    await pushRecorded(w);
    await settle(w);
    assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.state, ...(await w.rows("SELECT state FROM preapprovals")).map((l) => l.state)], ["running", "ci"], ci);
    await w.synced(1, "sha1b");
    await settle(w);
    assert.deepEqual(await w.rows("SELECT state, head FROM preapprovals"), [{ state: "review", head: "sha1b" }], ci);
    w.close();
  }
});

test("a recommendation on a conflicting PR offers nothing that is refused", async () => {
  for (const verdict of ["take-fix", "hold"] as const) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
    await reviewed(w, 1, { verdict, fixes: [{ file: "src/lib.rs", change: "rename a to b" }] });
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1 first.", fix: [1], merge: false, close: false } }) }));
    await settle(w);
    const { rec, state } = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(state, "recommending", verdict);
    assert.deepEqual([rec!.parts.fix, rec!.merges, rec!.again ?? null], verdict === "hold" ? [[], false, "review"] : [[1], true, null], rec!.text);
    await run(w, "yes");
    w.close();
  }
});

/** A PR whose review conflicts with its base branch, back with its recommendation. */
async function conflicting(o: { verdict: "take" | "take-fix"; fixes?: { file: string; change: string; title?: string; major?: boolean }[]; canModify?: boolean; before?: (w: World) => Promise<unknown> }): Promise<World> {
  const w = await unstarted(false);
  await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
  await run(w, "review");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING", maintainer_can_modify: o.canModify === false ? 0 : 1 }));
  await o.before?.(w);
  await reviewed(w, 1, { verdict: o.verdict, ...(o.fixes ? { fixes: o.fixes } : {}) });
  await settle(w);
  return w;
}
const conflictRow = (w: World, from_head: string, state: string, o: { to_head?: string; own_diff?: string; at?: string } = {}) =>
  w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head, to_head: o.to_head ?? null, base_sha: "base", state, attempt: 1, created_at: o.at ?? new Date().toISOString(), ...(o.own_diff ? { own_diff: o.own_diff } : {}) }));
/** The base was merged into sha1, and the mirror shows sha1b. */
const baseMerged = async (w: World) => {
  await conflictRow(w, "sha1", "merged", { to_head: "sha1b", own_diff: "same" });
  await pushRecorded(w);
  await settle(w);
  await w.synced(1, "sha1b");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ fetched_at: new Date().toISOString() }));
  await w.db.run(w.db.k.updateTable("main.items").set({ updated_at: new Date(Date.now() + 1000).toISOString(), mergeable: "MERGEABLE", maintainer_can_modify: 1 }).where("number", "=", 1));
};

test("a yes on a conflict only the contributor can resolve approves the merge and waits for them: it claims no merge, asks nothing again and goes on once the conflict is gone", async () => {
  for (const verdict of ["take", "take-fix"] as const) for (const asked of [false, true]) {
    const w = await conflicting({ verdict, canModify: false, before: async (w) => { if (asked) await conflictRow(w, "sha1", "asked"); } });
    const rec = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(rec.state, "recommending");
    assert.match(recommendationText(rec.rec!), /contributor has to resolve.*approve the merge and wait/);
    const yes = await send(w, "yes");
    assert.equal(yes.outcome, "run", yes.line);
    assert.match(yes.line, /until the contributor resolves the conflict/);
    assert.doesNotMatch(yes.line, /merging when|fixing/i);
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy, wf.rec], ["running", MAINT, null], verdict);
    const legs = await w.rows("SELECT state FROM preapprovals");
    assert.deepEqual(legs.map((l) => l.state), [verdict === "take" ? "ci" : "review"], verdict);
    if (asked) assert.equal((await w.prPlan(1)).waitKind, "contributor");
    else assert.ok((await acts(w, 1)).includes("conflict:ask"));

    // The base branch no longer conflicts: the approval stands and the leg goes on.
    if (verdict === "take") {
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "MERGEABLE" }));
      await settle(w);
      await mergesAsPerson(w);
    }
    w.close();
  }
});

test("on a conflicting PR whose base merges of today are used up, a yes goes on tomorrow: the leg waits as the plan does", async () => {
  const now = new Date().toISOString();
  const w = await conflicting({ verdict: "take-fix", before: async (w) => { for (const from of ["old1", "old2"]) await conflictRow(w, from, "merged", { to_head: `${from}b`, at: now }); } });
  assert.match((await liveWorkflow(w.db, "app", 1))!.rec!.text, /goes on tomorrow\. Fix 1, then merge/);
  assert.match((await send(w, "yes")).line, /that merge comes first, tomorrow/);
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.deepEqual((await w.rows("SELECT state FROM preapprovals")).map((l) => l.state), ["review"]);
  assert.deepEqual([(await w.prPlan(1)).waitKind, await acts(w, 1)], ["system", []]);
  await w.db.run(w.db.k.updateTable("main.conflict_merges").set({ created_at: T0 }));
  assert.ok((await acts(w, 1)).includes("conflict:merge"));
});

test("a yes to the pre-merge review's findings on a conflicting PR keeps them: the base is merged in, then the fix-up is made at the new head", async () => {
  const w = await conflicting({ verdict: "take" });
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "MERGEABLE" }));
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await w.premerge(1, "defect");
  // The one fix-up round of the pre-merge review is spent.
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha0", state: "failed", attempt: 1, created_at: T0, source: "premerge" }));
  await run(w, "merge");
  await settle(w);
  const blocked = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([blocked.state, blocked.rec!.parts.fix.length], ["blocked", 1], blocked.rec?.text ?? "");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
  await settle(w);
  assert.match((await send(w, "yes")).line, /Fixing 1, then merging.*that merge comes first/);
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.deepEqual(await acts(w, 1), ["conflict:merge"]);

  await baseMerged(w);
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.deepEqual((await w.rows("SELECT from_head, state FROM operator_fixups")).map((r) => [r.from_head, r.state]), [["sha1b", "queued"]]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.head === "sha1b" && a.params?.source === "operator"), JSON.stringify(await w.prPlan(1)));
  assert.match(String((await w.rows("SELECT instructions FROM operator_fixups"))[0]!.instructions), /off by one/);
});

test("a yes to fix a major finding on a conflicting PR is not asked again when the review of the merged head names it too", async () => {
  const fixes = [{ file: "src/lib.rs", change: "check the bound", title: "check the bound", major: true }];
  const w = await conflicting({ verdict: "take-fix", fixes });
  await run(w, "yes");
  await settle(w);
  assert.deepEqual(await acts(w, 1), ["conflict:merge"]);
  await baseMerged(w);
  await w.review(1, { verdict: "take-fix", fixes, head: "sha1b" });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 2000).toISOString() }).where("head_oid", "=", "sha1b"));
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.equal(wf.state, "running", wf.rec?.text ?? "");
  assert.deepEqual((await w.rows("SELECT from_head, state FROM operator_fixups")).map((r) => [r.from_head, r.state]), [["sha1b", "queued"]]);
  assert.deepEqual(await acts(w, 1), ["fixup:fix"]);
});

test("an approved PR that is a draft and has no leg waits to be marked ready, and its leg starts then", async () => {
  const w = await unstarted(false);
  await run(w, "merge");
  await settle(w);
  await w.db.run(w.db.k.deleteFrom("main.preapprovals"));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, (await w.prPlan(1)).waitKind], ["running", null, "contributor"], wf.rec?.text ?? "");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 0 }));
  await settle(w);
  await mergesAsPerson(w);
});

test("implementing again leaves the PR of stopped work stopped, reopened or not", async () => {
  const w = await implementing("implement");
  await setMergeApproval(w.db, MAINT, "app", true);
  await run(w, "stop", 7);
  // The work ran, was stopped and its PR closed before the next start.
  await w.db.run(w.db.k.updateTable("main.item_workflows").set({ started_at: T0 }).where("number", "=", 7));
  const pr = async (state: string, closed_at: string | null) => void await w.db.run(w.db.k.updateTable("main.items").set({ state, closed_at }).where("number", "=", 8));
  await pr("CLOSED", T1);
  const [a] = await w.rows("SELECT id FROM implementations");
  await recordSteps(w.db, [{ id: Number(a!.id), to: "closed" }], T1);
  const stopped = async () => (await mergeVerdicts(w.db, "app", [{ number: 8, head: "sha8" }])).get(8)!;
  await pr("OPEN", null);
  const was = await stopped();
  assert.equal(was.ok, false);
  await pr("CLOSED", T1);
  await run(w, "implement", 7);
  await pr("OPEN", null);
  assert.deepEqual(await stopped(), was);
  assert.equal((await loadPrFact(w.db, "app", 8))!.endedWorkflow, "stopped");
});

test("a PR whose attempt's end was recorded after the next start is no work of that start once it has its own attempt", async () => {
  const w = await implementing("implement");
  await run(w, "stop", 7);
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED", closed_at: T0 }).where("number", "=", 8));
  await run(w, "implement", 7);
  const [a] = await w.rows("SELECT id FROM implementations");
  await recordSteps(w.db, [{ id: Number(a!.id), to: "closed" }]);
  await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: "h" });
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "OPEN", closed_at: null }).where("number", "=", 8));
  assert.equal((await loadPrWorkflows(w.db, [{ repo: "app", number: 8 }])).size, 0);
  await run(w, "review", 8);
});

test("a command that names parts by number is not carried out on a plan that was renumbered meanwhile", async () => {
  const w = await unstarted();
  await run(w, "review");
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const part = (n: number, title: string) => ({ n, title, source: "review" as const, state: "planned" as const });
  await updateWorkflow(w.db, wf.id, { plan: [part(1, "typo"), part(2, "rename")] });
  before(w.db, () => updateWorkflow(w.db, wf.id, { plan: [part(1, "rename"), part(2, "unsound cast")] }));
  const o = await send(w, "drop 2");
  assert.equal(o.outcome, "refused", o.line);
  assert.deepEqual((await liveWorkflow(w.db, "app", 1))!.plan.map((p) => p.state), ["planned", "planned"]);
});

test("an approval on the PR of an implement workflow is not given to a head pushed meanwhile", async () => {
  const w = await implementing("implement");
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  before(w.db, async () => {
    await w.synced(8, "sha8b");
    await updateWorkflow(w.db, wf.id, { weight: 6 });
  });
  const o = await send(w, "merge", 8);
  assert.equal(o.outcome, "refused", o.line);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.approvedBy, null);
});

test("a PR started into the merge queue whose merge state stays unknown is followed like a reviewed one", async () => {
  const w = await unstarted();
  const row = { repo: "app", number: 1, head_oid: "sha1", state: "OPEN", overall: "success", mergeable: "UNKNOWN" } as PrChecks;
  await noteMergeable(w.db, [row], T1);
  assert.equal(await unknownOf(w.db, "app", 1, "sha1"), null);
  await run(w, "merge");
  await noteMergeable(w.db, [row], T1);
  assert.equal((await unknownOf(w.db, "app", 1, "sha1"))?.reads, 1);
});

// Card presses at the daily GitHub write limit: they queue instead of failing, hold their decision's lock, drain in order through the Act
// step against the one shared count, are carried out only for a presser who may still settle, and stop being retried after three failures.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { disputeCard, keepCard, queuedCards } from "../src/conversations/queue.ts";
import { actUsedToday } from "../src/conversations/usage.ts";
import { doCard, liveWrite } from "../src/conversations/act.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
import { applyAnswer, undo } from "../src/dash/api/decisions.ts";
import { ask, getDecision } from "../src/decisions.ts";
import type { Req } from "../src/dash/types.ts";
import { T1, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

/** The world's GitHub with every item an issue, recording comments and closes; `failClose` makes the close of those issues fail. */
const deps = (w: World, o: { posted?: string[]; closed?: string[]; failClose?: number[]; failComment?: number[]; serverError?: number[]; permission?: string } = {}) => {
  const base = w.gh.actDeps();
  return { ...base, querier: { ...base.querier, query: async (q: string, v: object) => {
    const id = String((v as { id?: string }).id ?? "");
    if (q.includes("collaborators")) return { repository: { collaborators: { edges: [{ permission: o.permission ?? "WRITE", node: { login: String((v as { login: string }).login) } }] } } };
    if (q.includes("addComment") && o.serverError?.some((n) => id === `P${n}`)) throw new Error("HTTP 502 Bad Gateway");
    if (q.includes("addComment") && o.failComment?.some((n) => id === `P${n}`)) throw new Error("GitHub refused the comment");
    if (q.includes("addComment")) { o.posted?.push(id); return { addComment: { commentEdge: { node: { url: `https://x.test/${id}` } } } }; }
    if (q.includes("closeIssue")) {
      if (o.failClose?.some((n) => id === `P${n}`)) throw new Error("GitHub refused the close");
      o.closed?.push(id);
    }
    const r = await base.querier.query(q, v) as { repository?: { issueOrPullRequest?: Record<string, unknown> } };
    const x = r.repository?.issueOrPullRequest;
    if (x) { x.__typename = "Issue"; delete x.headRefOid; }
    return r;
  } } };
};

const limit = async (w: World, n: number) => await w.db.prepare("INSERT OR REPLACE INTO stage_limits (step, per_day) VALUES ('act', ?)").run(n);
const rank = async (w: World, n: number, level: number) =>
  await w.db.prepare("INSERT OR REPLACE INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', ?, ?, '{}', ?)").run(n, level * 10000, T1);
const commentCard = async (w: World, n: number) =>
  Number((await w.db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', ?, 'comment', ?, 'Hello.', 'comment')").run(n, JSON.stringify({ kind: "comment", text: "Hello." }))).lastInsertRowid);
/** A card that comments and answers the item's open scope question, so it locks that decision. */
const settleCard = async (w: World, n: number) => {
  const id = `app#${n}:scope`;
  await ask(w.db, [{ id, kind: "scope", repo: "app", number: n, question: "Out of scope?", options: [{ key: "close", label: "Close" }, { key: "take", label: "Take" }] }]);
  const params = { kind: "resolution", steps: [{ kind: "comment" }], settle: { kind: "answer", decision: id, option: "take", stamp: await decisionStamp(w.db, (await getDecision(w.db, id))!) } };
  return { decision: id, card: Number((await w.db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', ?, 'resolution', ?, 'Hello.', 'comment and answer')").run(n, JSON.stringify(params))).lastInsertRowid) };
};
const state = async (w: World, id: number) => (await w.db.prepare("SELECT state, error FROM conversation_cards WHERE id = ?").get(id) as { state: string; error: string | null });
const run = (w: World, d: ReturnType<typeof deps>, params: { limit?: number; onHandled?: (n: number) => void } = {}) => runAct(w.db, { repo: "app", dryRun: false, ...params }, () => {}, d);
const askClose = async (w: World, n: number) => {
  await ask(w.db, [{ id: `app#${n}:scope`, kind: "scope", repo: "app", number: n, question: "Out of scope?", options: [{ key: "close", label: "Close" }, { key: "take", label: "Take" }] }]);
  await w.answerDecision(`app#${n}:scope`, "close");
};

describe("card presses at the daily limit", () => {
  test("a press with no room queues behind the earlier ones and the Act step carries it out in order, counted once", async () => {
    current = await (await (await (await (await world()).repo()).issue(1)).issue(2)).issue(3);
    const w = current;
    const posted: string[] = [];
    const d = deps(w, { posted });
    await limit(w, 1);
    assert.equal((await doCard(w.db, await commentCard(w, 1), "op", d as never)).card.state, "done");
    const b = await commentCard(w, 2), c = await commentCard(w, 3);
    await rank(w, 3, 4);
    assert.equal((await doCard(w.db, b, "op", { ...d, note: "kept" } as never)).card.state, "queued");
    assert.equal((await doCard(w.db, c, "op", d as never)).card.state, "queued");
    assert.deepEqual((await queuedCards(w.db)).map((r) => r.id), [c, b], "the higher level is first in line");
    const before = await actUsedToday(w.db);
    // No room: the Act step runs and leaves both.
    await run(w, d);
    assert.deepEqual([(await state(w, b)).state, (await state(w, c)).state], ["queued", "queued"]);
    // The limit is raised to 3: the head runs first, then the other, and the job reports no handled items for them.
    await limit(w, 3);
    posted.length = 0;
    let handled = 0;
    const s = await run(w, d, { onHandled: (n) => { handled = n; } });
    assert.deepEqual(posted, ["P3", "P2"]);
    assert.equal(s.cards, 2);
    assert.equal(handled, 0, "carried-out presses are not Act items");
    assert.equal(await actUsedToday(w.db), before + 2, "the two writes are counted once, by their audit rows, and the job adds none");
    assert.equal((await state(w, b)).state, "done");
    // The job's limit bounds the writes it spends on queued presses.
    const e = await commentCard(w, 1), f = await commentCard(w, 2);
    assert.equal((await doCard(w.db, e, "op", d as never)).card.state, "queued");
    assert.equal((await doCard(w.db, f, "op", d as never)).card.state, "queued");
    await limit(w, 10);
    await run(w, d, { limit: 1 });
    assert.deepEqual([(await state(w, e)).state, (await state(w, f)).state], ["done", "queued"]);
  });

  test("a press that cannot wait is refused with the reason, and a queued press holds only its own decision", async () => {
    current = await (await (await (await world()).repo()).issue(1)).issue(2);
    const w = current;
    const d = deps(w);
    await limit(w, 0);
    await w.pipeline(false);
    await assert.rejects(doCard(w.db, await commentCard(w, 1), "op", d as never), /the pipeline is off/);
    await w.pipeline(true);
    await assert.rejects(doCard(w.db, await commentCard(w, 1), "op", d as never), /the daily limit of Act is 0/);
    await limit(w, 1);
    const used = await commentCard(w, 2);
    assert.equal((await doCard(w.db, used, "op", d as never)).card.state, "done");
    const s = await settleCard(w, 1);
    assert.equal((await doCard(w.db, s.card, "op", d as never)).card.state, "queued");
    const dec = (await getDecision(w.db, s.decision))!;
    await assert.rejects(async () => await applyAnswer(w.db, dec, "op2", { answer: "close" }, "dashboard"), /waits for the daily GitHub write limit/);
    // The other decision of the item set is free.
    await ask(w.db, [{ id: "app#2:scope", kind: "scope", repo: "app", number: 2, question: "Out of scope?", options: [{ key: "close", label: "Close" }, { key: "take", label: "Take" }] }]);
    await applyAnswer(w.db, (await getDecision(w.db, "app#2:scope"))!, "op2", { answer: "close" }, "dashboard");
  });

  test("a dispute skips the queued press until it is kept; a presser who lost access fails cleanly and frees the decision", async () => {
    current = await (await (await (await (await world()).repo()).issue(1)).issue(2)).issue(3);
    const w = current;
    await w.db.prepare("INSERT INTO access (login, role) VALUES ('op2', 'operator')").run();
    const posted: string[] = [];
    const d = deps(w, { posted });
    await limit(w, 1);
    await doCard(w.db, await commentCard(w, 3), "op", d as never);
    const a = await settleCard(w, 1), b = await commentCard(w, 2);
    await doCard(w.db, a.card, "op2", d as never);
    await doCard(w.db, b, "op", d as never);
    assert.equal(await disputeCard(w.db, a.card, "op2", "wrong", T1), false, "not by the presser");
    assert.equal(await disputeCard(w.db, a.card, "op", "wrong item", T1), true);
    await limit(w, 10);
    await run(w, d);
    assert.deepEqual([(await state(w, a.card)).state, (await state(w, b)).state], ["queued", "done"], "the disputed press is skipped, the next one runs");
    // Kept, but its presser is no longer an operator.
    await keepCard(w.db, a.card);
    await w.db.prepare("DELETE FROM access WHERE login = 'op2'").run();
    await run(w, d);
    assert.equal((await state(w, a.card)).state, "failed");
    assert.match((await state(w, a.card)).error ?? "", /op2 no longer has write access/);
    assert.equal((await getDecision(w.db, a.decision))!.exec_state, null, "the decision is free again");
    await applyAnswer(w.db, (await getDecision(w.db, a.decision))!, "op", { answer: "close" }, "dashboard");
  });
});

describe("Act failures", () => {
  test("a target that fails three times stops without blocking the others, and Undo plus a new answer runs it again", async () => {
    current = await (await (await (await world()).repo()).issue(5)).issue(6);
    const w = current;
    for (const n of [5, 6]) await askClose(w, n);
    const closed: string[] = [];
    const d = deps(w, { closed, failComment: [5] });
    const first = await run(w, d);
    assert.deepEqual(closed, ["P6"], "the failing target does not stop the next one");
    assert.equal(first.failed.length, 1);
    for (let i = 0; i < 2; i++) await run(w, d);
    const row = async () => (await w.rows("SELECT state, attempts, reason FROM actions WHERE number = 5"))[0] as { state: string; attempts: number; reason: string };
    assert.equal((await row()).state, "stopped");
    assert.match((await row()).reason, /stopped after 3 failed tries/);
    const n = closed.length;
    await run(w, d);
    assert.equal(closed.length, n, "a stopped target is not tried again");
    // Undo and answer again: the target is planned once more and closes.
    const req = { params: { id: "app#5:scope" }, query: new URLSearchParams(), json: {}, user: { login: "op", role: "operator", canWrite: async () => true } } as unknown as Req;
    await undo(w.db, req);
    await applyAnswer(w.db, (await getDecision(w.db, "app#5:scope"))!, "op", { answer: "close" }, "dashboard");
    const ok = deps(w, { closed });
    await run(w, ok);
    assert.ok(closed.includes("P5"));
  });
});

describe("blocked repos, GitHub errors and permission reads", () => {
  test("a queued press whose repo became blocked fails with the reason and blocks nobody", async () => {
    current = await (await (await (await world()).repo()).issue(1)).issue(2);
    const w = current;
    const d = deps(w);
    await limit(w, 1);
    await doCard(w.db, await commentCard(w, 2), "op", d as never);
    const a = await settleCard(w, 1);
    assert.equal((await doCard(w.db, a.card, "op", d as never)).card.state, "queued");
    await w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
    await limit(w, 10);
    // The blocked press holds no place: a new press runs at once instead of queueing behind it.
    assert.equal((await doCard(w.db, await commentCard(w, 2), "op", d as never)).card.state, "done");
    await run(w, d);
    assert.equal((await state(w, a.card)).state, "failed");
    assert.match((await state(w, a.card)).error ?? "", /Act cannot run for app now: the pipeline is off for app/);
    assert.equal((await getDecision(w.db, a.decision))!.exec_state, null, "its decision is free again");
  });

  test("a GitHub server error stops the run without counting a try", async () => {
    current = await (await (await (await world()).repo()).issue(5)).issue(6);
    const w = current;
    for (const n of [5, 6]) await askClose(w, n);
    const closed: string[] = [];
    const first = await run(w, deps(w, { closed, serverError: [5] }));
    assert.equal(first.failed.length, 1);
    assert.deepEqual(closed, [], "the run stopped at the first target");
    const attempts = ((await w.rows("SELECT attempts FROM actions WHERE number = 5"))[0] as { attempts: number } | undefined)?.attempts ?? 0;
    assert.equal(attempts, 0);
    await run(w, deps(w, { closed }));
    assert.deepEqual(closed.sort(), ["P5", "P6"]);
  });

  test("a partial permission read is transient; only an empty list or a lower permission is no", async () => {
    const q = (r: unknown) => ({ query: async () => r }) as never;
    assert.equal(await liveWrite(q({ repository: { collaborators: null } }), "app", "op"), "transient");
    assert.equal(await liveWrite(q({ repository: null }), "app", "op"), "transient");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [] } } }), "app", "op"), "no");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [{ permission: "READ", node: { login: "op" } }] } } }), "app", "op"), "no");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [{ permission: "WRITE", node: { login: "op" } }] } } }), "app", "op"), "ok");
    assert.equal(await liveWrite({ query: async () => { throw new Error("network"); } } as never, "app", "op"), "transient");
  });
});

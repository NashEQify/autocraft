import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { cifixBucket } from "../src/core/decide.ts";
import { detectAutopilot } from "../src/runner/autopilot.ts";
import { isCounted, liveGate, markReviewsStale, staleReviews } from "../src/review/discussion.ts";
import { recordReviewFailure, setReviewMinInterval } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { rowid } from "../src/db/kx.ts";
import { world } from "./world-db.ts";

const RED = { overall: "failure", checks: '[{"name":"gate / test","state":"failure"}]' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function review(w: Awaited<ReturnType<typeof world>>, n: number, head: string, verdict: "take" | "hold", blocked: string[] = []): Promise<void> {
  await saveOpus(w.db, "rv", { repo: "app", number: n, head_oid: head }, {
    mode: "full", base: null, model: "m",
    review: { ref: `app#${n}`, verdict, sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: blocked },
  });
}
const planOf = async (w: Awaited<ReturnType<typeof world>>, n: number, now?: number) => (await loadPlanSet(w.db, now ? { now } : {})).prs.find((p) => p.facts.number === n)!.plan;
const reviews = async (w: Awaited<ReturnType<typeof world>>, n: number) => (await planOf(w, n)).actions.filter((a) => a.kind === "review").length;
const noGaps = async (w: Awaited<ReturnType<typeof world>>) => { await setReviewMinInterval(w.db, 0, "test"); return w; };

test("a hold review blocked by an open PR waits for it, then gets one review", async () => {
  const w = await noGaps(await (await (await (await world()).repo()).pr(1, { head: "h1" })).pr(2));
  await review(w, 1, "h1", "hold", ["app#2", "app#1", "app#99"]);
  assert.deepEqual(JSON.parse((await w.db.get(w.db.k.selectFrom("main.opus_reviews").select("blocked_by").where("number", "=", 1)))!.blocked_by!), ["app#2"]);
  await w.synced(1, "h2");
  assert.equal(await reviews(w, 1), 0);
  assert.match((await planOf(w, 1)).wait ?? "", /app#2/);
  await w.db.prepare("UPDATE items SET state = 'MERGED' WHERE number = 2").run();
  assert.equal(await reviews(w, 1), 1);
  await review(w, 1, "h2", "take");
  assert.equal(await reviews(w, 1), 0);
});

test("the blocked_by of a reply is read only for a hold", () => {
  const reply = (verdict: string) => JSON.stringify({ ref: "app#1", verdict, sure: true, reason: "r", blocked_by: ["app#2", "bad", 3], claims: [] });
  assert.deepEqual(parseOpusReply(reply("hold"), "app#1")!.blocked_by, ["app#2"]);
  assert.deepEqual(parseOpusReply(reply("take"), "app#1")!.blocked_by, []);
});

test("on a reviewed head only a maintainer's comment makes the review stale; commands to bots never count", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1", author: "regular" }));
  await review(w, 1, "h1", "hold");
  const at = new Date(Date.now() + 5000).toISOString();
  const add = async (id: string, author: string, assoc: string, body: string) => await w.db.prepare(
    "INSERT INTO comments (repo, number, id, kind, author, created_at, body, counted, author_association) VALUES ('app', 1, ?, 'comment', ?, ?, ?, ?, ?)")
    .run(id, author, at, body, Number(isCounted({ author, association: assoc, prAuthor: "regular", body })), assoc);
  await add("c1", "regular", "CONTRIBUTOR", "Fixed in abc123");
  assert.equal((await staleReviews(w.db)).has("app#1@h1"), false);
  await add("c2", "maint", "MEMBER", "Please also check the parser");
  assert.equal((await staleReviews(w.db)).has("app#1@h1"), true);
  for (const body of ["@coderabbitai resume", "@dependabot rebase"]) {
    assert.equal(isCounted({ author: "regular", association: "CONTRIBUTOR", prAuthor: "regular", body }), false);
    assert.equal(isCounted({ author: "maint", association: "MEMBER", prAuthor: "regular", body }), false);
  }
});

test("a head is reviewed once CI at it has finished green", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1" }));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "pending" }).where("number", "=", 1));
  assert.equal(await reviews(w, 1), 0);
  assert.match((await planOf(w, 1)).wait ?? "", /CI on the latest commit/);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set(RED).where("number", "=", 1));
  assert.equal(await reviews(w, 1), 1); // the first review of a PR runs on finished red CI
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set(RED).where("number", "=", 1));
  assert.equal(await reviews(w, 1), 0);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "success", checks: "[]" }).where("number", "=", 1));
  assert.equal(await reviews(w, 1), 1);
});

test("the fourth review of a PR in a day waits unless a maintainer asks", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1" }));
  await review(w, 1, "h1", "take"); await review(w, 1, "h2", "take"); await review(w, 1, "h3", "take");
  await w.synced(1, "h4");
  assert.equal(await reviews(w, 1), 0);
  assert.match((await planOf(w, 1)).wait ?? "", /review cap for today reached/);
  await sleep(5);
  await markReviewsStale(w.db, "op", "app", 1);
  assert.equal(await reviews(w, 1), 1);
});

test("a second review inside the minimum interval waits until it passes; Review again runs at once", async () => {
  const w = await (await (await world()).repo()).pr(1, { head: "h1" });
  await setReviewMinInterval(w.db, 120, "test");
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  assert.equal(await reviews(w, 1), 0);
  assert.match((await planOf(w, 1)).wait ?? "", /next review after \d\d:\d\d/);
  assert.equal(await reviews(w, 1) + (await planOf(w, 1, Date.now() + 121 * 60_000)).actions.filter((a) => a.kind === "review").length, 1);
  await sleep(5);
  await markReviewsStale(w.db, "op", "app", 1);
  assert.equal(await reviews(w, 1), 1);
});

test("a PR whose review waits for CI gets its repo's checks read again", async () => {
  const w = await noGaps(await (await (await (await world()).repo()).pr(1, { head: "h1" })).pipeline(true));
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "pending" }).where("number", "=", 1));
  const found = await detectAutopilot(w.db);
  assert.ok(found.proposals.some((p) => p.step === "checks" && p.params.repo === "app"), JSON.stringify(found.proposals));
  // A red head only changes with a push, which sync sees: no polling for it.
  await w.db.run(w.db.k.updateTable("main.pr_checks").set(RED).where("number", "=", 1));
  assert.ok(!(await detectAutopilot(w.db)).proposals.some((p) => p.step === "checks"));
});

test("red CI at a new head leaves the CI fix to work from the earlier review; the first review still runs on red CI", async () => {
  const w = await noGaps(await (await (await (await world()).repo()).pr(1, { head: "h1" })).pr(2, { head: "g1" }));
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set(RED).where("number", "=", 1));
  assert.equal(await reviews(w, 1), 0);
  const facts = (await loadPlanSet(w.db)).prs.find((p) => p.facts.number === 1)!.facts;
  assert.notEqual(cifixBucket(facts), null);
  assert.equal(!!facts.brokeByUs, false);
  assert.equal(facts.gateRed, true);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set(RED).where("number", "=", 2));
  assert.equal(await reviews(w, 2), 1);
});

test("a head made only by our own push skips the interval", async () => {
  const w = await (await (await world()).repo()).pr(1, { head: "h1" });
  await setReviewMinInterval(w.db, 120, "test");
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  assert.equal(await reviews(w, 1), 0);
  await w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'h1', 'h2', 'pushed', 1, ?)").run(new Date().toISOString());
  assert.equal(await reviews(w, 1), 1);
});

test("review calls and failed tries count: runs fill the day's cap, failures back off then hold", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1" }));
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  for (let i = 0; i < 3; i++) {
    const id = (await w.db.get(w.db.k.insertInto("main.agent_runs").values({ step: "opus-review", stage: 5, prompt_id: "review.opus", prompt_version: "1", provider: "claude", model: "opus", state: "failed", started_at: new Date().toISOString() }).returning("id")))!.id;
    await w.db.run(w.db.k.insertInto("main.agent_run_items").values({ run_id: id, repo: "app", number: 1 }));
  }
  await w.db.run(w.db.k.deleteFrom("main.opus_review_history"));
  assert.match((await planOf(w, 1)).wait ?? "", /review cap for today/);
  await w.db.run(w.db.k.deleteFrom("main.agent_runs")); await w.db.run(w.db.k.deleteFrom("main.agent_run_items"));
  assert.equal(await reviews(w, 1), 1);
  await recordReviewFailure(w.db, "app", 1, "h2");
  assert.equal(await reviews(w, 1), 0);
  assert.equal((await planOf(w, 1, Date.now() + 11 * 60_000)).actions.filter((a) => a.kind === "review").length, 1);
  for (let i = 0; i < 3; i++) await recordReviewFailure(w.db, "app", 1, "h2");
  assert.equal((await planOf(w, 1, Date.now() + 24 * 3600_000 * 0.5)).actions.filter((a) => a.kind === "review").length, 0);
  assert.match((await planOf(w, 1)).wait ?? "", /failed 4 times/);
});

test("the merge-time check ignores the PR author's new comment", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1", author: "regular" }));
  await review(w, 1, "h1", "take");
  const at = new Date(Date.now() + 5000).toISOString();
  const node = (assoc: string, login: string) => ({ id: `c-${login}`, author: { login, __typename: "User" }, authorAssociation: assoc, createdAt: at, body: "Please look again" });
  const q = (login: string, assoc: string) => ({ spent: 0, remaining: 1, async query() {
    return { repository: { pullRequest: { author: { login: "regular" }, reviewDecision: null, comments: { nodes: [node(assoc, login)] }, reviews: { nodes: [] }, formal: { nodes: [] }, reviewThreads: { nodes: [] } } } };
  } }) as never;
  assert.equal((await liveGate(w.db, q("regular", "CONTRIBUTOR"), "app", 1, "h1")).moved, false);
  assert.equal((await liveGate(w.db, q("maint", "MEMBER"), "app", 1, "h1")).moved, true);
});

test("a reply-fix turn does not count as a second review call", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1" }));
  await review(w, 1, "h1", "take");
  await w.synced(1, "h2");
  await w.db.run(w.db.k.deleteFrom("main.opus_review_history"));
  const run = async (job: number) => {
    const id = (await w.db.get(w.db.k.insertInto("main.agent_runs").values({ job_id: job, step: "opus-review", stage: 5, prompt_id: "review.opus", prompt_version: "1", provider: "claude", model: "opus", state: "done", started_at: new Date().toISOString() }).returning("id")))!.id;
    await w.db.run(w.db.k.insertInto("main.agent_run_items").values({ run_id: id, repo: "app", number: 1 }));
  };
  await run(1); await run(1); await run(2); // job 1: the review and its fix turn
  assert.equal(await reviews(w, 1), 1);
  await run(3);
  assert.match((await planOf(w, 1)).wait ?? "", /review cap for today/);
});

test("a review records why it ran: new head, same head again, same head after an operator mark", async () => {
  const w = await noGaps(await (await (await world()).repo()).pr(1, { head: "h1", author: "regular" }));
  const triggers = async () => (await w.db.all(w.db.k.selectFrom("main.opus_review_history as h").select("trigger").where("repo", "=", "app").where("number", "=", 1).orderBy(rowid("opus_review_history", "h")))).map((r) => r.trigger);
  await review(w, 1, "h1", "hold");
  await review(w, 1, "h2", "hold");
  await review(w, 1, "h2", "hold");
  // The mark must be later than the review it follows; on a fast machine both can land in the same millisecond.
  for (const t = Date.now(); Date.now() === t; );
  await markReviewsStale(w.db, "test", "app", 1);
  await review(w, 1, "h2", "hold");
  assert.deepEqual(await triggers(), ["new-head", "new-head", "discussion", "operator"]);
});

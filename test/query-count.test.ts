// The hot paths read the database in sets: each unit runs at two sizes inside db.meter, and its statement count must not
// grow with the size. The data modules' own loaders are covered in test/data; these are the whole paths over them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import { join } from "node:path";
import { effect } from "../src/db/effects.ts";
import { COLUMNS } from "../src/db/types.ts";
import { activity } from "../src/dash/api/activity.ts";
import { itemPage } from "../src/dash/api/item-page.ts";
import { setMainFixApproval } from "../src/mainfix/approval.ts";
import { live } from "../src/dash/api/live.ts";
import { home, items } from "../src/dash/api/maintain.ts";
import { item } from "../src/dash/api/maintain-item.ts";
import { trace } from "../src/dash/api/trace.ts";
import type { Req } from "../src/dash/types.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { awaitCall, claimCall, enqueueCall } from "../src/remote/calls.ts";
import { planned } from "../src/core/select.ts";
import { applyProposals, detectAutopilot } from "../src/runner/autopilot.ts";
import { JobLogCopy } from "../src/runner/job-log.ts";
import { Runner } from "../src/runner/runner.ts";
import { loadSteps } from "../src/runner/steps.ts";
import { addEvent, insertWorkflow } from "../src/workflow/store.ts";
import { expectFlat, type FlatUnit } from "./helpers/query-count.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { tmpdir, world, type World } from "./world-db.ts";

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();
const numbers = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);

const req = (query: Record<string, string> = {}, params: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "op", role: "operator", canRead: async () => true, canWrite: async () => true },
}) as unknown as Req;

/** A unit over a new database with the tracked repo "app": `seed` fills it and returns the work to count. */
const unit = (seed: (w: World, size: number) => Promise<() => Promise<unknown>>) => async (size: number): Promise<FlatUnit> => {
  const w = await world();
  await w.repo();
  const run = await seed(w, size);
  return { db: w.db, run, close: async () => { w.close(); await w.db.close(); } };
};

/** Where a seeded pull request is in the pipeline. */
const POINTS: { pr?: Parameters<World["pr"]>[1]; review?: Parameters<World["review"]>[1]; checked?: true; started?: "review" | "merge" }[] = [
  {},
  { review: { verdict: "take" } },
  { review: { verdict: "take-fix" }, started: "review" },
  { pr: { ci: "failure" }, review: { verdict: "take" }, started: "review" },
  { pr: { mergeable: "CONFLICTING" } },
  { review: { verdict: "take" }, checked: true, started: "merge" },
];

/** `n` pull requests at each point, numbered from 1, so both sizes of a unit meet the same cases. */
async function seedPrs(w: World, n: number): Promise<void> {
  for (const i of numbers(n, 0)) {
    for (const [k, p] of POINTS.entries()) {
      const pr = i * POINTS.length + k + 1;
      await w.pr(pr, p.pr);
      if (p.review) await w.review(pr, p.review);
      if (p.checked) { await w.verified(pr); await w.premerge(pr, "clean"); }
      if (p.started) await insertWorkflow(w.db, { kind: "pr", entry: p.started, startedBy: "op", startedAt: iso(60), startedVia: "github", repo: "app", number: pr, state: "running" });
    }
  }
}

/** More tracked repos, each with the rows of "app". */
async function addRepos(w: World, names: readonly string[]): Promise<void> {
  const k = w.db.k as unknown as Kysely<Record<string, Record<string, unknown>>>;
  for (const table of ["tracked_repos", "repos", "items", "classifications", "pr_checks", "opus_reviews", "item_priority", "repo_step_approvals", "main_ci"] as const) {
    const repoCol = table === "tracked_repos" || table === "repos" ? "name" : "repo";
    const rows = await w.db.all(k.selectFrom(table).select([...COLUMNS[table]]).where(repoCol, "=", "app"));
    for (const name of names) if (rows.length) await w.db.run(k.insertInto(table).values(rows.map((r) => ({ ...r, [repoCol]: name }))));
  }
}

/** A job over `list` with one model call and one build task per item. */
async function seedJob(w: World, state: "running" | "done", list: readonly number[]): Promise<number> {
  const { db } = w;
  const ended = state === "done" ? iso(2) : null;
  const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "opus-review", params: JSON.stringify({ repo: "app" }), requested_by: "pipeline", requested_at: iso(6), state, started_at: iso(5), ended_at: ended }).returning("id")))!.id);
  for (const n of list) {
    await db.run(db.k.insertInto("job_items").values({ job_id: id, repo: "app", number: n, at: iso(5) }));
    const run = Number((await db.get(db.k.insertInto("agent_runs").values({
      job_id: id, step: "opus-review", stage: 5, prompt_id: "review.opus", prompt_version: "1", provider: "claude", model: "opus", items: JSON.stringify([`app#${n}`]), state, started_at: iso(4), ended_at: ended,
    }).returning("id")))!.id);
    await db.run(db.k.insertInto("agent_run_items").values({ run_id: run, repo: "app", number: n }));
    await db.run(db.k.insertInto("build_tasks").values({ job_id: id, step: "verify", repo: "app", number: n, head_sha: `sha${n}`, requires: "{}", plan: "[]", state: state === "done" ? "done" : "running", queued_at: iso(4) }));
  }
  return id;
}

test("a full planner pass, and one over the items that changed, read in sets", async (t) => {
  // Reads kept for a second or so (the Task Runner snapshot) must not expire in a slow pass.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const full = unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n, 100)) await w.issue(i);
    return () => detectAutopilot(w.db);
  });
  await expectFlat(full, 2, 12);
  const changed = unit(async (w, n) => {
    await seedPrs(w, 12);
    await detectAutopilot(w.db);
    for (const i of numbers(n * POINTS.length)) await w.db.run(w.db.k.updateTable("items").set({ title: "new title" }).where("number", "=", i));
    return () => detectAutopilot(w.db);
  });
  await expectFlat(changed, 2, 12);
  // Two repos at the small size: the copies of "app" have no started work, so they meet cases "app" does not.
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, 2);
    await setMainFixApproval(w.db, "op", "app", true);
    await w.db.run(w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: "main1", branch: "main", state: "red", failing: '[{"name":"gate / test","url":null}]', checks: "[]", committed_at: iso(90), headline: "h", first_seen_at: iso(80), state_changed_at: iso(70), updated_at: iso(5) }));
    await addRepos(w, numbers(n - 1).map((i) => `app${i}`));
    return () => detectAutopilot(w.db);
  }), 2, 5);
});

test("the lanes of repos with the write steps on, and the queueing of a pass's proposals, read in sets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const repos = (n: number): string[] => ["app", ...numbers(n - 1).map((i) => `app${i}`)];
  const seeded = async (w: World, n: number): Promise<void> => {
    await seedPrs(w, 2);
    for (const i of numbers(4, 100)) await w.issue(i);
    await addRepos(w, repos(n).slice(1));
    const k = w.db.k as unknown as Kysely<Record<string, Record<string, unknown>>>;
    for (const repo of repos(n)) {
      for (const step of ["prstatus", "labels"]) await w.db.run(k.insertInto("repo_step_approvals").values({ repo, step, by: "op", at: iso(60) }));
      await w.db.run(k.insertInto("settings").values({ key: `build_feature:pr-builds:${repo}`, value: "on" }));
      for (const pr of numbers(POINTS.length)) {
        await w.db.run(k.insertInto("item_stage").values({ repo, number: pr, stage: "reviewed", at: iso(90), reviewed: 1 }));
        // A started issue's line names what its workflow waits for, read for every started item of every repo at once.
        await w.db.run(k.insertInto("item_workflows").values({ repo, number: 100 + (pr % 4), kind: "issue", entry: "implement", state: "done", started_by: "op", started_at: iso(50), started_via: "github", updated_at: iso(50) }));
      }
      await w.db.run(k.insertInto("item_workflows").values({ repo, number: 1, kind: "pr", entry: "review", state: "waiting", started_by: "op", started_at: iso(50), started_via: "github", updated_at: iso(50) }));
    }
  };
  await expectFlat(unit(async (w, n) => {
    await seeded(w, n);
    return () => detectAutopilot(w.db);
  }), 2, 5);
  await expectFlat(unit(async (w, n) => {
    await seeded(w, n);
    // The steps' own request checks read per proposal (in shared waves); the rest of queueing does not.
    const steps = await loadSteps(), free = (await detectAutopilot(w.db)).proposals.filter((p) => !steps.get(p.step)!.check);
    assert.ok(free.length > 1, "several proposals, or the count below says nothing");
    return () => applyProposals(w.db, n === 2 ? free.slice(0, 1) : free, {});
  }), 2, 5);
});

test("a job's start decides the PRs and items that can be due in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n, 100)) await w.issue(i);
    return () => planned(w.db, "review", { repo: "app" });
  }), 2, 12);
});

const bundle = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } as const;
const queueCall = (w: World, n: number): Promise<number> =>
  enqueueCall(w.db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle: { ...bundle } as never, items: [{ repo: "app", number: n }], level: n % 5, maxAttempts: 2 });

test("a Task Runner's claim reads the queue and the other Task Runners in sets", async () => {
  let k = 0;
  const claims = (queued: number, runners: number, leases: boolean) => unit(async (w) => {
    await seedPrs(w, queued);
    for (const n of numbers(queued)) await queueCall(w, n);
    const tokens: number[] = [];
    for (const i of numbers(runners)) {
      const login = `m${i}`;
      await w.db.run(w.db.k.insertInto("access").values({ login, role: "maintainer" }));
      tokens.push((await createToken(w.db, login, "helper", { kind: "runner" })).row.id);
    }
    const claim: Claim = { requestId: `query-count-${++k}`, protocol: PROTOCOL_VERSION, helperVersion: "9.0.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } } as Claim;
    return async () => assert.equal((await claimCall(w.db, { tokenId: tokens[0]!, login: "m1", role: "maintainer" }, claim, async () => leases)).lease !== null, leases);
  });
  for (const leases of [true, false]) {
    await expectFlat((n) => claims(n, 1, leases)(n), 2, 10);
    await expectFlat((n) => claims(2, n, leases)(n), 1, 4);
  }
});

test("calls that wait for their result share one poll", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    const ids: number[] = [];
    for (const i of numbers(n)) ids.push(await queueCall(w, i));
    await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "failed", error: "ended" }));
    // Each await is one model call, which opens and closes its own relays; a call whose relays open late joins the next poll.
    return () => Promise.all(ids.map((id) => { effect("model-call"); return awaitCall(w.db, id, { log: () => {} }); }));
  }), 1, 8, { perEffect: 3 });
});

test("a runner tick reads its running and queued jobs in sets", async () => {
  const ticks = (running: number, queued: number) => unit(async (w) => {
    const logs = tmpdir("query-count-logs");
    const runner = new Runner({ db: w.db, logs, log: () => {}, detect: async () => ({ proposals: [], logs: [] }) });
    const insert = async (step: string, n: number, state: string): Promise<number> => Number((await w.db.get(w.db.k.insertInto("jobs").values({
      step, params: JSON.stringify({ repo: "app", number: n }), repo: "app", requested_by: "pipeline", requested_at: iso(5), state, started_at: state === "running" ? iso(4) : null,
    }).returning("id")))!.id);
    for (const n of numbers(running)) {
      const id = await insert("opus-review", n, "running");
      const logPath = join(logs, `job-${id}.log`);
      runner.running.set(id, {
        child: { pid: undefined }, termAt: null, exited: Promise.resolve(), startedAt: Date.now(), deadlineMin: 60, logPath, logCopy: JobLogCopy.open(id, logPath), flaggedAt: null,
        noProgressMin: 60, stopMsg: null, remoteSeen: null, remoteWaitMs: 0,
      } as never);
    }
    // No Task Runner is connected, so the queued jobs stay queued.
    for (const n of numbers(queued, 100)) await insert("opus-review", n, "queued");
    // What runs once in a while (the hourly prunes, the first identity read) is done before the counted tick.
    await runner.tick();
    return () => runner.tick();
  });
  await expectFlat((n) => ticks(n, 2)(n), 1, 6);
  await expectFlat((n) => ticks(1, n)(n), 2, 12);
});

test("the live board reads its lanes in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n)) { await seedJob(w, "running", [i]); await seedJob(w, "done", [i]); }
    return async () => assert.ok((await live(w.db, req())).lanes.length >= n);
  }), 2, 12);
});

/** One PR with `n` of each thing its pages list. */
async function seedBusyPr(w: World, n: number): Promise<void> {
  const { db } = w;
  await w.pr(1);
  await w.review(1, { verdict: "take-fix", fixes: numbers(n).map((i) => ({ file: `src/f${i}.rs`, change: "rename" })) });
  for (const i of numbers(n)) {
    await w.issue(100 + i);
    await seedJob(w, "done", [1]);
    await db.run(db.k.insertInto("comments").values({ repo: "app", number: 1, id: `c${i}`, kind: "comment", author: "someone", created_at: iso(100 - i), body: `note ${i}, see #${100 + i}` }));
    await db.run(db.k.insertInto("opus_review_history").values({ repo: "app", number: 1, head_oid: "sha1", at: iso(90 - i), model: "opus", mode: "full", verdict: "take", sure: 1, reason: "r" }));
    const wf = await insertWorkflow(db, { kind: "pr", entry: "review", startedBy: "op", startedAt: iso(80 - i), startedVia: "github", repo: "app", number: 1, state: i === n ? "running" : "stopped" } as never);
    await addEvent(db, { workflowId: wf, repo: "app", number: 1, login: "op", via: "github", kind: "answered" });
  }
  await db.run(db.k.updateTable("items").set({ closing_issues: JSON.stringify(numbers(n, 101)) }).where("number", "=", 1));
}

test("an item's pages read its history in sets", async () => {
  const at = { repo: "app", n: "1" };
  const page = (read: (w: World) => Promise<unknown>) => unit(async (w, n) => { await seedBusyPr(w, n); return () => read(w); });
  await expectFlat(page((w) => itemPage(w.db, req({}, at))), 2, 12);
  await expectFlat(page((w) => item(w.db, req({}, at))), 2, 12);
  await expectFlat(page((w) => trace(w.db, req({}, at))), 2, 12);
});

test("the activity feed, Home and the Items page read their rows in sets", async () => {
  const pages = (read: (w: World) => Promise<unknown>) => unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n)) {
      await seedJob(w, "done", [i]);
      await w.issue(100 + i);
      await insertWorkflow(w.db, {
        kind: "issue", entry: "implement", startedBy: "op", startedAt: iso(50), startedVia: "github", repo: "app", number: 100 + i, state: "recommending",
        rec: { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true },
      });
    }
    return () => read(w);
  });
  await expectFlat(pages((w) => activity(w.db, req())), 2, 12);
  await expectFlat(pages((w) => home(w.db, req())), 2, 12);
  await expectFlat(pages((w) => items(w.db, req())), 2, 12);
});

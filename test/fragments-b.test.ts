// Each typed twin of a shared SQL fragment selects the same rows as its text version, on a fixture where the fragment
// keeps some rows and drops others. Runs on SQLite, and on Postgres under `pnpm test:pg:suite`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Db, Param } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import { hiddenTest, hiddenTestExpr, hiddenJsonTest, type HiddenRepos } from "../src/hidden-sql.ts";
import { quietExprFor, quietSqlFor } from "../src/security/quiet.ts";
import { hiddenExpr as statusHiddenExpr, hiddenSql as statusHiddenSql } from "../src/public/status.ts";
import { latestCteExpr, trackedExpr } from "../src/dash/api/stats.ts";
import { PHASE_SQL, phaseExpr } from "../src/dash/api/home-types.ts";
import { PRIVATE_STEPS, PRIVATE_STEPS_SQL, privateStepExpr } from "../src/build/tasks.ts";
import { MANUAL_ONLY_KEY, manualExpr, manualSql } from "../src/remote/manual-only.ts";
import { MAX_CALLS_KEY } from "../src/remote/max-calls.ts";
import { COMMAND_WORK_SQL, commandWorkExpr } from "../src/github/commands.ts";
import { OPEN_GROUP_SQL, UNSURE_AT_SQL } from "../src/core/rules.ts";
import { openGroupExpr, unsureAtQuery } from "../src/core/rule-queries.ts";
import { ADOPTABLE_CALL, EARLIER_RUN_CALL, KEPT_RUNS, RESUMING_JOBS, adoptableCallExpr, earlierRunCallExpr, keptRunsExpr, resumingJobsExpr } from "../src/runner/resuming.ts";
import { tmpdir } from "./world-db.ts";

const T = "2026-01-01T00:00:00.000Z", LATER = "2026-01-03T00:00:00.000Z", FAR = "2099-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-02T00:00:00.000Z");

async function fixture(db: Db): Promise<void> {
  const ins = async (q: { execute: unknown }) => void await db.run(q as never);
  await ins(db.k.insertInto("main.tracked_repos").values([{ name: "app" }, { name: "lib" }]));
  const item = (repo: string, number: number, o: Partial<{ kind: string; state: string; labels: string | null; head_oid: string | null; updated_at: string | null; merged_at: string; closed_at: string }> = {}) =>
    ({ repo, number, kind: "pr", state: "OPEN", labels: "[]", head_oid: `h${number}`, updated_at: T, ...o });
  await ins(db.k.insertInto("main.items").values([
    item("app", 1, { labels: '["Security fix"]' }),
    item("app", 2),
    item("app", 3, { labels: "not json" }),
    item("app", 4, { state: "MERGED", merged_at: T }),
    item("app", 5, { kind: "issue", state: "CLOSED", closed_at: T, head_oid: null }),
    item("app", 6, { head_oid: null }),
    item("app", 7),
    item("app", 8),
    item("lib", 1, { kind: "issue" }),
    item("ext", 1, { kind: "issue" }),
  ]));
  const finding = (number: number, state: string, fix_pr: number | null, fork: string | null = null) =>
    ({ repo: "app", number, scan_id: 1, area: "a", title: "t", severity: "high", state, refs: "[]", reach: "r", impact: "i", fingerprint: `f${number}`, created_at: T, updated_at: T, fix_pr, fork });
  await ins(db.k.insertInto("main.security_findings").values([finding(1, "landing", 2), finding(2, "published", 6), finding(3, "open", null), finding(4, "dismissed", null), finding(5, "landed", 8, "someone/fork")]));
  await ins(db.k.insertInto("main.security_quiet_prs").values([{ repo: "app", pr: 3, finding: 3 }, { repo: "app", pr: 7, finding: 4 }]));
  await ins(db.k.insertInto("main.classifications").values([
    { repo: "app", number: 4, classifier: "jev", run_id: "r", at: T, flags: '["security"]' },
    { repo: "app", number: 5, classifier: "jev", run_id: "r", at: T, flags: '["docs"]' },
    { repo: "app", number: 7, classifier: "jev", run_id: "r", at: T, flags: "nope" },
  ]));
  await ins(db.k.insertInto("main.item_plans").values([
    { repo: "app", number: 1, kind: "pr", state: "s", actions: "[]", reasons: "[]", planned_at: T, view: '{"status":{"phase":"Review"}}' },
    { repo: "app", number: 2, kind: "pr", state: "s", actions: "[]", reasons: "[]", planned_at: T, view: "{}" },
  ]));
  await ins(db.k.insertInto("main.pr_checks").values([
    { repo: "app", number: 1, head_oid: "c1", overall: "success", checks: "[]", fetched_at: LATER },
    { repo: "app", number: 2, head_oid: "c2", overall: "success", checks: "[]", fetched_at: "2025-12-31T00:00:00.000Z" },
    { repo: "app", number: 6, head_oid: "c6", overall: "success", checks: "[]", fetched_at: "2025-12-31T00:00:00.000Z" },
  ]));
  await ins(db.k.insertInto("main.item_stage").values([{ repo: "app", number: 1, stage: "review", at: T }, { repo: "lib", number: 1, stage: "new", at: T }]));

  const run = (id: number, account_id: string | null) => ({ id, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "x", model: "m", state: "done", started_at: T, account_id });
  await ins(db.k.insertInto("agent_runs").values([run(1, "acc1"), run(2, "acc2"), run(3, null)]));
  await ins(db.k.insertInto("agent_run_items").values([{ run_id: 1, repo: "app", number: 1 }, { run_id: 2, repo: "app", number: 1 }, { run_id: 2, repo: "ext", number: 1 }]));
  await ins(db.k.insertInto("agent_run_tools").values([{ run_id: 1, seq: 1, tool: "t", args: "{}" }, { run_id: 1, seq: 2, tool: "t", args: "{}" }]));
  await ins(db.k.insertInto("claude_accounts").values({ id: "acc1", label: "Main" }));

  const decision = (id: string, kind: string, repo: string | null, items: string | null, answer: string | null = null) =>
    ({ id, kind, question: "q", options: "[]", asked_at: T, repo, number: repo ? 1 : null, items, answer });
  await ins(db.k.insertInto("main.decisions").values([
    decision("d1", "merge", "app", "[]"),
    decision("d2", "merge", "ext", "[]"),
    decision("d3", "merge", null, '[{"repo":"app","number":2},{"repo":"ext","number":1}]'),
    decision("d4", "merge", null, '[{"repo":"lib","number":1}]'),
    decision("d5", "merge", null, "garbage"),
    decision("app:dupegroup:1", "duplicate", "app", null),
    decision("app:dupegroup:2", "duplicate", "app", null, "keep:3"),
    decision("app:dupegroup:3", "duplicate", "app", null, "keep:4"),
    decision("app:dupegroup:4", "duplicate", "app", null, "keep:5"),
    decision("app:dupegroup:5", "duplicate", "app", null, "close"),
    decision("app:other:6", "duplicate", "app", null),
  ]));
  await ins(db.k.insertInto("dupe_groups").values([
    { decision_id: "app:dupegroup:2", repo: "app", source: "s", applied_answer: "keep:3" },
    { decision_id: "app:dupegroup:3", repo: "app", source: "s", applied_answer: null },
  ]));

  const task = (step: string) => ({ step, repo: "app", head_sha: "h", requires: "{}", plan: "{}", state: "queued", queued_at: T });
  await ins(db.k.insertInto("build_tasks").values([task(PRIVATE_STEPS[0]!), task(PRIVATE_STEPS[1]!), task("build")]));

  const logins = ["alice", "bob", "carol", "dave", "erin"];
  await ins(db.k.insertInto("main.mcp_tokens").values(logins.map((login, k) => ({ id: k + 1, login, token_hash: `t${k}`, created_at: T, expires_at: FAR, kind: "runner" }))));
  // bob has no Task Runner status, so his picks lapse.
  await ins(db.k.insertInto("main.remote_helpers").values(logins.filter((l) => l !== "bob").map((login) =>
    ({ token_id: logins.indexOf(login) + 1, login, readiness: "ready", harness: "h", models: "[]", reserve: "{}", reported_at: NOW }))));
  await ins(db.k.insertInto("main.remote_cooloffs").values({ login: "carol", until: NOW + 60_000 }));
  await ins(db.k.insertInto("main.user_settings").values([
    { login: "alice", key: MANUAL_ONLY_KEY, value: "1", updated_at: T },
    { login: "bob", key: MANUAL_ONLY_KEY, value: "0", updated_at: T },
    { login: "carol", key: "repos", value: "1", updated_at: T },
    { login: "dave", key: MAX_CALLS_KEY, value: "1", updated_at: T },
    { login: "erin", key: MAX_CALLS_KEY, value: "2", updated_at: T },
  ]));
  const call = (id: number, o: { picked_by?: string; pick_until?: number; state?: string; user_login?: string }) =>
    ({ id, step: "s", stage: 1, prompt_id: "p", prompt_version: "1", tier: "t", effort: "medium", asked_model: "m", bundle: "{}", state: "queued", since: NOW, seen_at: NOW, max_attempts: 1, timeout_ms: 1, ...o });
  await ins(db.k.insertInto("main.remote_calls").values([
    call(1, { picked_by: "alice", pick_until: NOW - 1 }),
    call(2, { picked_by: "alice", pick_until: NOW + 60_000 }),
    call(3, { picked_by: "bob", pick_until: NOW + 60_000 }),
    call(4, { picked_by: "carol", pick_until: NOW + 60_000 }),
    call(5, { picked_by: "dave", pick_until: NOW + 60_000 }),
    call(6, { picked_by: "erin", pick_until: NOW + 60_000 }),
    call(7, { state: "leased", user_login: "DAVE" }),
    call(8, { state: "leased", user_login: "erin" }),
  ]));
  // Only job 1 waits to resume: its open or answered, unread calls keep their runs.
  const job = (id: number, state: string, resumes: number) => ({ id, step: "s", params: "{}", requested_by: "pipeline", requested_at: T, state, resumes });
  await ins(db.k.insertInto("main.jobs").values([job(1, "queued", 1), job(2, "queued", 0), job(3, "running", 1), job(4, "running", 1)]));
  // Jobs 3 and 4 restarted after and before their calls were made.
  await ins(db.k.updateTable("main.jobs").set({ started_at: LATER }).where("id", "=", 3));
  await ins(db.k.updateTable("main.jobs").set({ started_at: T }).where("id", "=", 4));
  const jobCall = (id: number, job_id: number, run_id: number | null, state: string, consumed_at: number | null = null) => ({ ...call(id, { state }), job_id, run_id, consumed_at });
  await ins(db.k.insertInto("main.remote_calls").values([
    jobCall(9, 1, 1, "queued"), jobCall(10, 1, 2, "done", NOW), jobCall(11, 1, 2, "failed"), jobCall(12, 1, null, "leased"),
    jobCall(13, 2, 3, "queued"), jobCall(14, 3, 3, "leased"), jobCall(15, 4, null, "queued"),
  ]));

  const command = (comment_id: number, state: string, reply: string | null) =>
    ({ comment_id, repo: "app", number: 1, pr: 1, command: "c", login: "u", github_id: 1, created_at: T, requested_at: T, state, reply });
  await ins(db.k.insertInto("main.github_commands").values([command(1, "queued", null), command(2, "done", null), command(3, "done", "ok")]));

  await ins(db.k.insertInto("opus_review_history").values([
    { repo: "app", number: 1, head_oid: "h1", at: T, verdict: "take", sure: 0 },
    { repo: "app", number: 2, head_oid: "h2", at: T, verdict: "take", sure: 1 },
  ]));
  await ins(db.k.insertInto("opus_reviews").values({ repo: "app", number: 3, head_oid: "h3", at: T, mode: "m", verdict: "take-fix", sure: 0 }));
}

type Case = {
  name: string;
  /** The text version's statement and its arguments (positional, or one object of named ones); absent once the text version is gone. */
  text?: [string, ...Param[]] | [string, Record<string, Param>];
  built: (db: Db) => Parameters<Db["all"]>[0];
  /** What the text version selects, as `key` gives it: proves the fixture has rows the fragment keeps and drops. */
  expect: string[];
  key?: (r: Record<string, unknown>) => string;
};

const deny: HiddenRepos = ["ext"];
const allow = (...visible: string[]): HiddenRepos => Object.assign([] as string[], { visible });

function cases(db: Db): Case[] {
  const out: Case[] = [];
  for (const [label, h, expect] of [["denied", deny, ["ext:1"]], ["allowed", allow("app"), ["ext:1", "lib:1"]], ["none allowed", allow(), ["app:1", "app:2", "ext:1", "lib:1"]]] as const) {
    const t = hiddenTest("i.repo", h), j = hiddenJsonTest(db, "i.repo", h);
    const items = "SELECT i.repo, i.number FROM main.items i WHERE i.number <= 2 AND ";
    out.push({ name: `hiddenTest, ${label}`, text: [`${items}${t.sql} ORDER BY i.repo, i.number`, ...t.args], expect: [...expect],
      built: (d) => d.k.selectFrom("main.items as i").select(["i.repo", "i.number"]).where("i.number", "<=", 2).where(hiddenTestExpr(d, "i.repo", h)).orderBy("i.repo").orderBy("i.number") });
    out.push({ name: `hiddenJsonTest, ${label}`, text: [`${items}${j.sql} ORDER BY i.repo, i.number`, j.arg], expect: [...expect],
      built: (d) => d.k.selectFrom("main.items as i").select(["i.repo", "i.number"]).where("i.number", "<=", 2).where(hiddenTestExpr(d, "i.repo", h)).orderBy("i.repo").orderBy("i.number") });
  }
  out.push({ name: "quietSqlFor on columns", text: [`SELECT i.number AS k FROM main.items i WHERE i.repo = 'app' AND ${quietSqlFor("i.repo", "i.number")} ORDER BY i.number`], expect: ["2", "3"],
    built: (d) => d.k.selectFrom("main.items as i").select("i.number as k").where("i.repo", "=", "app").where((eb) => quietExprFor(d, eb, "i.repo", "i.number")).orderBy("i.number") });
  for (const n of [2, 6]) {
    out.push({ name: `quietSqlFor on values (${n})`, text: [`SELECT ${quietSqlFor("?", "?")} AS k`, "app", n], expect: [n === 2 ? "1" : "0"],
      built: (d) => d.k.selectNoFrom((eb) => quietExprFor(d, eb, eb.val("app"), eb.val(n)).as("k")) });
  }
  out.push({ name: "public status hiddenSql", text: [`SELECT i.number AS k FROM main.items i WHERE i.repo = 'app' AND ${statusHiddenSql("i.repo", "i.number", "i.labels")} ORDER BY i.number`],
    expect: ["1", "2", "3", "4", "6", "8"],
    built: (d) => d.k.selectFrom("main.items as i").select("i.number as k").where("i.repo", "=", "app").where((eb) => statusHiddenExpr(d, eb, "i.repo", "i.number", "i.labels")).orderBy("i.number") });
  for (const repo of [undefined, "app"]) {
    out.push({ name: `latestCte (${repo ?? "every repo"})`,
      expect: repo ? ["app:1"] : ["app:1", "lib:1"],
      built: (d) => latestCteExpr(d, repo).selectFrom("latest").select(["repo", "number"]).orderBy("repo").orderBy("number") });
  }
  out.push({ name: "TRACKED", expect: ["app", "lib"],
    built: (d) => d.k.selectFrom("main.items as i").select("i.repo as k").distinct().where((eb) => trackedExpr(d, eb, "i.repo")).orderBy("i.repo") });
  out.push({ name: "PHASE_SQL", text: [`SELECT i.number, ${PHASE_SQL} AS phase FROM main.items i LEFT JOIN main.item_plans p ON p.repo = i.repo AND p.number = i.number WHERE i.repo = 'app' AND i.number <= 5 ORDER BY i.number`],
    expect: ["1:Review", "2:Triage", "3:Triage", "4:Merged", "5:Closed"],
    built: (d) => d.k.selectFrom("main.items as i").leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
      .select((eb) => ["i.number", phaseExpr(d, eb).as("phase")]).where("i.repo", "=", "app").where("i.number", "<=", 5).orderBy("i.number") });
  for (const not of [false, true]) {
    out.push({ name: `PRIVATE_STEPS_SQL${not ? " (NOT IN)" : ""}`, text: [`SELECT step AS k FROM build_tasks WHERE step ${not ? "NOT " : ""}IN (${PRIVATE_STEPS_SQL}) ORDER BY step`],
      expect: not ? ["build"] : [...PRIVATE_STEPS].sort(),
      built: (d) => d.k.selectFrom("build_tasks").select("step as k").where((eb) => (not ? eb.not(privateStepExpr(eb)) : privateStepExpr(eb))).orderBy("step") });
  }
  out.push({ name: "manualSql", text: [`SELECT t.login AS k FROM main.mcp_tokens t WHERE ${manualSql("t.login")} ORDER BY t.login`], expect: ["alice"],
    built: (d) => d.k.selectFrom("main.mcp_tokens as t").select("t.login as k").where((eb) => manualExpr(d, eb, "t.login")).orderBy("t.login") });
  out.push({ name: "KEPT_RUNS", text: [`SELECT id AS k FROM agent_runs WHERE id NOT IN (${KEPT_RUNS}) ORDER BY id`], expect: ["2", "3"],
    built: (d) => d.k.selectFrom("agent_runs").select("id as k").where("id", "not in", keptRunsExpr(d)).orderBy("id") });
  out.push({ name: "RESUMING_JOBS", text: [`SELECT id AS k FROM main.jobs WHERE id IN (${RESUMING_JOBS}) ORDER BY id`], expect: ["1"],
    built: (d) => d.k.selectFrom("main.jobs").select("id as k").where("id", "in", resumingJobsExpr(d)).orderBy("id") });
  out.push({ name: "EARLIER_RUN_CALL", text: [`SELECT id AS k FROM main.remote_calls WHERE job_id IS NOT NULL AND ${EARLIER_RUN_CALL} ORDER BY id`], expect: ["9", "10", "11", "12", "14"],
    built: (d) => d.k.selectFrom("main.remote_calls").select("id as k").where("job_id", "is not", null).where((eb) => earlierRunCallExpr(d, eb)).orderBy("id") });
  out.push({ name: "ADOPTABLE_CALL", text: [`SELECT id AS k FROM main.remote_calls WHERE ${ADOPTABLE_CALL} ORDER BY id`], expect: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "12", "13", "14", "15"],
    built: (d) => d.k.selectFrom("main.remote_calls").select("id as k").where((eb) => adoptableCallExpr(eb)).orderBy("id") });
  out.push({ name: "COMMAND_WORK_SQL", text: [`SELECT comment_id AS k FROM main.github_commands WHERE ${COMMAND_WORK_SQL} ORDER BY comment_id`], expect: ["1", "2"],
    built: (d) => d.k.selectFrom("main.github_commands").select("comment_id as k").where((eb) => commandWorkExpr(eb)).orderBy("comment_id") });
  out.push({ name: "OPEN_GROUP_SQL", text: [`SELECT g.id AS k FROM decisions g WHERE ${OPEN_GROUP_SQL} ORDER BY g.id`], expect: ["app:dupegroup:1", "app:dupegroup:3", "app:dupegroup:4"],
    built: (d) => d.k.selectFrom("decisions as g").select("g.id as k").where((eb) => openGroupExpr(d, eb)).orderBy("g.id") });
  return out;
}

test("each fragment twin selects the same rows as its text version", async () => {
  const db = await connectDb(join(tmpdir("fragments-b"), "t.db"));
  try {
    await fixture(db);
    const failed: string[] = [];
    for (const c of cases(db)) {
      const key = c.key ?? ((r: Record<string, unknown>) => Object.values(r).map(String).join(":"));
      const [sql, ...args] = c.text ?? [""];
      try {
        // Some text versions are SQLite only (a bare 1 or 0 as a condition, json_each, json_extract): on Postgres their
        // twin must then select what the text version selects on SQLite.
        const text = !c.text ? null : await db.prepare(sql).all(...(args as Param[])).catch((e: unknown) => {
          if (db.dialect === "postgres") return null;
          throw e;
        }) as Record<string, unknown>[] | null;
        const built = await db.all(c.built(db)) as Record<string, unknown>[];
        if (text) assert.deepEqual(text.map(key), c.expect, "text version");
        if (text) assert.deepEqual(built, text, "twin");
        else assert.deepEqual(built.map(key), c.expect, "twin");
      } catch (e) {
        failed.push(`${c.name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    assert.deepEqual(failed, []);
    // UNSURE_AT_SQL is a whole statement: the same answer for each head.
    for (const [n, head] of [[1, "h1"], [2, "h2"], [3, "h3"]] as const) {
      const text = await db.prepare(UNSURE_AT_SQL).get("app", n, head);
      assert.equal(!!await db.get(unsureAtQuery(db, "app", n, head)), !!text, `UNSURE_AT_SQL #${n}`);
      assert.equal(!!text, n !== 2, `UNSURE_AT_SQL #${n}: text version`);
    }
  } finally {
    await db.close();
  }
});

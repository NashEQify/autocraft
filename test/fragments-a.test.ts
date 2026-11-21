// The typed twins of shared SQL-text fragments (`pilotSql` → `pilotExpr`, ...) select the same rows as the text versions,
// on SQLite and, under `pnpm test:pg:suite`, on Postgres. Condition fragments are read three-valued (1, 0 or NULL) per
// row, so a twin that turns NULL into false, or the reverse, shows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Compilable, Expression, SqlBool } from "kysely";
import type { Db, NamedParams, Param } from "../src/db/index.ts";
import type { AnyEb } from "../src/db/kx.ts";
import { heldOpenExpr, heldOpenSql, lockLiveExpr, lockLiveSql, lockRunningAtExpr, lockRunningAtSql } from "../src/answers/hold.ts";
import { canSettleExpr, canSettleSql, settledByExpr, settledBySql, settlesAfter, settlesCheckedAtExpr, settlesCheckedAtSql, settlesLoginExpr, settlesLoginSql } from "../src/settlers.ts";
import { pilotExpr, pilotExprFor, pilotSql, pilotSqlFor } from "../src/pilot.ts";
import { backlogHeldExpr, backlogHeldSql, groupHeldExpr, groupHeldSql, notHeldExpr, notHeldSql, notOwnIntegrationExpr, notOwnIntegrationSql } from "../src/dupes/held.ts";
import { openSubjectExpr, openSubjectSql, prepareStateExpr, prepareStateSql } from "../src/decide/prepared.ts";
import { snoozedExpr, SNOOZED_SQL } from "../src/decisions.ts";
import { fastScoreExpr, fastScoreSql } from "../src/fasttrack.ts";
import { statsExpr, STATS_SQL } from "../src/whitelist.ts";
import { settledOn, settledOnExpr, verdictExpr, VERDICT_SQL } from "../src/classify/settled.ts";
import { quietExprFor, quietSqlFor } from "../src/security/quiet.ts";
import { testDatabase, type TestDatabase } from "./test-db.ts";

const NOW = new Date();
const FRESH = NOW.toISOString();
const STALE = "2020-01-01T00:00:00.000Z";
const [T0, T1, T2, T3, T4, T5] = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z", "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z"];
const SINCE = "2026-01-02T00:00:00.000Z";
const PILOT = JSON.stringify(["app#1", "app#7", "app#6"]);

let t: TestDatabase;
let db: Db;

async function fixture(db: Db): Promise<void> {
  const k = db.k;
  await db.run(k.insertInto("main.tracked_repos").values([{ name: "app", pipeline: 1 }, { name: "lib", pipeline: 0 }]));
  await db.run(k.insertInto("main.settings").values([
    { key: "pilot_items", value: PILOT }, { key: "maintainer_writes", value: "1" }, { key: "github_identity", value: "app" },
    { key: "pipeline_login", value: "pipe" }, { key: "app_slugs", value: '["mybot"]' },
  ]));
  await db.run(k.insertInto("main.access").values([{ login: "op", role: "operator" }, { login: "mae", role: "maintainer" }, { login: "mo", role: "maintainer" }]));
  await db.run(k.insertInto("main.repo_permissions").values([
    { login: "mae", repo: "app", permission: "write", checked_at: FRESH }, { login: "mae", repo: "lib", permission: "write", checked_at: STALE },
    { login: "mo", repo: "app", permission: "read", checked_at: FRESH },
  ]));
  const item = (repo: string, number: number, kind: string, state: string, author: string, head_oid: string | null = null) => ({ repo, number, kind, state, author, head_oid });
  await db.run(k.insertInto("main.items").values([
    item("app", 1, "issue", "OPEN", "alice"), item("app", 2, "pr", "OPEN", "bob", "h2"), item("app", 3, "pr", "OPEN", "pipe"),
    item("app", 4, "pr", "OPEN", "mybot[bot]"), item("app", 5, "pr", "MERGED", "carol", "h5"), item("app", 6, "issue", "OPEN", "dave"),
    item("app", 7, "pr", "CLOSED", "erin"), item("app", 8, "issue", "OPEN", "bob"), item("app", 9, "pr", "OPEN", "bob"), item("app", 10, "issue", "OPEN", "carol"),
    item("app", 11, "pr", "OPEN", "carol"), item("app", 12, "issue", "CLOSED", "alice"), item("app", 13, "issue", "CLOSED", "alice"),
    item("app", 14, "issue", "CLOSED", "alice"), item("app", 15, "pr", "OPEN", "alice"), item("app", 16, "pr", "OPEN", "alice"), item("app", 17, "issue", "OPEN", "alice"),
    item("lib", 1, "issue", "OPEN", "alice"), item("lib", 2, "issue", "OPEN", "bob"), item("lib", 3, "pr", "OPEN", "bob"),
  ]));
  await db.run(k.insertInto("main.merge_batches").values([3, 4, 5].map((n) => ({ repo: "app", branch: `b${n}`, state: "open", base_sha: "a", commit_sha: "b", pr_number: n, created_at: T0, updated_at: T0 }))));
  await db.run(k.insertInto("main.fast_track").values([{ repo: "lib", number: 1, added_by: "op", added_at: T0, weight: 5 }, { repo: "app", number: 1, added_by: "op", added_at: T0, weight: 9 }]));
  await db.run(k.insertInto("main.outside_holds").values({ repo: "app", number: 6, author: "dave", kind: "pr", reason: "budget" }));
  const fix = (repo: string, number: number, pr: number) => ({ repo, number, main_sha: "m", text_hash: "t", state: "done", created_at: T0, updated_at: T0, pr_url: `https://github.com/o/${repo}/pull/${pr}` });
  await db.run(k.insertInto("main.fix_attempts").values([fix("app", 1, 2), fix("app", 8, 9), fix("lib", 1, 3)]));
  await db.run(k.insertInto("main.postmerge_followups").values({ repo: "app", number: 7, issue_number: 8, review_at: T0, finding: 1, title: "f", state: "filed", at: T0 }));
  const finding = (number: number, state: string, fix_pr: number | null) => ({ repo: "app", number, scan_id: 1, area: "a", title: "t", severity: "high", state, refs: "[]", reach: "r", impact: "i", fingerprint: `f${number}`, created_at: T0, updated_at: T0, fix_pr });
  await db.run(k.insertInto("main.security_findings").values([finding(1, "landing", 11), finding(2, "open", null), finding(3, "published", null)]));
  await db.run(k.insertInto("main.security_quiet_prs").values([{ repo: "app", pr: 15, finding: 2 }, { repo: "app", pr: 16, finding: 3 }]));

  type D = { id: string; kind: string; repo?: string | null; number?: number | null; answer?: string | null; answered_by?: string | null; exec_state?: string | null; exec_reason?: string | null; applied_at?: string | null; items?: string | null; snoozed_at?: string | null };
  const dec = (d: D) => ({ repo: null, number: null, question: "q", options: "[]", asked_at: T0, ...d });
  await db.run(k.insertInto("main.decisions").values([
    dec({ id: "app:merge@h2", kind: "merge", repo: "app", number: 2, answer: "merge", answered_by: "op" }),
    dec({ id: "app:close:5", kind: "close", repo: "app", number: 5, answer: "close", answered_by: "mae" }),
    dec({ id: "app:close:6", kind: "close", repo: "app", number: 6, answer: "close", answered_by: "gone" }),
    dec({ id: "app:scope:1", kind: "scope", repo: "app", number: 1, answer: "close", answered_by: "MAE", exec_state: "disputed" }),
    dec({ id: "batch:1", kind: "merge", items: '[{"repo":"app","number":2},{"repo":"lib","number":1}]', answer: "merge", answered_by: "mae" }),
    dec({ id: "batch:2", kind: "merge", items: '[{"repo":"app","number":9}]', answer: "merge", answered_by: "mae" }),
    dec({ id: "batch:3", kind: "merge", items: "[]", answer: "merge", answered_by: "mae" }),
    dec({ id: "batch:4", kind: "merge", items: "nope", answer: "merge", answered_by: "op" }),
    dec({ id: "app:q:1", kind: "scope", repo: "app", number: 1, exec_state: "settling", exec_reason: "5:mae" }),
    dec({ id: "app:q:2", kind: "merge", repo: "app", number: 2, exec_state: "settling", exec_reason: "6:op" }),
    dec({ id: "app:q:5", kind: "scope", repo: "app", number: 5, exec_state: "settling", exec_reason: "7:op" }),
    dec({ id: "app:q:6", kind: "scope", repo: "app", number: 6, exec_state: "settling", exec_reason: "8:op" }),
    dec({ id: "app:backlog:1", kind: "scope", repo: "app", number: 1, answer: "backlog", answered_by: "op", exec_state: "disputed" }),
    dec({ id: "app:x~replaced-1", kind: "close", repo: "app", number: 5, answer: "close", answered_by: "gone", exec_state: "disputed" }),
    dec({ id: "app:applied", kind: "close", repo: "app", number: 6, answer: "close", answered_by: "gone", applied_at: T1 }),
    dec({ id: "batch:backlog", kind: "merge", items: '[{"repo":"app","number":5}]', answer: "backlog", answered_by: "op" }),
    dec({ id: "app:dupegroup:12", kind: "duplicate", repo: "app", number: 12 }),
    dec({ id: "app:dupegroup:13", kind: "duplicate", repo: "app", number: 13, answer: "backlog", answered_by: "op" }),
    dec({ id: "app:dup:8", kind: "duplicate", repo: "app", number: 8 }),
    dec({ id: "app:close:14", kind: "close", repo: "app", number: 14 }),
    dec({ id: "app:snz:7", kind: "scope", repo: "app", number: 7, snoozed_at: T1 }),
    dec({ id: "app:snz:9", kind: "scope", repo: "app", number: 9, snoozed_at: T1 }),
    dec({ id: "app:dupegroup:15", kind: "duplicate", repo: "app", number: 15, snoozed_at: T1 }),
    dec({ id: "app:snz:3", kind: "scope", repo: "app", number: 3, snoozed_at: T1 }),
    dec({ id: "app:snz:4", kind: "scope", repo: "app", number: 4, snoozed_at: T1 }),
    dec({ id: "app:snz:17", kind: "scope", repo: "app", number: 17, snoozed_at: T1 }),
  ]));
  const member = (decision_id: string, number: number, role: string) => ({ decision_id, repo: "app", number, kind: "issue", role, base_role: role });
  await db.run(k.insertInto("main.dupe_group_items").values([
    member("app:dupegroup:12", 10, "close"), member("app:dupegroup:12", 12, "keep"), member("app:dupegroup:13", 11, "close"), member("app:dupegroup:15", 16, "close"),
  ]));
  const card = (id: number, state: string, acted_at: string | null, extra: { acted_by?: string; dispute_by?: string } = {}) =>
    ({ id, turn_id: 1, repo: "app", number: 1, kind: "answer", params: "{}", description: "d", state, acted_at, ...extra });
  await db.run(k.insertInto("main.conversation_cards").values([
    card(5, "queued", null, { acted_by: "Mae", dispute_by: "op" }), card(6, "running", FRESH), card(7, "running", STALE), card(8, "done", FRESH),
  ]));
  const comment = (number: number, id: string, author: string, created_at: string, body: string, counted = 1) => ({ repo: "app", number, id, author, created_at, body, counted });
  await db.run(k.insertInto("main.comments").values([
    comment(2, "c1", "alice", T1, "hi"), comment(2, "c2", "mybot", T3, "x"), comment(2, "c3", "bob", T4, "  _AI-generated note"), comment(2, "c4", "bob", T5, "late", 0),
    comment(9, "c5", "bob", T2, "news"), comment(7, "c6", "bob", T0, "old"),
  ]));
  await db.run(k.insertInto("main.pr_commits").values([{ repo: "app", number: 16, oid: "o1", committed_at: T0, first_seen_at: T2 }, { repo: "app", number: 7, oid: "o2", committed_at: T0 }]));
  await db.run(k.insertInto("main.item_activity").values([{ repo: "app", number: 4, id: "e1", kind: "force-push", at: T2 }, { repo: "app", number: 7, id: "e2", kind: "labeled", at: T2 }]));
  await db.run(k.insertInto("main.decision_comments").values({ id: "dc1", decision_id: "app:snz:7", login: "op", at: T0, body: "b" }));
  await db.run(k.insertInto("main.decision_opinions").values({ id: "do1", decision_id: "app:snz:3", login: "mae", at: T2, permission: "write" }));
  await db.run(k.insertInto("main.conversation_turns").values([
    { repo: "app", number: 17, kind: "operator", login: "op", at: T2, body: "b", block: "{}" }, { repo: "app", number: 7, kind: "model", login: "op", at: T2, body: "b", block: "{}" },
  ]));
  const plan = (number: number, actions: unknown[]) => ({ repo: "app", number, kind: "pr", state: "open", actions: JSON.stringify(actions), reasons: "[]", planned_at: T0 });
  await db.run(k.insertInto("main.item_plans").values([plan(2, [{ kind: "wait" }, { kind: "review", head: "h2" }]), plan(5, [{ kind: "carry", head: "old" }])]));
  await db.run(k.insertInto("main.opus_reviews").values([
    { repo: "app", number: 2, head_oid: "h2", at: T2, mode: "full", verdict: "take" }, { repo: "app", number: 5, head_oid: "h5", at: T4, mode: "full", verdict: null },
    { repo: "app", number: 2, head_oid: "old", at: T5, mode: "full", verdict: "take" },
  ]));
  await db.run(k.insertInto("main.decision_choices").values([
    { id: "ch1", decision_id: "app:q:2", repo: "app", number: 2, stamp: "s", seen: '{"head":"old"}', source: "model", drafts: '{"x":{"params":{}}}', added: '["a"]', pick: "x", created_at: T0 },
    { id: "ch2", decision_id: "app:q:5", repo: "app", number: 5, stamp: "s", seen: '{"head":"h5"}', source: "model", drafts: "{}", added: "[]", pick: "x", created_at: T0 },
  ]));
  await db.run(k.insertInto("main.decision_prepares").values([
    { decision_id: "app:q:2", at: T2, manual: 0 }, { decision_id: "app:q:2", at: T3, manual: 1 }, { decision_id: "app:q:2", at: T0, manual: 0 }, { decision_id: "app:q:1", at: T3, manual: 0 },
  ]));
  await db.run(k.insertInto("main.classifications").values([
    { repo: "app", number: 1, classifier: "jev", run_id: "r", at: T0 }, { repo: "app", number: 2, classifier: "haiku", run_id: "r", at: T0, input_hash: "h" },
    { repo: "app", number: 5, classifier: "haiku", run_id: "r", at: T0 }, { repo: "app", number: 6, classifier: "sonnet", run_id: "r", at: T0, input_hash: "h" },
  ]));
}

before(async () => {
  t = await testDatabase();
  db = await t.open({ app: true });
  await fixture(db);
});
after(async () => t.close());

/** A condition read three-valued: 1, 0, or NULL when the condition is NULL. */
const tri = (cond: string): string => `CASE WHEN (${cond}) THEN 1 WHEN NOT (${cond}) THEN 0 END`;
const triExpr = (eb: AnyEb, cond: () => Expression<SqlBool>) => eb.case().when(cond()).then(eb.lit(1)).when(eb.not(cond())).then(eb.lit(0)).end();

type Case = {
  name: string;
  text: string;
  params?: Param[] | NamedParams;
  built: () => Compilable<unknown>;
  /** Column whose values must differ across the rows, so the fixture shows what the fragment includes and excludes. */
  varies?: string;
  prep?: () => Promise<void>;
  undo?: () => Promise<void>;
};

/** Per items row `i`: the condition. */
const onItems = (name: string, text: string, twin: (eb: AnyEb) => Expression<SqlBool>, more: Partial<Case> = {}): Case => ({
  name,
  text: `SELECT i.repo, i.number, ${tri(text)} AS v FROM items i ORDER BY i.repo, i.number`,
  built: () => db.k.selectFrom("items as i").select((eb) => ["i.repo", "i.number", triExpr(eb, () => twin(eb)).as("v")]).orderBy("i.repo").orderBy("i.number"),
  varies: "v",
  ...more,
});

/** Per decisions row `d`: the condition. */
const onDecisions = (name: string, text: string, twin: (eb: AnyEb) => Expression<SqlBool>, params?: Case["params"]): Case => ({
  name,
  text: `SELECT d.id, ${tri(text)} AS v FROM decisions d ORDER BY d.id`,
  params,
  built: () => db.k.selectFrom("decisions as d").select((eb) => ["d.id", triExpr(eb, () => twin(eb)).as("v")]).orderBy("d.id"),
  varies: "v",
});

/** The same over the decisions table unaliased, as the text version requires. */
const onDecisionsTable = (name: string, text: string, twin: (eb: AnyEb) => Expression<SqlBool>): Case => ({
  name,
  text: `SELECT decisions.id, ${tri(text)} AS v FROM decisions ORDER BY decisions.id`,
  built: () => db.k.selectFrom("decisions").select((eb) => ["decisions.id", triExpr(eb, () => twin(eb)).as("v")]).orderBy("decisions.id"),
  varies: "v",
});

const noPilot: Partial<Case> = {
  prep: async () => void await db.run(db.k.deleteFrom("main.settings").where("key", "=", "pilot_items")),
  undo: async () => void await db.run(db.k.insertInto("main.settings").values({ key: "pilot_items", value: PILOT })),
};

const cases = (): Case[] => [
  onItems("pilotSql", pilotSql(db, "i"), (eb) => pilotExpr(db, eb, "i")),
  onItems("pilotSql without a pilot list", pilotSql(db, "i"), (eb) => pilotExpr(db, eb, "i"), noPilot),
  onItems("pilotSqlFor", pilotSqlFor(db, "i.repo", "i.number"), (eb) => pilotExprFor(db, eb, "i.repo", "i.number")),
  onItems("quietSqlFor", quietSqlFor("i.repo", "i.number"), (eb) => quietExprFor(db, eb, "i.repo", "i.number")),
  onItems("groupHeldSql", groupHeldSql("i"), (eb) => groupHeldExpr(db, eb, "i")),
  onItems("backlogHeldSql", backlogHeldSql(db, "i"), (eb) => backlogHeldExpr(db, eb, "i")),
  onItems("notOwnIntegrationSql", notOwnIntegrationSql(db, "i"), (eb) => notOwnIntegrationExpr(db, eb, "i")),
  onItems("notHeldSql", notHeldSql(db, "i"), (eb) => notHeldExpr(db, eb, "i")),
  {
    name: "fastScoreSql",
    text: `SELECT i.repo, i.number, ${fastScoreSql("i.repo", "i.number", "i.number")} AS s FROM items i ORDER BY i.repo, i.number`,
    built: () => db.k.selectFrom("items as i").select((eb) => ["i.repo", "i.number", fastScoreExpr(db, eb, "i.repo", "i.number", "i.number").as("s")]).orderBy("i.repo").orderBy("i.number"),
    varies: "s",
  },
  onDecisions("settledBySql", settledBySql(db, "d"), (eb) => settledByExpr(db, eb, "d")),
  onDecisions("lockLiveSql", lockLiveSql("d", NOW), (eb) => lockLiveExpr(db, eb, "d", NOW)),
  {
    name: "lockRunningAtSql",
    text: `SELECT d.id, ${lockRunningAtSql("d")} AS at FROM decisions d ORDER BY d.id`,
    built: () => db.k.selectFrom("decisions as d").select((eb) => ["d.id", lockRunningAtExpr(db, eb, "d").as("at")]).orderBy("d.id"),
    varies: "at",
  },
  onDecisions("canSettleSql for a maintainer", canSettleSql(db, "mae", "maintainer", "d"), (eb) => canSettleExpr(db, eb, "mae", "maintainer", "d")),
  onDecisionsTable("canSettleSql for an operator, decisions unaliased", `${canSettleSql(db, "op", "operator")} AND decisions.answer IS NULL`,
    (eb) => eb.and([canSettleExpr(db, eb, "op", "operator"), eb("decisions.answer", "is", null)])),
  onDecisions("settlesLoginSql", settlesLoginSql("d.answered_by", "d.repo"), (eb) => settlesLoginExpr(eb, "d.answered_by", "d.repo", NOW.getTime()), settlesAfter(NOW.getTime())),
  {
    name: "settlesCheckedAtSql",
    text: `SELECT d.id, ${settlesCheckedAtSql("d.answered_by", "d.repo")} AS at FROM decisions d ORDER BY d.id`,
    built: () => db.k.selectFrom("decisions as d").select((eb) => ["d.id", settlesCheckedAtExpr(eb, "d.answered_by", "d.repo").as("at")]).orderBy("d.id"),
    varies: "at",
  },
  onDecisionsTable("heldOpenSql for an operator", heldOpenSql(db, "op", true), (eb) => heldOpenExpr(db, eb, "op", true)),
  onDecisionsTable("heldOpenSql for a maintainer", heldOpenSql(db, "mae", false), (eb) => heldOpenExpr(db, eb, "mae", false)),
  onDecisionsTable("SNOOZED_SQL", SNOOZED_SQL, (eb) => snoozedExpr(eb)),
  {
    name: "openSubjectSql",
    text: `SELECT d.id, ${tri(openSubjectSql("d", "i"))} AS v FROM decisions d JOIN items i ON i.repo = d.repo AND i.number = d.number ORDER BY d.id`,
    built: () => db.k.selectFrom("decisions as d").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
      .select((eb) => ["d.id", triExpr(eb, () => openSubjectExpr(db, eb, "d", "i")).as("v")]).orderBy("d.id"),
    varies: "v",
  },
  {
    name: "prepareStateSql",
    text: `SELECT d.id, ${prepareStateSql(db, "d")} FROM decisions d ORDER BY d.id`,
    params: [SINCE],
    built: () => db.k.selectFrom("decisions as d").select((eb) => ["d.id", ...prepareStateExpr(db, eb, "d", SINCE)]).orderBy("d.id"),
    varies: "review_queued",
  },
  {
    name: "VERDICT_SQL",
    text: `SELECT repo, number, classifier, ${tri(VERDICT_SQL)} AS v FROM classifications ORDER BY repo, number, classifier`,
    built: () => db.k.selectFrom("classifications").select((eb) => ["repo", "number", "classifier", triExpr(eb, () => verdictExpr(eb)).as("v")])
      .orderBy("repo").orderBy("number").orderBy("classifier"),
    varies: "v",
  },
  {
    name: "settledOn",
    text: `SELECT i.repo, i.number, s.status FROM items i LEFT JOIN item_settled s ON ${settledOn("r1", "s")} ORDER BY i.repo, i.number`,
    built: () => db.k.selectFrom("items as i").leftJoin("item_settled as s", (j) => j.on((eb) => settledOnExpr(eb, "r1", "s")))
      .select(["i.repo", "i.number", "s.status"]).orderBy("i.repo").orderBy("i.number"),
    varies: "status",
    prep: async () => void await db.run(db.k.insertInto("main.item_settled").values([
      { run: "r1", repo: "app", number: 1, status: "settled", flags: "[]", security: 0, needs_decision: 0 },
      { run: "r2", repo: "app", number: 2, status: "settled", flags: "[]", security: 0, needs_decision: 0 },
      { run: "r1", repo: "lib", number: 2, status: "disputed", flags: "[]", security: 0, needs_decision: 0 },
    ])),
    undo: async () => void await db.run(db.k.deleteFrom("main.item_settled")),
  },
  {
    name: "STATS_SQL",
    text: `${STATS_SQL} GROUP BY author ORDER BY author`,
    built: () => statsExpr(db).groupBy("author").orderBy("author"),
    varies: "merged",
  },
];

test("each fragment twin gives the rows of its SQL text", async () => {
  const failed: string[] = [];
  for (const c of cases()) {
    await c.prep?.();
    try {
      const want = Array.isArray(c.params) || !c.params ? await db.prepare(c.text).all(...(c.params ?? []) as Param[]) : await db.prepare(c.text).all(c.params);
      const got = await db.all(c.built());
      assert.deepEqual(got, want);
      if (c.varies) assert.ok(new Set(want.map((r) => (r as Record<string, unknown>)[c.varies!])).size > 1, `the fixture gives one value of ${c.varies}`);
    } catch (e) {
      failed.push(`${c.name}: ${(e as Error).message}`);
    } finally {
      await c.undo?.();
    }
  }
  assert.deepEqual(failed, []);
});

test("prepareStateSql's columns are filled for an open decision with discussion, review, prepares and stale choices", async () => {
  const row = await db.get(db.k.selectFrom("decisions as d").select((eb) => prepareStateExpr(db, eb, "d", SINCE)).where("d.id", "=", "app:q:2"));
  assert.ok(row);
  assert.equal(row.discussion_key, "c1");
  assert.equal(row.reviewed_at, T2);
  assert.equal(row.prepares_today, 1);
  assert.deepEqual(JSON.parse(row.stale_choices!), { d: { x: { params: {} } }, a: ["a"] });
  assert.equal(row.review_queued, 1);
});

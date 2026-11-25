// The JSON API through HTTP with the fake OAuth provider: who may answer,
// adopt, give feedback (a pick, text or both); CSRF; the hourly limit; claims; and that feedback
// never reaches the CLI output the pipeline reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Decision, DecisionComment, DecisionList, Item, Progress, SearchHit, User } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { laneForDecision } from "../src/github/user-lane.ts";
import { queuedOperatorFix, operatorWork } from "../src/preapproval/state.ts";
import { scopeAnswers, unsettledScope } from "../src/review/candidates.ts";
import { settledByExpr } from "../src/settlers.ts";
import { excluded } from "../src/db/kx.ts";
import { actionable, ask } from "../src/decisions.ts";
import { scopeToTracked } from "../src/repos.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import * as kx from "../src/db/kx.ts";

const MARKER = "OPINION-MARKER-k3v";
const LIMIT = 8;
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "api-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, JSON.stringify({ boss: { photocraft: "admin" }, maint: { photocraft: "write" } }));

const db = await connectDb(dbFile);
let base = "";
let close: () => Promise<void>;

const OPTS = [{ key: "small", label: "Small extra" }, { key: "plugin", label: "Plugin candidate" }];
const P1 = "photocraft#1:scope", P2 = "photocraft#2:scope", F3 = "filmcraft#3:scope", P4 = "photocraft#4:close";

before(async () => {
  const now = new Date().toISOString();
  const ins = (repo: string, number: number, kind: string, state: string, title: string, body: string, author: string, created_at: string, updated_at: string, closing_issues: string | null) =>
    db.run(db.k.insertInto("items").values({ repo, number, kind, state, title, body, author, created_at, updated_at, closing_issues }));
  await ins("photocraft", 1, "pr", "OPEN", "Add wave filter", "<script>x</script> body", "alice", now, now, "[5]");
  await ins("photocraft", 2, "pr", "OPEN", "Add ripple filter", "b", "bob", now, now, null);
  await ins("filmcraft", 3, "pr", "OPEN", "Fix audio drift", "c", "carol", now, now, null);
  await ins("photocraft", 4, "issue", "OPEN", "Crash on save", "d", "dave", now, now, null);
  await ins("photocraft", 5, "issue", "OPEN", "Wave filter missing", "e", "erin", now, now, null);
  await ins("untracked-repo", 6, "pr", "OPEN", "Add wave filter elsewhere", "f", "frank", now, now, null);
  await db.run(db.k.updateTable("items").set({ additions: 40, deletions: 3, changed_files: 7 }).where("repo", "=", "photocraft").where("number", "=", 1));
  await db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 1, id: "c1", kind: "comment", author: "alice", created_at: now, body: "looks good" }));
  await db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, want, reason) VALUES ('photocraft', 1, 'haiku', 'r1', ?, 'small extra', 'yes', 'adds a filter')").run(now);
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "filmcraft", visibility: "public" }])
    .onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
  await ask(db, [P1, P2, F3, P4].map((id) => {
    const [repo, rest] = id.split("#");
    return { id, kind: id.endsWith("close") ? "close" : "scope", repo, number: Number(rest!.split(":")[0]), question: "Small extra or plugin?", options: OPTS, recommended: "small", summary: "Adds a filter." };
  }));
  await ask(db, [{ id: "photocraft:dupegroup:4", kind: "duplicate", repo: "photocraft", number: 4, question: "Keep #4 and close #5?", options: [{ key: "accept", label: "Use this answer" }, { key: "distinct", label: "Not duplicates" }], recommended: "accept" }]);
  await addLogin(db, "cli", "boss", "operator", null);
  await addLogin(db, "cli", "viewer1", "viewer", null);
  await addLogin(db, "cli", "maint", "maintainer", null);
  await addLogin(db, "cli", "chatty", "maintainer", null);
  await addLogin(db, "cli", "pal", "maintainer", null);
  await scopeToTracked(db);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes({ writesPerHour: LIMIT }) });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  csrf = "";
  async req(method: string, path: string, opts: { body?: unknown; csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json", ...opts.headers };
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (method === "POST" && csrf !== null) headers["x-csrf-token"] = csrf;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const r = await fetch(new URL(path, base), { method, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const r = await this.req(method, path, { body });
    const text = await r.text();
    assert.equal(r.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get = <T>(path: string) => this.json<T>("GET", path);
  post = <T>(path: string, body?: unknown, status = 200) => this.json<T>("POST", path, body, status);
}

const dpath = (id: string, tail = "") => `/api/decisions/${encodeURIComponent(id)}${tail}`;

async function signedIn(login: string): Promise<Client> {
  const c = new Client();
  const start = await c.req("GET", "/auth/signin?return_to=/");
  const auth = await c.req("GET", `${start.headers.get("location")}&login=${login}`);
  const done = await c.req("GET", auth.headers.get("location")!);
  assert.equal(done.status, 303, `sign-in of ${login}`);
  const me = await c.req("GET", "/api/me");
  c.csrf = me.headers.get("x-csrf-token") ?? "";
  assert.ok(c.csrf);
  return c;
}

const actionableIds = async () => (await actionable(db)).map((d) => d.id);

const auditCount = async (action: string, login: string) =>
  (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", action).where("login", "=", login)))!.n;

describe("api", () => {
  test("without a session every endpoint answers 401 JSON", async () => {
    const c = new Client();
    const r = await c.req("GET", "/api/me");
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "sign-in required" });
    for (const path of ["/api/classifiers", "/api/classifiers/disagreements", "/api/cost", "/api/items", "/api/items?q=wave"]) assert.equal((await c.req("GET", path)).status, 401, path);
    assert.equal((await c.req("POST", dpath(P1, "/feedback"), { body: { option: "small" }, csrf: "x" })).status, 401);
  });

  test("me and reads: role, write repos, item, search and progress", async () => {
    const boss = await signedIn("boss");
    const me = await boss.get<User>("/api/me");
    assert.equal(me.role, "operator");
    assert.deepEqual(me.writeRepos, ["photocraft"]);
    assert.equal((await (await signedIn("maint")).get<User>("/api/me")).role, "maintainer");
    const it = await boss.get<Item>("/api/items/photocraft/1");
    assert.equal(it.body, "<script>x</script> body");
    assert.deepEqual([it.changedFiles, it.additions, it.deletions], [7, 40, 3]);
    assert.equal((await boss.get<Item>("/api/items/photocraft/4")).changedFiles, null);
    assert.deepEqual([it.verification, it.fixups, it.actions], [null, [], []]);
    assert.equal(it.pipelineOn, false);
    // Merged by AutoCraft: PRs with a merged merges row, newest merge first, with how they merged.
    const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const mrg = db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome) VALUES (?, ?, 'h', 'r', ?, ?, 'squash', ?)");
    await mrg.run("photocraft", 1, mins(10), "rule", "merged");
    await mrg.run("photocraft", 2, mins(5), "operator", "merged");
    await mrg.run("filmcraft", 3, mins(1), "rule", "refused");
    const by = await boss.get<{ rows: { number: number; mergedHow: string | null }[] }>("/api/items?state=merged-by-us");
    assert.deepEqual(by.rows.map((r) => [r.number, r.mergedHow]), [[2, "operator"], [1, "rule"]]);
    await db.run(db.k.updateTable("main.items").set({ head_oid: "h1" }).where("repo", "=", "photocraft").where("number", "=", 1));
    await db.run(db.k.insertInto("verifications").values({
      repo: "photocraft", number: 1, head_sha: "h1", kind: "tests", reason: "why", plan: '{"kind":"tests","crates":["codecs"],"tests":["png::"]}', state: "failed", summary: "test failed", created_at: "2026-01-01T00:00:00Z",
    }));
    await db.run(db.k.insertInto("fixups").values({ repo: "photocraft", number: 1, from_head: "h0", state: "refused", reason: "no", files: '["a.rs"]', attempt: 1, created_at: "2026-01-01T00:00:00Z" }));
    await db.run(db.k.insertInto("actions").values({ decision_id: "d1", repo: "photocraft", number: 1, kind: "comment-close", state: "done", comment_url: "https://x/c", created_at: "2026-01-01T00:00:00Z" }));
    const worked = await boss.get<Item>("/api/items/photocraft/1");
    assert.deepEqual([worked.verification?.state, worked.verification?.current, worked.verification?.plan], ["failed", true, { crates: ["codecs"], tests: ["png::"], testLines: null }]);
    assert.deepEqual([worked.fixups[0]?.files, worked.fixups[0]?.state, worked.actions], [["a.rs"], "refused", []]);
    assert.deepEqual(worked.premerge, []);
    const finding = { severity: "defect", file: "a.rs", line: 3, title: "t", scenario: "s", fix: { file: "a.rs", change: "c" } };
    await db.run(db.k.insertInto("premerge_reviews").values({ repo: "photocraft", number: 1, head_oid: "h0", at: "2026-01-01T00:00:00Z", model: "m", findings: JSON.stringify([finding]), searched: "looked", tries: 0 }));
    await db.run(db.k.insertInto("premerge_reviews").values({ repo: "photocraft", number: 1, head_oid: "h1", at: "2026-01-02T00:00:00Z", error: "no JSON", tries: 2 }));
    const pre = (await boss.get<Item>("/api/items/photocraft/1")).premerge!;
    assert.deepEqual(pre.map((r) => [r.head, r.error, r.tries, r.findings.length]), [["h1", "no JSON", 2, 0], ["h0", null, 0, 1]]);
    assert.deepEqual(pre[1]!.findings[0], finding);
    assert.deepEqual(it.comments.map((c) => c.body), ["looks good"]);
    assert.deepEqual(it.decisionIds, []);
    assert.deepEqual(it.related.map((r) => [r.number, r.relation]), [[5, "fixes"]]);
    assert.equal(it.classifications[0]!.typeLabel, "small extra");
    assert.equal((await boss.req("GET", "/api/items/untracked-repo/6")).status, 404);
    const byRef = await boss.get<SearchHit[]>("/api/search?q=photocraft%231");
    assert.deepEqual(byRef.map((h) => h.number), [1]);
    const byWords = await boss.get<SearchHit[]>("/api/search?q=wave%20filter");
    assert.deepEqual(byWords.map((h) => `${h.repo}#${h.number}`).sort(), ["photocraft#1", "photocraft#5"]);
    const p = await boss.get<Progress>("/api/progress");
    assert.equal(p.funnel.open, 5);
    assert.equal(p.decisionsOpen, 0);
    assert.equal(p.perHour.length, 24);
  });


  test("the decisions list narrows to one item: its own decisions and the duplicate groups that list it", async () => {
    const boss = await signedIn("boss");
    await db.run(db.k.insertInto("dupe_group_items").values({ decision_id: "photocraft:dupegroup:4", repo: "photocraft", number: 5, kind: "issue", role: "close", target: 4, detail: null, base_role: "close", base_target: 4, head: null }));
    const ids = async (n: number) => (await boss.get<DecisionList>(`/api/decisions?repo=photocraft&number=${n}`)).decisions.map((d) => d.id).sort();
    assert.deepEqual(await ids(1), [P1]);
    assert.deepEqual(await ids(5), ["photocraft:dupegroup:4"]);
    assert.deepEqual(await ids(99), []);
  });

  test("a viewer's opinion, retract, comment and claim are refused and write nothing; a maintainer's succeed", async () => {
    const viewer = await signedIn("viewer1");
    const maint = await signedIn("maint");
    const pal = await signedIn("pal");
    for (const c of [viewer, maint]) {
      await c.post(dpath(P1, "/answer"), { answer: "small" }, 403);
      await c.post(dpath(P1, "/undo"), undefined, 403);
    }
    const audits = async () => (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", "viewer1")))!.n;
    const before = await audits();
    await viewer.post(dpath(P1, "/feedback"), { option: "plugin", text: `viewer ${MARKER}` }, 403);
    await viewer.post(dpath(P1, "/feedback"), { text: `viewer ${MARKER}` }, 403);
    await viewer.post(dpath(P1, "/retract"), undefined, 403);
    await viewer.post(dpath(P1, "/claim"), undefined, 403);
    assert.equal(await audits(), before);
    assert.equal((await maint.get<Decision>(dpath(P1))).opinions.some((o) => o.login === "viewer1"), false);
    assert.equal((await maint.get<DecisionComment[]>(dpath(P1, "/thread"))).length, 0);
    assert.equal((await db.get(db.k.selectFrom("decision_claims").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", "viewer1")))!.n, 0);

    const d1 = await pal.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: `pal ${MARKER}` });
    const pOp = d1.opinions.find((o) => o.login === "pal")!;
    assert.equal(pOp.permission, "none");
    await maint.post(dpath(P1, "/adopt"), { opinionId: pOp.id }, 403);
    const d2 = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "small" });
    assert.equal(d2.opinions.find((o) => o.login === "maint")!.permission, "write");
    // changing replaces the live opinion
    const d3 = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: `maint ${MARKER}` });
    assert.deepEqual(d3.opinions.filter((o) => o.login === "maint").map((o) => o.option), ["plugin"]);
    // a new pick without text keeps the earlier note; with text it replaces it
    const d3b = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "small" });
    assert.deepEqual(d3b.opinions.filter((o) => o.login === "maint").map((o) => [o.option, o.note]), [["small", `maint ${MARKER}`]]);
    const d3c = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: "changed" });
    assert.equal(d3c.opinions.find((o) => o.login === "maint")!.note, "changed");
    await pal.post(dpath(P1, "/feedback"), { option: "nope" }, 400);
    await pal.post(dpath(P1, "/feedback"), {}, 400);
    const d5 = await pal.post<Decision>(dpath(P1, "/feedback"), { text: `comment ${MARKER}` });
    assert.equal(d5.opinions.filter((o) => o.login === "pal").length, 1, "text alone is no pick");
    assert.deepEqual((await maint.get<DecisionComment[]>(dpath(P1, "/thread"))).map((x) => x.body), [`comment ${MARKER}`]);
    assert.equal((await maint.get<Decision>(dpath(P1))).commentCount, 1);
    const d4 = await pal.post<Decision>(dpath(P1, "/retract"));
    assert.equal(d4.opinions.some((o) => o.login === "pal"), false);
    assert.equal(await getAnswer(P1), null);
    assert.equal(await auditCount("opinion", "maint"), 4);
    assert.equal(await auditCount("comment", "pal"), 1);
    assert.equal(await auditCount("opinion-retract", "pal"), 1);
  });

  test("an operator without write on the repo can't answer; with it, answer and undo work and the note stays private", async () => {
    const boss = await signedIn("boss");
    const r = await boss.req("POST", dpath(F3, "/answer"), { body: { answer: "small" } });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /storytold\/filmcraft/);
    const d = await boss.post<Decision>(dpath(P2, "/answer"), { answer: "plugin", note: "private note" });
    assert.equal(d.answer, "plugin");
    assert.equal(d.answerNote, "private note");
    const seen = await (await signedIn("viewer1")).get<Decision>(dpath(P2));
    assert.equal(seen.answer, "plugin");
    assert.equal(seen.answerNote, null);
    await boss.post(dpath(P2, "/answer"), { answer: "small" }, 409);
    const u = await boss.post<Decision>(dpath(P2, "/undo"));
    assert.equal(u.answer, null);
    assert.equal(await auditCount("undo", "boss"), 1);
  });

  test("a maintainer settles only with maintainer_writes on, the app identity on the repo and write access; undo only their own", async () => {
    const setting = async (on: boolean) => on ? await db.run(db.k.insertInto("settings").values({ key: "maintainer_writes", value: "1" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"])))) : await db.run(db.k.deleteFrom("settings").where("key", "=", "maintainer_writes"));
    const identity = async (app: boolean) => app ? await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"])))) : await db.run(db.k.deleteFrom("settings").where("key", "=", "github_identity"));
    const X1 = "photocraft#7:scope", X2 = "photocraft#8:scope";
    await ask(db, [X1, X2].map((id) => ({ id, kind: "scope" as const, repo: "photocraft", number: Number(id.split("#")[1]!.split(":")[0]), question: "Small extra or plugin?", options: OPTS, recommended: "small", summary: "s" })));
    const maint = await signedIn("maint"), pal = await signedIn("pal"), boss = await signedIn("boss");
    try {
      await identity(true);
      await maint.post(dpath(X1, "/answer"), { answer: "small" }, 403);
      await setting(true);
      assert.equal((await maint.get<Decision>(dpath(X1))).canSettle, true);
      await identity(false);
      assert.equal((await maint.get<Decision>(dpath(X1))).canSettle, false);
      await maint.post(dpath(X1, "/answer"), { answer: "small" }, 403);
      await identity(true);
      await pal.post(dpath(X1, "/answer"), { answer: "small" }, 403);
      const d = await maint.post<Decision>(dpath(X1, "/answer"), { answer: "small", note: "mine" });
      assert.equal(d.answeredBy, "maint");
      assert.equal(await auditCount("answer", "maint"), 1);
      assert.ok((await actionableIds()).includes(X1));
      assert.ok(await db.get(db.k.selectFrom("decisions as d").select((eb) => eb.lit(1).as("one")).where("d.id", "=", X1).where((eb) => settledByExpr(db, eb, "d"))));
      await identity(false);
      assert.ok(!(await actionableIds()).includes(X1), "an answer on a repo that left the app identity stops counting");
      assert.equal(await db.get(db.k.selectFrom("decisions as d").select((eb) => eb.lit(1).as("one")).where("d.id", "=", X1).where((eb) => settledByExpr(db, eb, "d"))), undefined, "nor at the SQL sites other than actionable()");
      // Work and answers the maintainer started count only while the conditions hold; a flip to legacy stops them everywhere.
      await db.run(db.k.insertInto("repo_permissions").values({ login: "maint", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() })
        .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(kx.excluded(["permission", "checked_at"]))));
      await db.run(db.k.insertInto("operator_fixups").values({ repo: "photocraft", number: 7, from_head: "h1", instructions: "fix it", by: "maint", at: new Date().toISOString() }));
      await identity(true);
      assert.ok(await queuedOperatorFix(db, "photocraft", 7, "h1"));
      assert.equal((await scopeAnswers(db)).get("photocraft#7"), "small");
      await identity(false);
      assert.equal(await queuedOperatorFix(db, "photocraft", 7, "h1"), null);
      assert.equal((await operatorWork(db)).get("photocraft#7")?.fixHeads.size ?? 0, 0);
      assert.equal((await scopeAnswers(db)).get("photocraft#7"), undefined);
      assert.ok((await unsettledScope(db)).has("photocraft#7"));
      const lane = await laneForDecision(db, undefined, X1, ["photocraft"]);
      assert.ok(lane && "state" in lane && lane.state === "waiting-permission");
      await identity(true);
      await identity(true);
      await boss.post(dpath(X2, "/answer"), { answer: "plugin" });
      await maint.post(dpath(X2, "/undo"), undefined, 403);
      assert.equal((await maint.post<Decision>(dpath(X1, "/undo"))).answer, null);
      await boss.post(dpath(X2, "/undo"));
    } finally {
      await setting(false);
      await identity(false);
    }
  });

  test("an operator can close a question as handled with a note (and undo it), and snooze hides it until new activity", async () => {
    const boss = await signedIn("boss");
    await boss.post(dpath(P2, "/answer"), { answer: "handled" }, 400);
    const h = await boss.post<Decision>(dpath(P2, "/answer"), { answer: "handled", note: "Done on GitHub" });
    assert.deepEqual({ a: h.answer, n: h.answerNote, u: h.undoable }, { a: "handled", n: "Done on GitHub", u: true });
    assert.equal((await boss.post<Decision>(dpath(P2, "/undo"))).answer, null);

    const ids = async (status: string) => (await boss.get<{ decisions: Decision[] }>(`/api/decisions?status=${status}&repo=photocraft`)).decisions.map((x) => x.id);
    const seq = async (topic: string) => (await db.prepare("SELECT seq FROM change_seq WHERE topic = ?").get(topic) as { seq: number }).seq;
    const [snoozeSeq, decisionsSeq] = [await seq("decision-snooze"), await seq("decisions")];
    const s = await boss.post<Decision>(dpath(P2, "/snooze"), { on: true });
    assert.equal(s.snoozed?.by, "boss");
    assert.ok(await seq("decision-snooze") > snoozeSeq, "a snooze bumps its topic");
    assert.equal(await seq("decisions"), decisionsSeq, "and leaves the planner's input alone");
    assert.ok(!(await ids("open")).includes(P2));
    assert.deepEqual(await ids("snoozed"), [P2]);
    // Feedback after the snooze wakes it.
    await db.run(db.k.insertInto("decision_comments").values({ id: "wake1", decision_id: P2, login: "maint", at: new Date(Date.now() + 60_000).toISOString(), body: "More news" }));
    assert.equal((await boss.get<Decision>(dpath(P2))).snoozed, null);
    assert.ok((await ids("open")).includes(P2));
    assert.deepEqual(await ids("snoozed"), []);
    // A force-push wakes it too (the earlier comment is removed so it does not wake the new snooze).
    await db.run(db.k.deleteFrom("decision_comments").where("id", "=", "wake1"));
    await boss.post(dpath(P2, "/snooze"), { on: true });
    assert.deepEqual(await ids("snoozed"), [P2]);
    const d2 = (await db.get(db.k.selectFrom("decisions").select(["repo", "number"]).where("id", "=", P2)))!;
    await db.prepare("INSERT INTO item_activity (repo, number, id, kind, at) VALUES (?, ?, 'fp1', 'force-push', ?)").run(d2.repo, d2.number, new Date(Date.now() + 120_000).toISOString());
    assert.deepEqual(await ids("snoozed"), []);
  });

  test("a group decision's answer must carry the hash of the shown comments, and an answer Act wrote for can't be undone", async () => {
    const boss = await signedIn("boss");
    const id = "photocraft:dupegroup:4";
    await db.run(db.k.insertInto("dupe_groups").values({ decision_id: id, repo: "photocraft", source: "model" }));
    await db.run(db.k.insertInto("dupe_group_texts").values({ decision_id: id, option: "accept", number: 5, step: "close", text: "Closing as a duplicate of #4." }));
    const shown = await boss.get<Decision>(dpath(id));
    const ot = shown.optionTexts.find((o) => o.option === "accept")!;
    assert.equal(ot.texts[0]!.text, "Closing as a duplicate of #4.");
    await boss.post(dpath(id, "/answer"), { answer: "accept" }, 409);
    await boss.post(dpath(id, "/answer"), { answer: "accept", textsHash: "stale" }, 409);
    // The comments changed after the page was loaded.
    await db.run(db.k.updateTable("dupe_group_texts").set({ text: "Closing as a duplicate of #4.\nParts to carry over to #4: x." }).where("decision_id", "=", id));
    await boss.post(dpath(id, "/answer"), { answer: "accept", textsHash: ot.hash }, 409);
    const fresh = (await boss.get<Decision>(dpath(id))).optionTexts[0]!;
    // Adopting an opinion approves the same texts, so it needs the same hash.
    await db.run(db.k.insertInto("decision_opinions").values({ id: "op1", decision_id: id, login: "maint", option: "accept", note: null, at: "now", permission: "write" }));
    await boss.post(dpath(id, "/adopt"), { opinionId: "op1" }, 409);
    await boss.post(dpath(id, "/adopt"), { opinionId: "op1", textsHash: ot.hash }, 409);
    assert.equal((await boss.post<Decision>(dpath(id, "/adopt"), { opinionId: "op1", textsHash: fresh.hash })).answer, "accept");
    await boss.post<Decision>(dpath(id, "/undo"));
    assert.equal((await boss.post<Decision>(dpath(id, "/answer"), { answer: "accept", textsHash: fresh.hash })).answer, "accept");
    await db.run(db.k.insertInto("dupe_group_posts").values({ decision_id: id, number: 5, step: "comment", url: "https://x/c", at: "now" }));
    await boss.post(dpath(id, "/undo"), undefined, 409);
    await db.run(db.k.updateTable("main.decisions").set({ applied_at: "now" }).where("id", "=", id));
    await db.run(db.k.deleteFrom("decision_opinions").where("id", "=", "op1"));
  });

  test("adopt records the operator's answer and credits the opinion; opinions close once answered", async () => {
    const maint = await signedIn("maint");
    const boss = await signedIn("boss");
    const op = (await maint.post<Decision>(dpath(P4, "/feedback"), { option: "plugin", text: `adopt me ${MARKER}` })).opinions.find((o) => o.login === "maint")!;
    const d = await boss.post<Decision>(dpath(P4, "/adopt"), { opinionId: op.id });
    assert.equal(d.answer, "plugin");
    assert.equal(d.answeredBy, "boss");
    assert.equal(d.adoptedOpinion?.id, op.id);
    assert.equal(d.adoptedOpinion?.login, "maint");
    // The group decision test above adopted once as well.
    assert.equal(await auditCount("adopt", "boss"), 2);
    await maint.post(dpath(P4, "/feedback"), { option: "small" }, 409);
    await maint.post(dpath(P4, "/retract"), undefined, 409);
  });

  test("a POST without the CSRF header, or from another origin, is refused", async () => {
    const pal = await signedIn("pal");
    const refused: { csrf?: string | null; headers?: Record<string, string> }[] = [
      { csrf: null }, { csrf: "wrong" }, { headers: { origin: "https://evil.example" } }, { headers: { "sec-fetch-site": "cross-site" } },
    ];
    for (const opts of refused) {
      const r = await pal.req("POST", dpath(P1, "/feedback"), { body: { text: "x" }, ...opts });
      assert.equal(r.status, 403, JSON.stringify(opts));
      assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    }
    const same = await pal.req("POST", dpath(P1, "/feedback"), { body: { text: "same origin" }, headers: { origin: base } });
    assert.equal(same.status, 200);
  });



});

async function getAnswer(id: string): Promise<string | null> {
  return (await db.get(db.k.selectFrom("main.decisions").select("answer").where("id", "=", id)))!.answer;
}

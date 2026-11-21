import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { setFixIssueApproval } from "../src/fixissue/approval.ts";
import { attemptOf, runFixIssueCollect, type CollectDeps } from "../src/fixissue/index.ts";
import { SCRATCH } from "./scratch.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { spawnSync } from "node:child_process";
import { mapSeq } from "../src/async-seq.ts";
import { connectDb } from "../src/db/open.ts";
import { excluded } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixissue-pool-"));
const T0 = "2026-01-01T00:00:00Z";
const LOGIN = "pipeline-bot";
const LIB = "crates/app/src/lib.rs";
const git = (cwd: string, ...a: string[]): string => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();
const patchFor = (n: number): string => `diff --git a/${LIB} b/${LIB}
--- a/${LIB}
+++ b/${LIB}
@@ -1,3 +1,3 @@
 pub fn first(v: &[u8]) -> u8 {
-    v[0]
+    v.first().copied().unwrap_or(0)
 }
diff --git a/crates/app/tests/autocraft_regression_${n}.rs b/crates/app/tests/autocraft_regression_${n}.rs
new file mode 100644
--- /dev/null
+++ b/crates/app/tests/autocraft_regression_${n}.rs
@@ -0,0 +1,3 @@
+#[test]
+fn empty() {
+}
`;

async function collect(perDay?: number) {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(join(work, "crates/app/src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, LIB), "pub fn first(v: &[u8]) -> u8 {\n    v[0]\n}\n");
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  const sha = git(work, "rev-parse", "HEAD");
  const upstream = join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", work, upstream);
  const fork = join(root, "fork.git");
  git(root, "init", "-q", "--bare", fork);

  const db = await connectDb(join(root, "t.db"));
  await useTestAccount(db);
  await db.prepare("UPDATE claude_accounts SET max_concurrent = 4").run();
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public", default_branch: "main" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await setFixIssueApproval(db, "op", "app", true);
  if (perDay !== undefined) await db.run(db.k.insertInto("stage_limits").values({ step: "fixissue", per_day: perDay, updated_by: null, updated_at: null })
    .onConflict((oc) => oc.column("step").doUpdateSet(excluded(["per_day", "updated_by", "updated_at"]))));
  for (const n of [5, 6]) {
    await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "issue", state: "OPEN", title: `Panic ${n}`, body: "b", author: "someone", created_at: T0, updated_at: T0 }));
    await db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', ?, 'bugfix', '[]', '{\"top\":0.97}')").run(n, T0);
    await db.run(db.k.insertInto("fix_attempts").values({ repo: "app", number: n, main_sha: sha, text_hash: "h", state: "passed", round: 1, patch: patchFor(n),
      files: JSON.stringify([LIB]), crate: "app", crate_dir: "crates/app", size: "S", created_at: T0, updated_at: T0 }));
  }

  const created: string[] = [];
  let arrived = 0, release!: () => void;
  const both = new Promise<void>((ok) => (release = ok));
  const run: Exec = async (cmd, args, opt = {}): Promise<ExecResult> => {
    const out = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });
    if (cmd === "gh") {
      if (args[0] === "api" && args[1] === "user") return out(JSON.stringify({ login: LOGIN, id: 42, node_id: "U42" }));
      if (args[0] === "api" && args[1]!.startsWith(`repos/${LOGIN}/`)) return out("", 1);
      if (args[0] === "api" && args[1]!.includes("/forks")) return out(`${LOGIN}/app\n`);
      if (args[0] === "api" && args[1]!.includes("/issues/")) return out("open\n");
      if (args[0] === "pr" && args[1] === "list") return out("");
      if (args[0] === "pr") {
        created.push(args.join(" "));
        if (++arrived === 2 || perDay !== undefined) release();
        // No clock: if the second PR is never opened at the same time this deadlocks and the test timeout reports it.
        await both;
        return out("https://github.com/storytold/app/pull/12\n");
      }
      if (args[0] === "issue") return out("");
      return out("", 1);
    }
    const urlAt = args.findIndex((a) => a.startsWith("https://github.com/"));
    if (urlAt >= 0) {
      const target = args[urlAt]!.includes("/storytold/") ? upstream : fork;
      const a2 = args.map((a, i) => (i === urlAt ? target : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
      return exec("git", a2, opt);
    }
    return exec("git", args, opt);
  };
  const deps: CollectDeps = {
    exec: run, now: () => new Date("2026-01-02T00:00:00Z"), root: join(root, "cache"),
    mainHead: async () => sha, fetchCrates: async () => ({ ok: true, rust: true, crates: [{ name: "app", dir: "crates/app" }] }),
    fetchPaths: async () => [LIB], ask: async () => null, summarise: async () => "",
  };
  const s = await runFixIssueCollect(db, {}, () => {}, deps);
  return { s, created, db };
}

test("fixissue-collect opens the PR of each of two passed attempts once when they run at the same time", { timeout: 120_000 }, async () => {
  const { s, created, db } = await collect();
  assert.equal(s.opened, 2);
  assert.equal(created.length, 2);
  assert.deepEqual(await mapSeq([5, 6], async (n) => (await attemptOf(db, "app", n))!.state), ["pr-opened", "pr-opened"]);
});

test("with one PR a day, two attempts that run at the same time open exactly one", async () => {
  const { s, created } = await collect(1);
  assert.equal(s.opened, 1);
  assert.equal(created.length, 1);
});

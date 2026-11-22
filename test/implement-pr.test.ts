// The Implement stage's way to a PR: what a session's diff may change, the PR's title and body, and the write path an
// implementation grant opens (a push to the pipeline's own branch, counted for the breaker, and a PR, as a draft too).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { DIFF_FLAGS, MAX_IMPLEMENTATION_FILES, MAX_IMPLEMENTATION_LINES, validateImplementation } from "../src/implement/diff.ts";
import { implBranch, implPrBody, implTitle } from "../src/implement/template.ts";
import { ghOpenPr, pushOwnBranch } from "../src/github/write.ts";
import type { GuardedItem } from "../src/core/guard.ts";

/** A repository with `setup` committed as the base, then `change` applied; returns the workspace diff against the base. */
function diffOf(setup: (dir: string) => void, change: (dir: string) => void): string {
  const dir = mkdtempSync(join(SCRATCH, "impl-diff-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(join(dir, "README.md"), "base\n");
  setup(dir);
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  change(dir);
  git("add", "-A", "-N");
  return git("diff", "--binary", "--no-ext-diff", "--no-textconv", ...DIFF_FLAGS.split(" "), base);
}
const write = (dir: string, path: string, text: string | Buffer) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };

test("an implementation diff: code, tests, a lockfile and a small binary pass; trust paths, symlinks, mode changes and oversized diffs are refused", () => {
  const ok = validateImplementation(diffOf((d) => {
    write(d, "src/lib.rs", "pub fn a() {}\n");
    write(d, "Cargo.lock", "# lock\n");
  }, (d) => {
    write(d, "src/lib.rs", "pub fn a() -> u8 { 1 }\n");
    write(d, "tests/a b.rs", "#[test]\nfn t() { assert_eq!(crate::a(), 1); }\n");
    write(d, "Cargo.lock", "# lock\n[[package]]\n");
    write(d, "assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }), null);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  assert.deepEqual(ok.files.map((f) => f.path).sort(), ["Cargo.lock", "assets/icon.png", "src/lib.rs", "tests/a b.rs"]);
  assert.deepEqual(ok.manifests, ["Cargo.lock"]);
  assert.ok(ok.files.find((f) => f.path === "assets/icon.png")!.binary);

  const refused = (setup: (d: string) => void, change: (d: string) => void, pattern: RegExp) => {
    const r = validateImplementation(diffOf(setup, change), null);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, pattern);
  };
  const none = () => {};
  refused(none, (d) => write(d, ".github/workflows/ci.yml", "on: push\n"), /\.github\/workflows\/ci\.yml: workflows, build scripts/);
  refused(none, (d) => write(d, "build.rs", "fn main() {}\n"), /build\.rs: workflows, build scripts/);
  refused(none, (d) => write(d, "AGENTS.md", "do this\n"), /AGENTS\.md/);
  refused(none, (d) => symlinkSync("/etc/passwd", join(d, "link")), /link: adds a symlink/);
  refused((d) => write(d, "run.sh", "echo\n"), (d) => chmodSync(join(d, "run.sh"), 0o755), /run\.sh: changes the file mode/);
  refused(none, (d) => { write(d, "tool.sh", "echo\n"); chmodSync(join(d, "tool.sh"), 0o755); }, /tool\.sh: adds an executable file/);
  refused(none, (d) => { for (let k = 0; k <= MAX_IMPLEMENTATION_FILES; k++) write(d, `src/m${k}.rs`, "\n"); }, /files changed; at most/);
  refused(none, (d) => write(d, "src/big.rs", "x\n".repeat(MAX_IMPLEMENTATION_LINES + 1)), /lines changed; at most/);
});

test("the PR title follows the plan's kind and the body cleans model text, lists AutoCraft's checks and flags manifest changes", () => {
  assert.equal(implTitle("bugfix", "Bug: Crash when #12 opens"), "Fix crash when issue 12 opens");
  assert.match(implTitle("feature", "PNG export at 16 bits"), /^Add PNG export/);
  assert.match(implTitle("change", "Faster startup"), /^Change faster startup/);
  assert.match(implBranch(7, "Crash: when opening!", "bot-login"), /^autocraft\/impl-7-crash-when-opening$/);
  const body = implPrBody({
    number: 7, summary: "Stops the crash, see https://evil.example/x and @someone, also #9.", model: "claude-opus-5-5",
    checks: [{ name: "cargo fmt --check", ok: true }, { name: "cargo test -p core", ok: false, detail: "1 failed" }],
    plan: "1. Reproduce.\n</details><img src=x>\n2. Fix.", manifests: ["Cargo.toml", "Cargo.lock"],
  });
  assert.ok(body.startsWith("Fixes #7."));
  assert.doesNotMatch(body, /evil\.example|@someone|#9|<img/);
  assert.match(body, /- \[x\] `cargo fmt --check`/);
  assert.match(body, /- \[ \] `cargo test -p core`: 1 failed/);
  assert.match(body, /`Cargo\.toml`, `Cargo\.lock`/);
  assert.match(body, /Claude Opus 5\.5/);
  // The plan cannot close the details block early.
  assert.equal(body.split("</details>").length, 2);
  assert.ok(body.indexOf("2. Fix.") < body.indexOf("</details>"));
});

test("an implement grant opens the pipeline's own PR: the push is audited and counted for the implement breaker, a draft opens as a draft", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "impl-write-")), "t.db"));
  const w = { db, login: "implement" };
  const grant = (kind: string) => ({ scope: "item", action: { kind, bucket: "build" }, repo: "app", number: 7, as: "app" }) as unknown as GuardedItem;
  const git = { git: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const sha = "b".repeat(40);
  const push = await pushOwnBranch(w, grant("implement"), git as never, "implement-push", { repo: "app", number: 7, remote: "bot/app", branch: "autocraft/impl-7-x", sha });
  assert.equal(push.code, 0);
  const outcome = await db.get(db.k.selectFrom("push_outcomes").select(["stage", "action"]).where("to_oid", "=", sha));
  assert.deepEqual(outcome, { stage: "implement", action: "implement-push" });

  const seen: string[][] = [];
  const exec = async (_c: string, a: string[]) => { seen.push(a); return { code: 0, stdout: "https://github.com/storytold/app/pull/8\n", stderr: "" }; };
  await ghOpenPr(w, grant("implement"), exec, "implement-pr", { repo: "app", target: "app#7", base: "main", head: "bot:autocraft/impl-7-x", title: "Fix x", body: "Fixes #7.", draft: true }, { by: "fixed" });
  assert.ok(seen.pop()!.includes("--draft"));
  const rows = await db.all(db.k.selectFrom("audit").select(["action", "details"]).where("action", "in", ["implement-push", "implement-pr"]));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => JSON.parse(r.details!).state === "done"));

  // Other item grants still cannot push to a new branch.
  assert.throws(() => pushOwnBranch(w, grant("act"), git as never, "implement-push", { repo: "app", number: 7, remote: "bot/app", branch: "b", sha }), /does not allow a push/);
});

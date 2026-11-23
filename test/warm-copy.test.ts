// warm-copy reads one version of the node's warm key even when warm-sync swaps `current` during the copy, and it sets
// unchanged sources to an old mtime only when the version's manifest says its build checked every unit it holds.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHANGED_FILE } from "../src/build/warm-mount.ts";
import { encodeManifest, makeHeader, signLatest } from "../src/warm/manifest.ts";
import { OLD_MTIME_SEC, setExtMtimes, setMtimes, warmCopyPhase } from "../src/worker/warm-copy.ts";

const A = "a".repeat(40), B = "b".repeat(40);

test("a swap of current during the copy does not mix versions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "warm-copy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(root, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const source = join(root, "node"), work = join(root, "work");
  const target = join(root, "target"), cargoHome = join(root, "cache", "cargo"), checkout = "/ci/app";
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "lib.rs"), "x");
  const gen = (commit: string) => {
    const dir = join(source, `gen-${commit.slice(0, 12)}`);
    for (const r of ["target", "cargo"]) {
      mkdirSync(join(dir, r), { recursive: true });
      writeFileSync(join(dir, r, "which"), commit);
    }
    const header = makeHeader({ key: "app-0123", repo: "o/app", commit, stored: 1, image: "img", rustc: null, envHash: "h", checkout, targetDir: target, cargoHome, trimmed: true }, []);
    const buf = encodeManifest({ header, entries: [] });
    writeFileSync(join(dir, "manifest.zst"), buf);
    const latest = signLatest("app-0123", { commit, sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length, stored: 1, bytes: 0 }, privateKey);
    writeFileSync(join(dir, "latest.json"), JSON.stringify(latest));
  };
  gen(A);
  gen(B);
  symlinkSync(`gen-${A.slice(0, 12)}`, join(source, "current"));
  const env = {
    AUTOCRAFT_WARM_KEY: "app-0123", AUTOCRAFT_WARM_COMMIT: A, AUTOCRAFT_WARM_SOURCE: source, AUTOCRAFT_WARM_VERIFY_KEYS: join(root, "public.pem"),
    AUTOCRAFT_WARM_TARGET: target, AUTOCRAFT_WARM_CARGO_HOME: cargoHome, AUTOCRAFT_WARM_CHECKOUT: checkout, AUTOCRAFT_WARM_IMAGE: "img",
    AUTOCRAFT_WARM_ENV_HASH: "h", AUTOCRAFT_WARM_MODE: "tmpfs",
  };
  const logs: string[] = [];
  const run = warmCopyPhase(work, env, (s) => logs.push(s));
  // warm-sync's swap, while the copy runs.
  symlinkSync(`gen-${B.slice(0, 12)}`, join(source, "current.tmp"));
  renameSync(join(source, "current.tmp"), join(source, "current"));
  assert.equal(await run, 0);
  assert.ok(logs.some((l) => l.startsWith("warm copy ")), logs.join("\n"));
  assert.equal(readFileSync(join(target, "which"), "utf8"), A);
  assert.equal(readFileSync(join(cargoHome, "which"), "utf8"), A);
});

test("an untrimmed version counts every source as changed", (t) => {
  const work = mkdtempSync(join(tmpdir(), "warm-mtimes-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, "src"));
  for (const f of ["changed.rs", "same.rs"]) writeFileSync(join(work, "src", f), f);
  writeFileSync(join(work, CHANGED_FILE), JSON.stringify({ commit: A, files: ["changed.rs"], dirs: [] }));
  const mtime = (f: string) => statSync(join(work, "src", f)).mtimeMs / 1000;

  setMtimes(work, A, true);
  assert.ok(mtime("same.rs") <= OLD_MTIME_SEC && mtime("changed.rs") > OLD_MTIME_SEC);
  setMtimes(work, A, false);
  assert.ok(mtime("same.rs") > OLD_MTIME_SEC);
});

test("the gate's extra checkouts are set to the old mtime", (t) => {
  const work = mkdtempSync(join(tmpdir(), "warm-ext-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dir = join(work, "ext", "craft-fonts", "abc", "fonts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.txt"), "x");
  assert.equal(setExtMtimes(work), 1);
  assert.ok(statSync(join(dir, "manifest.txt")).mtimeMs / 1000 <= OLD_MTIME_SEC);
  assert.equal(setExtMtimes(join(work, "none")), 0);
});

// The rustc wrapper the cache steps write must pass every variable cargo sets, including names with a hyphen
// (CARGO_BIN_EXE_<bin>), which dash drops before it execs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_STEP_WRAPPER, STEP_WRAPPER, stepPeak, WARM_STEP_WRAPPER } from "../src/build/pods.ts";

for (const [name, script] of [["cache", CACHE_STEP_WRAPPER], ["warm", WARM_STEP_WRAPPER]] as const) {
  test(`${name} step wrapper passes hyphenated environment variables to sccache`, () => {
    const dir = mkdtempSync(join(tmpdir(), "rustc-wrapper-"));
    try {
      writeFileSync(join(dir, "sccache"), '#!/bin/bash\n[ "$1" = --show-stats ] || env\n');
      chmodSync(join(dir, "sccache"), 0o755);
      // The first line copies the source tree from a pod mount; the rest is the wrapper under test.
      const body = script.split("\n").slice(1).join("\n");
      const out = execFileSync("sh", ["-c", body, "step", "30", "sh", "-c", 'exec env CARGO_BIN_EXE_my-bin=x "$RUSTC_WRAPPER" rustc'], {
        env: { PATH: `${dir}:${process.env.PATH}`, SCCACHE_WEBDAV_ENDPOINT: "http://cache.invalid", AUTOCRAFT_CI_TERM_COLOR: "always" },
        encoding: "utf8",
      });
      assert.match(out, /^CARGO_BIN_EXE_my-bin=x$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the step wrapper reports the sampled peak in its termination message, over what the step wrote there", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-peak-"));
  try {
    mkdirSync(join(dir, "cg"));
    writeFileSync(join(dir, "cg", "memory.stat"), "anon 123456789\nfile 5\n");
    writeFileSync(join(dir, "cg", "memory.max"), "max\n");
    const term = join(dir, "term");
    const body = STEP_WRAPPER.split("\n").slice(1).join("\n").replaceAll("/sys/fs/cgroup", join(dir, "cg")).replaceAll("/dev/termination-log", term);
    let code = 0;
    try {
      execFileSync("sh", ["-c", body, "step", "30", "sh", "-c", `echo 'autocraft-peak-anon 999999999999' > ${term}; sleep 1.5; exit 3`], { encoding: "utf8" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    assert.equal(code, 3, "the step's exit code");
    assert.equal(stepPeak(readFileSync(term, "utf8"), 64 * 1024 ** 3), 123456789);
    assert.equal(stepPeak("autocraft-peak-anon 999999999999\n", 1e9), 1e9, "capped at the container's limit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

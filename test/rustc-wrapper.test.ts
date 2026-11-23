// The rustc wrapper the cache steps write must pass every variable cargo sets, including names with a hyphen
// (CARGO_BIN_EXE_<bin>), which dash drops before it execs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_STEP_WRAPPER, WARM_STEP_WRAPPER } from "../src/build/pods.ts";

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

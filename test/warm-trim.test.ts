import { test } from "node:test";
import assert from "node:assert/strict";
import { staleEntries } from "../src/warm/trim.ts";

test("a warm trim leaves out the units the build did not use and keeps the ones it did", () => {
  const OLD = "4c68d8e5d9da9017", NEW = "9a1b2c3d4e5f6071", RUN_OLD = "e5c8bb1780f8bd7f", RUN_NEW = "0123456789abcdef", FRESH = "0db2acf210aeb36b";
  const { paths, units } = staleEntries({
    fingerprint: [
      { name: `dep-a-${OLD}`, touched: false }, { name: `dep-a-${RUN_OLD}`, touched: false },
      { name: `dep-a-${NEW}`, touched: true }, { name: `dep-a-${RUN_NEW}`, touched: true }, { name: `my-pm-${FRESH}`, touched: true },
    ],
    deps: [`libdep_a-${OLD}.rlib`, `dep_a-${OLD}.d`, `libdep_a-${NEW}.rlib`, `libmy_pm-${FRESH}.so`, "orphan-ffffffffffffffff", "rmeta-tmp"],
    build: [`dep-a-${RUN_OLD}`, `dep-a-${RUN_NEW}`],
    examples: [],
    incremental: [
      { name: "my_pm-3ge0gnqx4rjez", touched: false }, { name: "gone-2dzz4sbo5b4lc", touched: false },
      { name: "dep_a-1aaaaaaaaaaaa", touched: true }, { name: "dep_a-2bbbbbbbbbbbb", touched: false },
    ],
  });
  const stale = new Set(paths);
  for (const p of [`.fingerprint/dep-a-${OLD}`, `.fingerprint/dep-a-${RUN_OLD}`, `deps/libdep_a-${OLD}.rlib`, `deps/dep_a-${OLD}.d`, `build/dep-a-${RUN_OLD}`, "incremental/gone-2dzz4sbo5b4lc", "incremental/dep_a-2bbbbbbbbbbbb"]) {
    assert.ok(stale.has(p), `${p} is stale`);
  }
  // Used units, a fresh crate's only incremental dir, and what no fingerprint names stay.
  for (const p of [`.fingerprint/dep-a-${NEW}`, `deps/libdep_a-${NEW}.rlib`, `deps/libmy_pm-${FRESH}.so`, `build/dep-a-${RUN_NEW}`, "deps/orphan-ffffffffffffffff", "deps/rmeta-tmp", "incremental/my_pm-3ge0gnqx4rjez", "incremental/dep_a-1aaaaaaaaaaaa"]) {
    assert.ok(!stale.has(p), `${p} is kept`);
  }
  assert.ok(units > 0);
});

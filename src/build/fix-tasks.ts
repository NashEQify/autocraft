// Build tasks that run a fix's tests on the repo's default branch: head (fix plus test) and base (test only, expected to fail).
import type { NewTask } from "./tasks.ts";
import { warmKeyOf } from "./tasks.ts";
import { rustPlan } from "../worker/rust.ts";
import type { TaskStep } from "../worker/types.ts";
import { changedRsFiles, lintSteps } from "../prepush/index.ts";

const REQUIRES = { os: "linux", toolchains: ["rust-stable"] } as const;

const regressionStep = (crate: string, test: string): TaskStep =>
  ({ name: "regression", cmd: ["cargo", "test", "--offline", "--locked", "-p", crate, "--test", test], network: "none", timeoutSec: 3600 });

/** Head: main plus the full patch, the crate's tests and the regression test. Base: main plus the test file, expected to fail. */
export function tasksFor(r: { repo: string; number: number | null; main_sha: string; crate: string; test: string }, patch: string, testPatch: string, step = "fix-check"): NewTask[] {
  const common = { step, repo: r.repo, number: r.number, headSha: r.main_sha, baseSha: r.main_sha, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, warm: { key: warmKeyOf(r.repo), role: "use" as const } };
  const steps = rustPlan({ cargoArgs: ["-p", r.crate] });
  // The head task also formats and lints the files the patch changes; the base task only has to fail the regression test.
  const lint = lintSteps(changedRsFiles(patch));
  const baseSteps = steps.map((s): TaskStep => (s.name === "test" ? { ...s, cmd: [...s.cmd, "--test", r.test] } : s));
  return [{ ...common, plan: [...steps, regressionStep(r.crate, r.test), ...lint], patch }, { ...common, plan: baseSteps, patch: testPatch }];
}

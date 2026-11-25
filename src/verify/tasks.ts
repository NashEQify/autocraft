// Build tasks for a validated plan, and the warm build of the default branch.
import { parsePatch, parsePlan, parseRequires, parseWarm, warmKeyOf } from "../build/tasks.ts";
import { BuildError } from "../build/envs.ts";
import { cloneTasks, createTasks, loadEnvs, type NewTask } from "../data/build/index.ts";
import { currentJobId } from "../agents/call.ts";
import { rustPlan } from "../worker/rust.ts";
import { WORKSPACE_TEST_TARGETS } from "../worker/rust-targets.ts";
import type { TaskStep } from "../worker/types.ts";
import { featureOn } from "../build/features.ts";
import type { VerifyPlan } from "./plan.ts";
import type { ParamSpec, ScreenshotConfigBody } from "./screenshot-config.ts";
import type { ShotStep } from "./types.ts";
import type { Db } from "../db/index.ts";

const REQUIRES = { os: "linux", toolchains: ["rust-stable"] } as const;
export const WARM_EVERY_MS = 24 * 3600_000;
/** Warm builds wait behind verification tasks. */
export const WARM_PRIORITY = -10;

type Planned = Exclude<VerifyPlan, { kind: "ci-enough" }>;

/** The tasks that run `plan` at `head` (and, for a regression, at `base`). Order: head first. */
export function tasksFor(plan: Planned, c: { repo: string; number: number; head: string; base: string }): NewTask[] {
  const common = { step: "verify", repo: c.repo, number: c.number, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, warm: { key: warmKeyOf(c.repo), role: "use" as const } };
  if (plan.kind === "tests") {
    const steps = rustPlan({ cargoArgs: plan.crates.flatMap((n) => ["-p", n]) }).map((s): TaskStep =>
      s.name === "test" && plan.tests.length ? { ...s, cmd: [...s.cmd, "--", ...plan.tests] } : s);
    return [{ ...common, headSha: c.head, baseSha: c.base, plan: steps }];
  }
  const steps = rustPlan({ cargoArgs: ["-p", plan.crate] }).map((s): TaskStep =>
    s.name === "test" ? { ...s, cmd: [...s.cmd, "--test", plan.test] } : s);
  return [
    { ...common, headSha: c.head, baseSha: c.base, plan: steps, patch: plan.patch },
    { ...common, headSha: c.base, baseSha: c.base, plan: steps, patch: plan.patch },
  ];
}

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const STEP_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** The task as the table stores it: every field validated, the job filled in from the running job. */
function validated(t: NewTask): NewTask {
  if (typeof t.step !== "string" || !STEP_RE.test(t.step)) throw new BuildError(400, "step is not valid");
  if (typeof t.repo !== "string" || !REPO_RE.test(t.repo)) throw new BuildError(400, "repo is not valid");
  if (!SHA_RE.test(t.headSha)) throw new BuildError(400, "headSha must be a full lowercase commit id");
  if (t.baseSha != null && !SHA_RE.test(t.baseSha)) throw new BuildError(400, "baseSha must be a full lowercase commit id");
  if (t.number != null && (!Number.isInteger(t.number) || t.number < 1)) throw new BuildError(400, "number is not valid");
  const priority = t.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BuildError(400, "priority must be -100 to 100");
  return {
    ...t, jobId: t.jobId ?? currentJobId(), priority, requires: parseRequires(t.requires), plan: parsePlan(t.plan),
    ...(t.patch === undefined ? {} : { patch: parsePatch(t.patch) }), ...(t.warm === undefined ? {} : { warm: parseWarm(t.warm) }),
  };
}

/** Validates and queues tasks in one statement pair; returns their ids in order. A refusal queues none. */
export async function queueNewTasks(db: Db, tasks: NewTask[]): Promise<number[]> {
  return await createTasks(db, tasks.map(validated));
}

/** Queues the tasks; returns their ids, head task first. */
export async function queueTasks(db: Db, plan: Planned, c: { repo: string; number: number; head: string; base: string }): Promise<number[]> {
  return await queueNewTasks(db, tasksFor(plan, c));
}

/**
 * Queues a build-only task for the default branch head when the repo has no warm build for it yet and
 * none in the last 24 hours. Returns the task id, or null when nothing was queued. These builds fill a worker's own warm
 * dirs (src/worker/warm.ts), so none is queued without an enabled worker environment: build pods start from the warm
 * store, which the warm producer fills (src/build/warm-queue.ts).
 */
export async function queueWarmBuild(db: Db, repo: string, mainSha: string): Promise<number | null> {
  if (!(await loadEnvs(db, { enabled: true })).some((e) => e.kind !== "kubernetes")) return null;
  // NEEDS build.queueLocalWarmBuild: skip a head that already has a warm build task, and a repo with one queued in the last 24 hours (WARM_EVERY_MS); no loader reads warm-role build tasks.
  return (await queueNewTasks(db, [{
    step: "verify", repo, headSha: mainSha, baseSha: mainSha, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, priority: WARM_PRIORITY,
    plan: warmBuildPlan(), warm: { key: warmKeyOf(repo), role: "build" },
  }]))[0] ?? null;
}

/** The worker's warm build: the units a whole-workspace plan builds and tests, as the cluster's warm producer builds them. */
function warmBuildPlan(): TaskStep[] {
  const [fetch, build] = rustPlan({ cargoArgs: ["--workspace"], test: false });
  return [fetch!, build!, { name: "build tests", cmd: ["cargo", "test", "--offline", "--locked", "--no-run", ...WORKSPACE_TEST_TARGETS], network: "none", timeoutSec: 3600 }];
}

/** Queues a new task with the same step, commits, requirements, plan, patch and warm role as task `id`. */
export async function cloneTask(db: Db, id: number): Promise<number> {
  return (await cloneTasks(db, [id])).get(id)!;
}

const RENDER_TIMEOUT_SEC = 120;
const OUT_DIR = "/out";
/** The artifact a capture step at 1-based position `i` of the script writes. */
/** The task step of render tasks. Not "verify": the verification retry counts the verify tasks of a head. */
export const SCREENSHOT_STEP = "screenshot";
export const shotName = (i: number): string => `s${i}.png`;

/** Replaces `{param}` and `{out}` in one pass, so a value is never expanded again. `out` is null outside a capture command. */
const expand = (t: string, args: Record<string, string | number>, out: string | null): string =>
  t.replace(/\{([^{}]*)\}/g, (_m, name: string) => (name === "out" && out !== null ? out : String(args[name])));

/** The command-line words a step adds after `--` (driver "args"): the command's argv with its arguments filled in. */
function argvOf(config: Pick<ScreenshotConfigBody, "commands">, step: ShotStep, i: number): string[] {
  const spec = config.commands[step.cmd]!;
  return (spec.argv ?? []).map((t) => expand(t, step.args, spec.capture ? `${OUT_DIR}/${shotName(i)}` : null));
}

/** One JSON line of the script file (driver "jsonl"); a value that is exactly one integer param stays a number. */
function lineOf(config: Pick<ScreenshotConfigBody, "commands">, step: ShotStep, i: number): string {
  const spec = config.commands[step.cmd]!;
  const out = spec.capture ? `${OUT_DIR}/${shotName(i)}` : null;
  const obj: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(spec.line ?? {})) {
    const whole = typeof v === "string" ? /^\{([^{}]*)\}$/.exec(v) : null;
    const p: ParamSpec | undefined = whole ? spec.params[whole[1]!] : undefined;
    obj[k] = typeof v !== "string" ? v : p && "int" in p ? Number(step.args[whole![1]!]) : expand(v, step.args, out);
  }
  return JSON.stringify(obj);
}

/**
 * The tasks that render a validated screenshot script at `head` and at `base`. Head first. The base task runs at
 * the base commit for both of its commits, as the regression pair does, so both resolve the same gate and image.
 * Only the config's templates and validated argument values reach a command line; the model's text never does.
 */
export function screenshotTasks(script: ShotStep[], config: Pick<ScreenshotConfigBody, "package" | "example" | "driver" | "commands">, c: { repo: string; number: number; head: string; base: string }): NewTask[] {
  const common = {
    step: SCREENSHOT_STEP, repo: c.repo, number: c.number, warm: { key: warmKeyOf(c.repo), role: "use" as const },
    requires: { os: "linux" as const, toolchains: ["rust-stable"], display: true },
  };
  const run = ["cargo", "run", "--offline", "--locked", "-p", config.package, "--example", config.example];
  const steps: TaskStep[] = [
    rustPlan({ test: false })[0]!,
    { name: "build", cmd: ["cargo", "build", "--offline", "--locked", "-p", config.package, "--example", config.example], network: "none", timeoutSec: 3600 },
  ];
  if (config.driver === "args") {
    script.forEach((s, n) => {
      const i = n + 1;
      steps.push({ name: config.commands[s.cmd]!.capture ? `render s${i}` : `run ${i}`, cmd: [...run, "--", ...argvOf(config, s, i)], network: "none", timeoutSec: RENDER_TIMEOUT_SEC,
        ...(config.commands[s.cmd]!.capture ? { artifacts: [shotName(i)] } : {}) });
    });
  } else {
    // One process reads the whole script, so a later line sees what an earlier one set up. The shell text is a constant; the script is only $1.
    const lines = script.map((s, n) => lineOf(config, s, n + 1)).join("\n");
    const artifacts = script.flatMap((s, n) => (config.commands[s.cmd]!.capture ? [shotName(n + 1)] : []));
    steps.push({ name: "render", cmd: ["sh", "-c", `printf "%s\\n" "$1" > /tmp/ui.jsonl && exec ${run.join(" ")} -- /tmp/ui.jsonl`, "sh", lines], network: "none", timeoutSec: RENDER_TIMEOUT_SEC * Math.max(1, artifacts.length), artifacts });
  }
  return [
    { ...common, headSha: c.head, baseSha: c.base, plan: steps },
    { ...common, headSha: c.base, baseSha: c.base, plan: steps },
  ];
}

/** Queues the screenshot tasks; returns their ids, head task first, or [] when the repo's screenshots switch is off. */
export async function queueScreenshotTasks(db: Db, script: ShotStep[], config: Pick<ScreenshotConfigBody, "package" | "example" | "driver" | "commands">, c: { repo: string; number: number; head: string; base: string }): Promise<number[]> {
  if (!await featureOn(db, "screenshots", c.repo)) return [];
  return await queueNewTasks(db, screenshotTasks(script, config, c));
}

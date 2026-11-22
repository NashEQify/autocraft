// Before/after screenshots of UI pull requests (build feature "screenshots"). maybeScreenshot runs inside
// runVerify for a PR head: when the repo's switch is on, it has a screenshot config and the diff touches a UI
// path, a planning call chooses a script from the config's commands and two display tasks render it at the base
// and at the head. It never touches the `verifications` rows that gate merges; its own state is `screenshot_runs`.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absolute } from "../build/artifacts.ts";
import { BuildError } from "../build/envs.ts";
import { TERMINAL, getTask } from "../build/tasks.ts";
import { holdMerge, ControlError } from "../merge/controls.ts";
import { pilotExprFor } from "../pilot.ts";
import { backlogHeldExpr } from "../dupes/held.ts";
import * as kx from "../db/kx.ts";
import { leaseItem } from "../runner/leases.ts";
import { scrub } from "../runner/scrub.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { currentHeadExpr, cancelOpen, oneLine, outcomeOf } from "./results.ts";
import { featureOn } from "../build/features.ts";
import { runModelStep } from "../agents/step.ts";
import { VERIFY_COMPARE, VERIFY_SCREENSHOT } from "../agents/steps.ts";
import { cachedDiff, codeDiff, splitDiff } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { jobItem } from "../runner/job-items.ts";
import { matchesGlob } from "node:path";
import { getConfig, type ScreenshotConfig } from "./screenshot-config.ts";
import type { CompareParsed, ScreenshotParsed } from "./plan.ts";
import type { VerifyCandidate } from "./candidates.ts";
import type { VerifyDeps } from "./index.ts";
import { SCREENSHOT_STEP, cloneTask, queueScreenshotTasks } from "./tasks.ts";
import type { ScreenshotCompareInput, ScreenshotPlanInput, ShotStep } from "./types.ts";
import type { CollectDeps } from "./results.ts";
import { mapSeq, someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

/** Characters of diff the screenshot planner is shown. */
export const MAX_SHOT_DIFF_CHARS = 60_000;

/** Injectable parts, so tests need no model. `plan` returns the parsed reply, or null when the call gave no answer. */
export type ScreenshotDeps = {
  plan?: (input: ScreenshotPlanInput, ctx: { ref: string; config: ScreenshotConfig }) => Promise<ScreenshotParsed | null>;
  /** The model comparison of the before/after images; `dir` holds `before/` and `after/`. Null when the call gave no answer. */
  compare?: (input: ScreenshotCompareInput, ctx: { ref: string; dir: string }) => Promise<CompareParsed | null>;
};

type Env = Pick<VerifyDeps, "fetchDiff" | "baseOf" | "model" | "checkout"> & { screenshots?: ScreenshotDeps };
type Cand = Pick<VerifyCandidate, "repo" | "number" | "title" | "body" | "head_oid" | "label" | "review">;

const nowIso = (): string => new Date().toISOString();
const refOf = (c: { repo: string; number: number }): string => `${c.repo}#${c.number}`;

/** The state of a screenshot run for a head: its row is the record that the head was handled. */
export async function insertRun(db: Db, c: { repo: string; number: number; head_oid: string }, r: { state: string; reason: string | null; baseSha?: string | null; plan?: unknown; headTask?: number | null; baseTask?: number | null }): Promise<void> {
  const at = nowIso();
  await db.run(db.k.insertInto("screenshot_runs").values({
    repo: c.repo, number: c.number, head_sha: c.head_oid, base_sha: r.baseSha ?? null, state: r.state, reason: r.reason,
    plan: r.plan === undefined ? null : JSON.stringify(r.plan), head_task_id: r.headTask ?? null, base_task_id: r.baseTask ?? null, created_at: at,
    finished_at: r.state === "planned" ? null : at,
  }).onConflict((oc) => oc.doNothing()));
}

async function stage(db: Db, c: Cand, name: "screenshot-planned" | "screenshot-skipped", note: string, log: (line: string) => void): Promise<void> {
  await jobItem(db, c.repo, c.number, `${name}: ${note} at ${c.head_oid.slice(0, 7)}`, log);
}

/** Whether any changed path of the diff matches one of the repo's UI globs. */
export const touchesUi = (paths: string[], globs: string[]): boolean => paths.some((p) => globs.some((g) => matchesGlob(p, g)));

/**
 * Plans and queues the screenshots of one PR head, when due. Returns whether tasks were queued. Throws nothing the
 * caller must handle except errors outside the step itself (runVerify catches and logs them).
 */
export async function maybeScreenshot(db: Db, c: Cand, deps: Env, log: (line: string) => void, runId: string): Promise<boolean> {
  if (!await featureOn(db, "screenshots", c.repo)) return false;
  const config = await getConfig(db, c.repo);
  if (!config) return false;
  if (await db.get(db.k.selectFrom("screenshot_runs").select((eb) => eb.lit(1).as("one"))
    .where("repo", "=", c.repo).where("number", "=", c.number).where("head_sha", "=", c.head_oid))) return false;
  const ref = refOf(c);
  const d = await cachedDiff(db, c.repo, c.number, c.head_oid, deps.fetchDiff);
  if (!d.ok) { log(`  ${ref}: screenshots: no diff: ${d.error}`); return false; }
  if (!touchesUi(splitDiff(d.text).map((f) => f.path), config.ui_paths)) return false;
  const base = await deps.baseOf(c.repo, c.number);
  if (!base) { log(`  ${ref}: screenshots: no base commit`); return false; }

  const cd = codeDiff(d.text, true);
  const input: ScreenshotPlanInput = {
    ref, title: c.title, body: c.body, label: c.label, review: c.review, files: cd.files, diff: cd.text.slice(0, MAX_SHOT_DIFF_CHARS),
    commands: Object.entries(config.commands).map(([name, s]) => ({ name, doc: s.doc, params: s.params, capture: s.capture === true })),
    ...(config.size ? { size: config.size } : {}),
  };
  const plan = deps.screenshots?.plan ?? (async (i: ScreenshotPlanInput, x: { ref: string; config: ScreenshotConfig }): Promise<ScreenshotParsed | null> => {
    const checkout = (await deps.checkout?.(c.repo, c.number, c.head_oid)) ?? undefined;
    if (checkout) i.repo_dir = REPO_PATH;
    const r = await runModelStep(db, VERIFY_SCREENSHOT, i, {
      model: deps.model, checkout, ctx: x,
      usage: { run: runId, agent: `screenshot-${c.number}`, stage: "verify", items: (ok: boolean) => (ok ? 1 : 0) },
    });
    return r.ok ? r.value : null;
  });
  const result = await plan(input, { ref, config });
  if (!result) { log(`  ${ref}: screenshots: no answer from the planner`); return false; }
  if (!result.ok) {
    log(`  ${ref}: screenshots: invalid plan: ${result.error}`);
    await insertRun(db, c, { state: "error", reason: `invalid plan: ${result.error}`.slice(0, 300), baseSha: base });
    return false;
  }
  const p = result.plan;
  if (!p.screenshot) {
    await insertRun(db, c, { state: "skipped", reason: p.reason, baseSha: base });
    await stage(db, c, "screenshot-skipped", p.reason, log);
    return false;
  }
  try {
    const ids = await queueScreenshotTasks(db, p.steps, config, { repo: c.repo, number: c.number, head: c.head_oid, base });
    if (!ids.length) return false;   // the switch went off since the check above
    await insertRun(db, c, { state: "planned", reason: p.reason, baseSha: base, plan: { steps: p.steps }, headTask: ids[0] ?? null, baseTask: ids[1] ?? null });
    await stage(db, c, "screenshot-planned", `${p.steps.length} steps: ${p.reason}`, log);
    return true;
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    log(`  ${ref}: screenshots: tasks not queued: ${e.message}`);
    await insertRun(db, c, { state: "error", reason: `tasks not queued: ${e.message}`.slice(0, 300), baseSha: base });
    return false;
  }
}

// ---- collecting ---------------------------------------------------------------

type Run = {
  repo: string; number: number; head_sha: string; base_sha: string | null; state: string; plan: string | null;
  head_task_id: number | null; base_task_id: number | null; item_state: string | null; item_head: string | null;
  title: string | null; body: string | null;
};
const SHOT_RE = /^s\d+\.png$/;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8192;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The sha256 of a stored screenshot, or null when it is not a PNG of at most 8 MB and 8192 x 8192 pixels. Checks the size and the header before reading the whole file. */
async function validImageHash(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size < 33 || st.size > MAX_IMAGE_BYTES) return null;
    const fh = await open(file, "r");
    const head = Buffer.alloc(24);
    try { await fh.read(head, 0, 24, 0); } finally { await fh.close(); }
    if (!head.subarray(0, 8).equals(PNG_SIGNATURE) || head.readUInt32BE(8) !== 13 || head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
    const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
    if (w < 1 || h < 1 || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) return null;
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch { return null; }
}

/** A run in flight whose tasks ended or started, or whose PR moved or closed: one row when there is one. */
export const movedRun = (db: Db) => db.k.selectFrom("screenshot_runs as r")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "r.repo").onRef("i.number", "=", "r.number"))
    .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "r.repo").onRef("c.number", "=", "r.number"))
    .leftJoin("build_tasks as h", "h.id", "r.head_task_id")
    .leftJoin("build_tasks as b", "b.id", "r.base_task_id")
    .select((eb) => eb.lit(1).as("one"))
    .where("r.state", "in", ["planned", "running"])
    .where((eb) => pilotExprFor(db, eb, "r.repo", "r.number"))
    .where((eb) => eb.not(backlogHeldExpr(db, eb, "r")))
    .where((eb) => eb.or([
      eb("i.state", "is distinct from", "OPEN"),
      eb(currentHeadExpr(eb), "is distinct from", eb.ref("r.head_sha")),
      eb.and([eb("h.state", "in", TERMINAL), eb.or([eb("b.id", "is", null), eb("b.state", "in", TERMINAL)])]),
      eb.and([eb("r.state", "=", "planned"), eb.or([eb("h.state", "in", ["claimed", "running"]), eb("b.state", "in", ["claimed", "running"])])]),
    ]))
    .limit(1);

/**
 * Whether a run in flight has work: its tasks ended or started, its PR moved or closed, or the repo's switch went off.
 * `moved`: the answer of movedRun, when the caller read it.
 */
export async function screenshotsDue(db: Db, moved?: boolean): Promise<boolean> {
  if (moved ?? !!await db.get(movedRun(db))) return true;
  const repos = await db.all(db.k.selectFrom("screenshot_runs as r").select("r.repo").distinct()
    .where("r.state", "in", ["planned", "running"])
    .where((eb) => pilotExprFor(db, eb, "r.repo", "r.number"))
    .where((eb) => eb.not(backlogHeldExpr(db, eb, "r"))));
  return await someSeq(repos, async (r) => !await featureOn(db, "screenshots", r.repo));
}

/** The default comparison: Opus reads the image pairs from `dir`, mounted as the call's read-only checkout (a plain directory works: nothing of the sandbox needs a repository). */
async function compareWithModel(db: Db, input: ScreenshotCompareInput, ctx: { ref: string; dir: string }, runId: string, n: number): Promise<CompareParsed | null> {
  const r = await runModelStep(db, VERIFY_COMPARE, { ...input, repo_dir: REPO_PATH }, {
    checkout: ctx.dir, ctx: { ref: ctx.ref },
    usage: { run: runId, agent: `screenshot-compare-${n}`, stage: "verify", items: (ok: boolean) => (ok ? 1 : 0) },
  });
  return r.ok ? r.value : null;
}

/**
 * Reads the screenshot runs that are planned or running: ends them when their PR moved on or the switch went off,
 * and when both tasks have ended compares the images. Returns how many runs left planned/running. Only a clear
 * regression holds the merge, and only while the head is still the run's head; any error holds nothing.
 */
export async function collectScreenshots(db: Db, deps: Pick<CollectDeps, "screenshots">, log: (line: string) => void, runId: string, stopping?: () => Promise<boolean>): Promise<number> {
  const rows: Run[] = await db.all(db.k.selectFrom("screenshot_runs as r")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "r.repo").onRef("i.number", "=", "r.number"))
    .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "r.repo").onRef("c.number", "=", "r.number"))
    .select((eb) => [...kx.cols("screenshot_runs", "r"), "i.state as item_state", currentHeadExpr(eb).as("item_head"), "i.title as title", "i.body as body"])
    .where("r.state", "in", ["planned", "running"])
    .where((eb) => pilotExprFor(db, eb, "r.repo", "r.number"))
    .where((eb) => eb.not(backlogHeldExpr(db, eb, "r")))
    .orderBy("r.created_at").orderBy("r.number"));
  let changed = 0;
  for (const r of rows) {
    if (await stopping?.()) break;
    const release = await leaseItem(db, `pr:${r.repo}#${r.number}`, log);
    if (!release) continue;
    try { if (await collectOne(db, r, deps, log, runId)) changed++; } catch (e) { log(`  ${r.repo}#${r.number}: screenshots: ${(e as Error).message}`); } finally { await release(); }
  }
  return changed;
}

async function collectOne(db: Db, r: Run, deps: Pick<CollectDeps, "screenshots">, log: (line: string) => void, runId: string): Promise<boolean> {
  const ref = `${r.repo}#${r.number}`, sha7 = r.head_sha.slice(0, 7);
  const at = (): string => new Date().toISOString();
  const finish = async (state: string, f: { reason?: string | null; verdict?: string; clear?: boolean; comparison?: string; model?: string } = {}): Promise<boolean> =>
    Number((await db.run(db.k.updateTable("screenshot_runs")
      .set({ state, ...(f.reason == null ? {} : { reason: f.reason }), verdict: f.verdict ?? null, clear: f.clear === undefined ? null : f.clear ? 1 : 0, comparison: f.comparison ?? null, model: f.model ?? null, finished_at: at() })
      .where("repo", "=", r.repo).where("number", "=", r.number).where("head_sha", "=", r.head_sha).where("state", "in", ["planned", "running"]))).changes) > 0;
  // The only stage row a screenshot run writes is `hold`; its other outcomes are read from screenshot_runs.
  const row = async (stageName: string, note: string): Promise<void> => { await jobItem(db, r.repo, r.number, `${stageName}: ${note} at ${sha7}`, log); };
  const ids = [r.head_task_id, r.base_task_id];

  if (!await featureOn(db, "screenshots", r.repo)) {
    await cancelOpen(db, ids);
    return await finish("skipped", { reason: "screenshots switched off" });
  }
  if (r.item_state !== "OPEN" || r.item_head !== r.head_sha) {
    await cancelOpen(db, ids);
    if (await finish("stale", {})) { await jobItem(db, r.repo, r.number, `screenshots stale (${r.item_state === "OPEN" ? "head moved" : "no longer open"})`, log); return true; }
    return false;
  }
  const head = r.head_task_id === null ? null : await getTask(db, r.head_task_id);
  const base = r.base_task_id === null ? null : await getTask(db, r.base_task_id);
  if (!head || !base) { const w = "the build task is gone"; if (await finish("error", { reason: w })) { await row("screenshot-error", w); return true; } return false; }
  if (![head, base].every((t) => TERMINAL.includes(t.state))) {
    if (r.state === "planned" && [head, base].some((t) => t.state === "claimed" || t.state === "running")) {
      await db.run(db.k.updateTable("screenshot_runs").set({ state: "running" })
        .where("repo", "=", r.repo).where("number", "=", r.number).where("head_sha", "=", r.head_sha).where("state", "=", "planned"));
      return true;
    }
    return false;
  }

  const fail = async (why: string): Promise<boolean> => {
    const w = oneLine(why);
    if (!await finish("error", { reason: w })) return false;
    await row("screenshot-error", w);
    return true;
  };
  // A lost task or a build-environment error says nothing about the change: the pair is queued again once, as Verify does.
  const outcomes = [["head", head, outcomeOf(head)], ["base", base, outcomeOf(base)]] as const;
  if (outcomes.some(([, t, o]) => o.kind === "error" && t.state !== "cancelled")) {
    const tries = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n"))
      .where("step", "=", SCREENSHOT_STEP).where("repo", "=", r.repo).where("number", "=", r.number).where("head_sha", "=", r.head_sha).where("warm_role", "=", "use")))!.n;
    if (tries <= 1) {
      try {
        const [h, b] = await mapSeq([head.id, base.id], async (id) => await cloneTask(db, id)) as [number, number];
        await db.run(db.k.updateTable("screenshot_runs").set({ head_task_id: h, base_task_id: b, state: "planned" })
          .where("repo", "=", r.repo).where("number", "=", r.number).where("head_sha", "=", r.head_sha));
        await jobItem(db, r.repo, r.number, "screenshot render failed in the build environment; queued the tasks again", log);
        return true;
      } catch (e) { if (!(e instanceof BuildError)) throw e; }
    }
  }
  for (const [role, , o] of outcomes) {
    if (o.kind === "fail") return await fail(`${role} render step "${o.step}" ${o.timedOut ? "timed out" : `failed (exit ${o.exitCode ?? "none"})`}`);
    if (o.kind === "error") return await fail(`${role}: ${o.reason}`);
  }

  const shotsOf = async (id: number): Promise<Map<string, string>> => new Map((await db.all(db.k.selectFrom("build_artifacts").select(["name", "file"]).where("task_id", "=", id).orderBy("name")))
    .filter((a) => SHOT_RE.test(a.name)).map((a) => [a.name, a.file]));
  const before = await shotsOf(base.id), after = await shotsOf(head.id);
  const names = [...after.keys()].sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4)));
  if (!names.length) return await fail("the render stored no screenshot");
  if (names.length !== before.size || names.some((x) => !before.has(x))) return await fail("the base and the head produced different sets of screenshots");
  const files = (m: Map<string, string>, name: string): string | null => absolute(m.get(name)!);
  const pairs = names.map((name) => ({ name, b: files(before, name), a: files(after, name) }));
  if (pairs.some((p) => !p.a || !p.b)) return await fail("a stored screenshot is missing");
  // Images are the render's output, so they are untrusted: PNG signature, size and dimensions are checked before anything reads or copies them.
  const hashes: [string, string][] = [];
  for (const p of pairs) {
    const [a, b] = [await validImageHash(p.a!), await validImageHash(p.b!)];
    if (!a || !b) return await fail("the render stored an invalid image");
    hashes.push([a, b]);
  }
  const same = hashes.every(([a, b]) => a === b);
  if (same) {
    if (!await finish("compared", { verdict: "unchanged", comparison: "The screens are identical before and after." })) return false;
    await row("screenshot-compared", "unchanged");
    return true;
  }

  const script: ShotStep[] = (() => { try { return (JSON.parse(r.plan ?? "{}") as { steps?: ShotStep[] }).steps ?? []; } catch { return []; } })();
  const rev = await db.get(db.k.selectFrom("opus_reviews").select(["verdict", "reason"]).$narrowType<{ verdict: string }>()
    .where("repo", "=", r.repo).where("number", "=", r.number).where("head_oid", "=", r.head_sha).where("verdict", "is not", null));
  const input: ScreenshotCompareInput = {
    ref, title: r.title ?? "", body: r.body ?? "", script, review: rev ? { verdict: rev.verdict, reason: rev.reason ?? "" } : null,
    shots: names.map((name) => ({ name, before: `before/${name}`, after: `after/${name}` })),
  };
  const dir = mkdtempSync(join(tmpdir(), "shots-"));
  let parsed: CompareParsed | null;
  try {
    mkdirSync(join(dir, "before")); mkdirSync(join(dir, "after"));
    for (const p of pairs) { copyFileSync(p.b!, join(dir, "before", p.name)); copyFileSync(p.a!, join(dir, "after", p.name)); }
    parsed = await (deps.screenshots?.compare ?? ((i, x) => compareWithModel(db, i, x, runId, r.number)))(input, { ref, dir });
  } catch (e) {
    return await fail(`the comparison failed: ${(e as Error).message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (!parsed) return await fail("no answer from the comparison");
  if (!parsed.ok) return await fail(`invalid comparison: ${parsed.error}`);
  const { verdict, clear } = parsed.result;
  const summary = scrub(parsed.result.summary);
  const model = CLAUDE_PROMPTS["verify.compare"].models[0];
  if (!await finish("compared", { verdict, clear, comparison: summary, model })) return false;

  if (verdict === "regression" && clear) {
    // The head may have moved, or the switch gone off, while the model looked: hold only the head that was compared, and only while the feature is on.
    const now = await db.get(db.k.selectFrom("items as i").leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "i.repo").onRef("c.number", "=", "i.number"))
      .select((eb) => ["i.state as s", currentHeadExpr(eb).as("h")]).where("i.repo", "=", r.repo).where("i.number", "=", r.number));
    if (await featureOn(db, "screenshots", r.repo) && now?.s === "OPEN" && now.h === r.head_sha) {
      try {
        if (await holdMerge(db, "screenshots", r.repo, r.number, { head: r.head_sha, summary })) {
          await db.run(db.k.updateTable("screenshot_runs").set({ held: 1 })
            .where("repo", "=", r.repo).where("number", "=", r.number).where("head_sha", "=", r.head_sha));
          await db.run(db.k.insertInto("main.stages").values({ repo: r.repo, number: r.number, stage: "hold", at: at(), actor: "verify", note: `screenshots show a regression: ${summary}`.slice(0, 300) }));
          await row("screenshot-regression", summary);
          return true;
        }
      } catch (e) { if (!(e instanceof ControlError)) throw e; }
    }
  }
  await row("screenshot-compared", `${verdict}${clear ? "" : ", not clear"}: ${summary}`);
  return true;
}

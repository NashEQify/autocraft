// Our own build of PR heads (pr-builds feature): a second opinion beside upstream CI. It never holds a PR or changes a
// merge decision. One no-model job step queues the builds and collects the finished ones; the task runs in a worker.
// A build that fails where CI passed is noted on the item (stage row `pr-build-disagree`) and nothing more: our build
// lacks CI's gate inputs and toolchain targets, so such failures are often false.
import { BuildError } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { TERMINAL, cancelTask, createTask, getTask, warmKeyOf } from "../build/tasks.ts";
import { leaseItem } from "../runner/leases.ts";
import { jobItem } from "../runner/job-items.ts";
import { outcomeOf, currentHeadExpr } from "../verify/results.ts";
import { cloneTask } from "../verify/tasks.ts";
import { defaultDeps } from "../verify/index.ts";
import { cachedCrates, ghCrates, type CratesFetcher } from "../verify/crates.ts";
import { planFor } from "./plans.ts";
import { inBuildScope, scopeOf, selectPrBuilds } from "./select.ts";
import { baseScopeRepos } from "../pilot.ts";
import { someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export const STEP = "pr-build";
/** Below Verify's tasks (0), above the warm build (-10). */
export const PR_BUILD_PRIORITY = -5;
const ACTOR = "pr-build";
const SUMMARY_LIMIT = 200;

const now = (): string => new Date().toISOString();

export type PrBuildDeps = { fetchCrates: CratesFetcher; /** The PR's base commit, or null when GitHub did not answer. Default: GitHub. */ baseOf?: (repo: string, number: number) => Promise<string | null> };

/** Queues the build task of one PR head and records it. Returns the task id. */
export async function queuePrBuild(db: Db, c: { repo: string; number: number; head: string; base: string }): Promise<number | null> {
  const plan = planFor("rust", c.repo, c.head);
  if (!plan) return null;
  // The row and the task are written together, and an existing row for the head means the build was already queued.
  return await db.write(async () => {
    if (await db.get(db.k.selectFrom("main.pr_builds").select((eb) => eb.lit(1).as("one")).where("repo", "=", c.repo).where("number", "=", c.number).where("head_sha", "=", c.head))) return null;
    const id = await createTask(db, {
      step: STEP, repo: c.repo, number: c.number, headSha: c.head, baseSha: c.base, priority: PR_BUILD_PRIORITY, plan,
      requires: { os: "linux", toolchains: ["rust-stable"] }, warm: { key: warmKeyOf(c.repo), role: "use" },
    });
    await db.run(db.k.insertInto("main.pr_builds").values({ repo: c.repo, number: c.number, head_sha: c.head, scope: await scopeOf(db, c.repo), task_id: id, state: "queued", created_at: now() }));
    return id;
  });
}

/** The queued builds of a repo with their item's state and current head; `b` is the build, `i` the item, `c` its checks. */
const pendingOf = (db: Db, repo: string) => db.k.selectFrom("main.pr_builds as b")
  .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "b.repo").onRef("i.number", "=", "b.number"))
  .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "b.repo").onRef("c.number", "=", "b.number"))
  .select((eb) => ["b.repo", "b.number", "b.head_sha", "b.task_id", "b.retried", "i.state as item_state", currentHeadExpr(eb).as("item_head")])
  .where("b.state", "=", "queued").where("b.repo", "=", repo);

/** Repos with queued builds: they need a collect run (stale heads, a switch turned off, a repo that left scope) whatever the switch says. */
export async function reposWithQueuedBuilds(db: Db): Promise<string[]> {
  return (await db.all(db.k.selectFrom("main.pr_builds").select("repo").distinct().where("state", "=", "queued"))).map((r) => r.repo);
}

/** Failed builds whose CI turned green at the same head since the build ended. */
const lateDisagreements = async (db: Db, repo: string): Promise<{ number: number; head_sha: string; summary: string | null }[]> =>
  await db.all(db.k.selectFrom("main.pr_builds as b").innerJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "b.repo").onRef("c.number", "=", "b.number").onRef("c.head_oid", "=", "b.head_sha"))
    .select(["b.number", "b.head_sha", "b.summary"]).where("b.repo", "=", repo).where("b.state", "=", "failed").where("b.disagree", "=", 0).where("c.overall", "=", "success"));

/**
 * Whether the repo has work for a pr-build job: a PR to build, a queued build whose task ended, whose PR moved on or that must stop, or a failure that now disagrees with CI. Reads only.
 * `queued`: the repos with queued builds (reposWithQueuedBuilds), when the caller has read them.
 */
export async function prBuildDue(db: Db, repo: string, queued?: ReadonlySet<string>): Promise<boolean> {
  const on = await featureOn(db, "pr-builds", repo);
  if (on && (await selectPrBuilds(db, repo)).some((c) => c.rust !== false)) return true;
  if (on && (await lateDisagreements(db, repo)).length) return true;
  if (queued && !queued.has(repo)) return false;
  // The scope is read only for a queued build that gets that far.
  let scope: Set<string> | undefined;
  return await someSeq(await db.all(pendingOf(db, repo)), async (p) => {
    if (!on || p.item_state !== "OPEN" || p.item_head !== p.head_sha || p.task_id === null || !await inBuildScope(db, p.repo, p.number, scope ??= await baseScopeRepos(db))) return true;
    return !!await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.lit(1).as("one")).where("id", "=", p.task_id).where("state", "in", TERMINAL));
  });
}

export type PrBuildSummary = { queued: number; passed: number; failed: number; errors: number; stale: number; retried: number; disagreements: number };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);

/** Reads the finished tasks of the repo's queued builds and records their state. */
export async function collectPrBuilds(db: Db, repo: string, log: (line: string) => void = console.log): Promise<Omit<PrBuildSummary, "queued">> {
  const s = { passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  const scope = await baseScopeRepos(db);
  for (const p of await db.all(pendingOf(db, repo).orderBy("b.created_at").orderBy("b.number"))) {
    const release = await leaseItem(db, `pr:${p.repo}#${p.number}`, log);
    if (!release) continue;
    try {
      const finish = async (state: string, summary: string | null, extra: { ci?: string | null; disagree?: boolean } = {}): Promise<boolean> =>
        Number((await db.run(db.k.updateTable("main.pr_builds").set({ state, summary, ci_overall: extra.ci ?? null, disagree: extra.disagree ? 1 : 0, finished_at: now() })
          .where("repo", "=", p.repo).where("number", "=", p.number).where("head_sha", "=", p.head_sha).where("state", "=", "queued"))).changes) > 0;
      const task = p.task_id === null ? null : await getTask(db, p.task_id);
      // A head that moved, a PR no longer open, a switch turned off or a PR out of the worker's scope ends the build.
      if (p.item_state !== "OPEN" || p.item_head !== p.head_sha || !await featureOn(db, "pr-builds", p.repo) || !await inBuildScope(db, p.repo, p.number, scope)) {
        if (task && !TERMINAL.includes(task.state)) await cancelTask(db, task.id, ACTOR);
        if (await finish("stale", null)) s.stale++;
        continue;
      }
      if (!task) { if (await finish("error", "the build task is gone")) s.errors++; continue; }
      if (!TERMINAL.includes(task.state)) continue;
      const out = outcomeOf(task);
      // Only a failed or lost task is tried again; an operator's cancel stands.
      if (out.kind === "error" && task.state !== "cancelled" && p.retried < 1) {
        try {
          const id = await cloneTask(db, task.id);
          await db.run(db.k.updateTable("main.pr_builds").set((eb) => ({ task_id: id, retried: eb("retried", "+", 1) }))
            .where("repo", "=", p.repo).where("number", "=", p.number).where("head_sha", "=", p.head_sha));
          s.retried++;
          await jobItem(db, p.repo, p.number, `pr-build: ${out.reason}; queued again`, log);
          continue;
        } catch (e) {
          if (!(e instanceof BuildError)) throw e;
        }
      }
      const sha7 = p.head_sha.slice(0, 7);
      if (out.kind === "pass") {
        if (await finish("passed", null)) { s.passed++; await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: passed`, log); }
      } else if (out.kind === "error") {
        if (await finish("error", oneLine(out.reason))) { s.errors++; await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: error: ${oneLine(out.reason)}`, log); }
      } else {
        const why = `${out.step} ${out.timedOut ? "timed out" : `failed with exit code ${out.exitCode ?? "none"}`}`;
        // CI at the same head: the checks row counts only while it was read at this head.
        const ci = (await db.get(db.k.selectFrom("pr_checks").select("overall").where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", p.head_sha)))?.overall ?? null;
        const disagree = ci === "success";
        if (await finish("failed", why, { ci, disagree })) {
          s.failed++;
          await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: failed: ${why}`, log);
          if (disagree) {
            s.disagreements++;
            await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: failed (${why}) while upstream CI passed`, log);
          }
        }
      }
    } finally { await release(); }
  }
  // CI can finish after our build: the failure then disagrees with it. Noted once; the disagree flag keeps it from repeating.
  for (const d of await lateDisagreements(db, repo)) {
    const r = await db.run(db.k.updateTable("main.pr_builds").set({ disagree: 1, ci_overall: "success" })
      .where("repo", "=", repo).where("number", "=", d.number).where("head_sha", "=", d.head_sha).where("state", "=", "failed").where("disagree", "=", 0));
    if (Number(r.changes) > 0) { s.disagreements++; await jobItem(db, repo, d.number, `pr-build at ${d.head_sha.slice(0, 7)}: failed (${d.summary ?? "failed"}) while upstream CI passed`, log); }
  }
  return s;
}

/** The job step: collect finished builds (also while the switch is off, which stops the queued ones), then queue the builds of new heads while it is on. */
export async function runPrBuilds(db: Db, repo: string, log: (line: string) => void = console.log, deps: PrBuildDeps = { fetchCrates: ghCrates }): Promise<PrBuildSummary> {
  const zero: PrBuildSummary = { queued: 0, passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  const out: PrBuildSummary = { ...zero, ...await collectPrBuilds(db, repo, log) };
  if (!await featureOn(db, "pr-builds", repo)) return out;
  for (const c of await selectPrBuilds(db, repo)) {
    if (c.rust === null) {
      const r = await cachedCrates(repo, c.head, deps.fetchCrates, db);
      if (!r.ok) {
        // Recorded as an error so the head is not selected (and fetched) again; a new push is a new head.
        await db.run(db.k.insertInto("main.pr_builds").values({ repo, number: c.number, head_sha: c.head, scope: await scopeOf(db, repo), state: "error", summary: oneLine(`no crate list: ${r.error}`), created_at: now(), finished_at: now() })
          .onConflict((oc) => oc.doNothing()));
        log(`  ${repo}#${c.number}: no crate list: ${r.error}`);
        continue;
      }
      if (!r.rust) continue;
    }
    // The worker takes its CI gate from the base commit, so a build is never queued without one.
    const base = await (deps.baseOf ?? defaultDeps().baseOf)(repo, c.number);
    if (!base) { log(`  ${repo}#${c.number}: no base commit; not queued`); continue; }
    const release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
    if (!release) continue;
    try {
      if (!await featureOn(db, "pr-builds", repo)) break;
      if (await queuePrBuild(db, { ...c, base }) !== null) { out.queued++; await jobItem(db, repo, c.number, `pr-build queued at ${c.head.slice(0, 7)}`, log); }
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      log(`  ${repo}#${c.number}: not queued: ${e.message}`);
      break;
    } finally { await release(); }
  }
  return out;
}

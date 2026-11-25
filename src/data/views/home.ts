// reads: planner.item_plans, mirror.items, jobs.jobs
// The maintainer Home: live workflows with their item titles, what the pipeline stopped, health, findings the fix gave up on and the Task Runner line.
import type { Db } from "../../db/index.ts";
import { jsonText } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as mirror from "../mirror/index.ts";
import * as runners from "../runners/index.ts";
import * as security from "../security/index.ts";
import * as workflow from "../workflow/index.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { loadHealthFacts, type HealthOptions } from "./health.ts";
import { loadStopped } from "./stopped.ts";
import type { HomeFacts, Scope } from "./types.ts";
import type { StageDefaults } from "../control/types.ts";

export type HomeOptions = { nowMs: number; withRunner: boolean; health: HealthOptions; limits: { steps: readonly string[]; defaults: StageDefaults } };

const NONE = () => new Set<never>();

export async function loadMaintainHome(db: Db, scope: Pick<Scope, "repos" | "hidden" | "staff" | "login">, o: HomeOptions): Promise<HomeFacts> {
  const q = queryDb(db);
  // The health read opens its own wave, so it runs beside this one.
  const [health, [live, stops, attention, ciFixFailed, failedJobs, snapshot]] = await Promise.all([loadHealthFacts(db, o.nowMs, o.health), db.together(() => Promise.all([
    workflow.listWorkflows(db, { live: true, repos: scope.repos }),
    loadStopped(db, scope, o.limits),
    scope.staff ? security.loadFindingAttention(db, { hide: scope.hidden, oldest: 0 }) : Promise.resolve(null),
    scope.staff ? q.all(q.k.selectFrom("item_plans as p").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
      .select(["p.repo", "p.number", "i.title"]).where("i.state", "=", "OPEN").where((eb) => eb(jsonText(db, "p.view", "$.cifix"), "=", "cifix-failed"))
      .where(hiddenRepos(db, "i.repo", scope.hidden)).orderBy("p.planned_at", "desc").limit(20)) : Promise.resolve([]),
    q.all(q.k.selectFrom("jobs").select((eb) => ["step", "repo", eb.fn.countAll<number>().as("n")]).where("state", "=", "failed")
      .where("ended_at", ">", new Date(o.nowMs - 3_600_000).toISOString()).where((eb) => eb.or([eb("repo", "is", null), hiddenRepos(db, "repo", scope.hidden)])).groupBy(["step", "repo"])),
    o.withRunner && scope.login ? runners.loadRunnerSnapshot(db, o.nowMs) : Promise.resolve(null),
  ]))]);
  const refs = live.map((w) => ({ repo: w.repo, number: w.number }));
  const [items, last, mine] = await db.together(() => Promise.all([
    mirror.loadItems(db, refs, "card"),
    workflow.loadLastEventKinds(db, refs),
    o.withRunner && scope.login ? runners.loadHelpers(db, [scope.login], o.nowMs) : Promise.resolve(null),
  ]));
  return {
    rows: live.map((w) => {
      const key = `${w.repo}#${w.number}`;
      return { ...w, title: items.get(key)?.title ?? null, author: items.get(key)?.author ?? null, lastEvent: last.get(key) ?? null };
    }),
    attention: { stops, health, gaveUp: attention?.gaveUp.flatMap((g) => (g.last_failure === null ? [] : [g])) ?? [], ciFixFailed: ciFixFailed as { repo: string; number: number; title: string }[], failedJobs: failedJobs.map((j) => ({ step: j.step, repo: j.repo, n: Number(j.n) })) },
    runner: snapshot && mine ? { mine: mine.get(scope.login!.toLowerCase()) ?? [], ready: runners.readyRunnersOf(snapshot, NONE as never) } : null,
  };
}

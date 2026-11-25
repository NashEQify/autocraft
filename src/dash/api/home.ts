// What the Home page shows about problems: what the pipeline stopped, what is unhealthy and what gave up. The facts come from
// src/data/views; this file words them.
import type { NeedsStoppedRow } from "../../../web/src/api/types.ts";
import { itemPath } from "../../../web/src/lib/links.ts";
import { jevEnabled, jevOutage } from "../../agents/jev.ts";
import { parseTripKey } from "../../core/push-outcome.ts";
import { checksOf } from "../../health-checks.ts";
import { mainCiRepos } from "../../mainci/index.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { loadSteps } from "../../runner/steps.ts";
import * as control from "../../data/control/index.ts";
import type { AttentionFacts } from "../../data/views/types.ts";
import type { Req } from "../types.ts";
import { pipelineSwitch } from "./limits.ts";
import { stepTitle } from "./trace.ts";
import type { HomeProblem } from "./home-types.ts";
import type { Db } from "../../db/index.ts";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The Stopped rows of Home: tripped breakers, steps at a daily limit of 0 and authors held at their limit or by a surge. */
export async function stoppedRows(db: Db, facts: AttentionFacts["stops"], hidden: HiddenRepos, user: Req["user"]): Promise<NeedsStoppedRow[]> {
  const out: NeedsStoppedRow[] = [];
  for (const t of facts.trips) {
    const k = parseTripKey(t.stage);
    if (k && isHiddenRepo(hidden, k.repo)) continue;
    out.push({ id: `breaker:${t.stage}`, kind: "breaker", title: stepTitle(k?.stage ?? t.stage), ...(k ? { repo: k.repo } : {}), reason: control.blankIfHidden(t.reason, hidden), since: t.trippedAt,
      resume: { type: "trip", stage: t.stage, canResume: await control.mayResumeTrip(db, user, t.stage) } });
  }
  const steps = await loadSteps();
  for (const l of facts.zeroLimits)
    out.push({ id: `limit:${l.step}`, kind: "limit", title: steps.get(l.step)?.title ?? l.step, reason: "The daily limit is 0", since: l.updatedAt || null, resume: { type: "link", to: "/pipeline" } });
  for (const g of facts.heldAuthors) {
    const issues = g.count - g.prs;
    const parts = [g.prs && `${g.prs} PR${g.prs === 1 ? "" : "s"}`, issues && `${issues} issue${issues === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    out.push({ id: `outside:${g.author}`, kind: "outside-group", title: g.author, reason: `${parts} waiting for ${g.surge ? "the outside-surge breaker or " : ""}the author's daily limit`, since: g.oldest, count: g.count, resume: { type: "outside", author: g.author } });
  }
  return out;
}

const areaOf = (id: string): "runner" | "deadline" | "liveness" | "workers" | "sync" =>
  id === "runner" ? "runner" : id.startsWith("deadline:") ? "deadline" : id === "liveness" ? "liveness" : id.startsWith("worker:") || id === "build-queue" ? "workers" : "sync";

/**
 * The problems list: the stopped rows first, then the pipeline switch, every health check that is not ok (viewers get the short text and no
 * check of a repo they cannot see), the Jev outage, red main branches of repos whose pipeline is on, failed jobs of the last hour,
 * findings whose fix gave up and CI fixes that gave up.
 */
export async function problems(db: Db, o: { hidden: HiddenRepos; staff: boolean; nowMs: number; stops: NeedsStoppedRow[]; facts: AttentionFacts }): Promise<HomeProblem[]> {
  const { hidden, staff, facts } = o;
  const out: HomeProblem[] = [];
  for (const s of o.stops) out.push({ kind: "stopped", title: s.repo ? `${s.title} in ${s.repo}` : s.title, detail: staff ? s.reason : "", to: "/needs/stopped" });
  const on = new Set([...facts.health.tracked.values()].filter((r) => r.pipeline).map((r) => r.name));
  const [state, outage, ci, checks] = await Promise.all([
    pipelineSwitch(db),
    jevEnabled(db).then(async (enabled) => (enabled ? await jevOutage(db) : null)),
    mainCiRepos(db, hidden),
    checksOf(db, facts.health, { nowMs: o.nowMs, probe: false }),
  ]);
  if (!state.enabled) out.push({ kind: "health", title: `Pipeline is ${state.draining ? "draining" : "off"}${state.changedBy ? `, switched ${state.draining ? "to drain" : "off"} by ${state.changedBy}` : ""}`, detail: "", to: "/pipeline" });
  for (const c of checks) {
    if (c.state === "ok" || (c.repo !== undefined && isHiddenRepo(hidden, c.repo))) continue;
    out.push({ kind: areaOf(c.id) === "deadline" ? "stuck" : "health", title: staff ? c.text : c.brief, detail: "", to: c.to });
  }
  if (outage) out.push({ kind: "health", title: `Jev is unavailable: ${clip(outage.reason, 100)}`, detail: "", to: "/accounts" });
  for (const r of ci.filter((x) => x.state === "red" && on.has(x.repo))) {
    const names = r.failing.map((f) => f.name).slice(0, 2).join(", ");
    out.push({ kind: "health", title: `Main is red in ${r.repo}${names ? `: ${names}` : ""}`, detail: "", to: "/main-ci" });
  }
  const failed = new Map<string, number>();
  for (const j of facts.failedJobs) if (j.repo === null || on.has(j.repo)) failed.set(j.step, (failed.get(j.step) ?? 0) + j.n);
  const byCount = [...failed].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const nFailed = byCount.reduce((a, [, n]) => a + n, 0);
  if (nFailed) {
    const steps = byCount.slice(0, 3).map(([step]) => stepTitle(step)).join(", ");
    out.push({ kind: "health", title: `${nFailed} job${nFailed === 1 ? "" : "s"} failed in the last hour: ${steps}${byCount.length > 3 ? " and more" : ""}`, detail: "", to: "/pipeline" });
  }
  if (staff) {
    for (const f of facts.gaveUp)
      out.push({ kind: "gave-up", title: `${f.repo} finding ${f.number}: fix gave up after ${f.fix_attempts} round${f.fix_attempts === 1 ? "" : "s"}`, detail: f.last_failure ?? "", to: `/security/${f.repo}/${f.number}` });
    for (const r of facts.ciFixFailed)
      out.push({ kind: "gave-up", title: `${r.repo}#${r.number}: CI fix gave up`, detail: r.title ?? "", to: itemPath(r.repo, r.number) });
  }
  return out;
}

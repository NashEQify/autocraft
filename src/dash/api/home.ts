// Home: what needs a person, what is wrong, where items are, and what just got done, in one read.
// Viewers get counts and short texts; the lists of needs name items only for staff.
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import type { NeedsPage, NeedsStoppedRow, Progress } from "../../../web/src/api/types.ts";
import { decisionPath, itemPath } from "../../../web/src/lib/links.ts";
import { optionsOf, type DecisionRow } from "../../decisions.ts";
import type { Req } from "../types.ts";
import { needingSql, withoutHidden } from "./decisions.ts";
import { healthOf } from "./now.ts";
import { needs as needsPage } from "./needs.ts";
import { canSeeInternals } from "./staff.ts";
import { excludeHidden, hiddenRepos } from "./visible.ts";
import { ITEM_PHASES, PHASE_SQL, type Home, type HomeDone, type HomeNeed, type HomeProblem, type ItemPhase, type NeedKind } from "./home-types.ts";
import type { Db } from "../../db/index.ts";

const OLDEST = 5;
const DONE = 10;
const DONE_CHUNK = 40;

type Deps = { progress: (hidden: string[]) => Promise<Progress> };

const itemKindOf = (k: string | undefined): "pr" | "issue" | null => (k === undefined ? null : k === "pr" ? "pr" : "issue");

async function phases(db: Db, hidden: string[]): Promise<Record<ItemPhase, number>> {
  const p: Record<string, string> = {};
  const hide = excludeHidden("i.repo", hidden, p);
  const out = Object.fromEntries(ITEM_PHASES.map((x) => [x, 0])) as Record<ItemPhase, number>;
  for (const r of await db.prepare(`SELECT ${PHASE_SQL} AS phase, COUNT(*) AS n FROM items i LEFT JOIN main.item_plans p ON p.repo = i.repo AND p.number = i.number${hide ? ` WHERE ${hide}` : ""} GROUP BY 1`).all(p) as { phase: ItemPhase; n: number }[])
    if (r.phase in out) out[r.phase] += r.n;
  // Home's Merged and Closed tiles are today's (UTC), not every item ever closed.
  const day = new Date().toISOString().slice(0, 10);
  const t = await db.prepare(`SELECT SUM(i.merged_at >= :day) AS merged, SUM(i.merged_at IS NULL AND i.closed_at >= :day) AS closed FROM items i WHERE (i.merged_at >= :day OR i.closed_at >= :day)${hide ? ` AND ${hide}` : ""}`).get({ ...p, day }) as { merged: number | null; closed: number | null };
  out.Merged = t.merged ?? 0;
  out.Closed = t.closed ?? 0;
  return out;
}

/** `total` is the nav badge's number: decisions, unanswered feedback and stopped items. `oldest` lists decisions and, for staff, high or critical findings still new (not in the total). */
async function needs(db: Db, req: Req, hidden: HiddenRepos, staff: boolean, page: NeedsPage): Promise<Home["needs"]> {
  const params: Record<string, string> = {};
  const hide = withoutHidden(hidden, params);
  const where = `${needingSql(req)}${hide ? ` AND ${hide}` : ""}`;
  const byKind: Partial<Record<NeedKind, number>> = {};
  for (const r of await db.prepare(`SELECT kind, COUNT(*) AS n FROM decisions WHERE ${where} GROUP BY kind`).all(params) as { kind: NeedKind; n: number }[]) byKind[r.kind] = r.n;
  // The Needs page's own counts, so the total is the nav badge's number for this user.
  const { counts } = page;
  const total = counts.decisions + counts.feedback + counts.stopped;
  if (counts.feedback) byKind.feedback = counts.feedback;
  if (counts.stopped) byKind.stopped = counts.stopped;
  if (!staff) return { total, byKind, oldest: [] };

  const oldest = await db.prepare(`SELECT * FROM decisions WHERE ${where} ORDER BY asked_at, id LIMIT ${OLDEST}`).all(params) as DecisionRow[];
  const items = await itemsByRef(db, oldest.flatMap((d) => (d.number !== null && d.repo ? [[d.repo, d.number] as [string, number]] : [])));
  const asked: HomeNeed[] = oldest.map((d) => {
    const it = d.number !== null && d.repo ? items.get(`${d.repo}#${d.number}`) : undefined;
    return {
      id: d.id, kind: d.kind as NeedKind, repo: d.repo ?? "", number: d.number, title: d.number === null ? d.question : (it?.title ?? `${d.repo}#${d.number}`),
      recommendation: optionsOf(d).find((o) => o.key === d.recommended)?.label ?? null, askedAt: d.asked_at, itemKind: itemKindOf(it?.kind),
      to: decisionPath({ id: d.id, repo: d.repo ?? "", number: d.number }),
    };
  });

  const fp: Record<string, string> = {};
  const fhide = excludeHidden("repo", hidden, fp);
  const fwhere = `state = 'new' AND severity IN ('high', 'critical')${fhide ? ` AND ${fhide}` : ""}`;
  const fc = (await db.prepare(`SELECT COUNT(*) AS n FROM security_findings WHERE ${fwhere}`).get(fp) as { n: number }).n;
  const found: HomeNeed[] = (await db.prepare(`SELECT repo, number, title, created_at FROM security_findings WHERE ${fwhere} ORDER BY created_at, number LIMIT ${OLDEST}`).all(fp) as { repo: string; number: number; title: string; created_at: string }[])
    .map((f) => ({ id: `finding:${f.repo}:${f.number}`, kind: "security" as const, repo: f.repo, number: f.number, title: f.title, recommendation: null, askedAt: f.created_at, itemKind: null, to: `/security/${f.repo}/${f.number}` }));
  if (fc) byKind.security = fc;
  return { total, byKind, oldest: [...asked, ...found].sort((a, b) => a.askedAt.localeCompare(b.askedAt)).slice(0, OLDEST) };
}

async function problems(db: Db, hidden: string[], staff: boolean, stops: NeedsStoppedRow[]): Promise<HomeProblem[]> {
  const out: HomeProblem[] = [];
  for (const s of stops) out.push({ kind: "stopped", title: s.title, detail: staff ? s.reason : "", to: "/needs/stopped" });
  const seen = new Set(stops.map((s) => s.id));
  // The health list repeats breakers, limits and paused accounts; those are the stopped rows above.
  for (const p of (await healthOf(db, hidden, staff, Date.now())).problems)
    if (!seen.has(p.id)) out.push({ kind: p.area === "deadline" ? "stuck" : "health", title: p.text, detail: "", to: p.to });
  if (staff) {
    const fp: Record<string, string> = {};
    const fhide = excludeHidden("repo", hidden, fp);
    for (const f of await db.prepare(`SELECT repo, number, fix_attempts, last_failure FROM security_findings WHERE state = 'new' AND last_failure IS NOT NULL${fhide ? ` AND ${fhide}` : ""} ORDER BY updated_at DESC`).all(fp) as { repo: string; number: number; fix_attempts: number; last_failure: string }[])
      out.push({ kind: "gave-up", title: `${f.repo} finding ${f.number}: fix gave up after ${f.fix_attempts} round${f.fix_attempts === 1 ? "" : "s"}`, detail: f.last_failure, to: `/security/${f.repo}/${f.number}` });
    const ip: Record<string, string> = {};
    const ihide = excludeHidden("i.repo", hidden, ip);
    for (const r of await db.prepare(`SELECT p.repo, p.number, i.title FROM item_plans p JOIN items i ON i.repo = p.repo AND i.number = p.number
      WHERE i.state = 'OPEN' AND json_extract(p.view, '$.cifix') = 'cifix-failed'${ihide ? ` AND ${ihide}` : ""} ORDER BY p.planned_at DESC LIMIT 20`).all(ip) as { repo: string; number: number; title: string | null }[])
      out.push({ kind: "gave-up", title: `${r.repo}#${r.number}: CI fix gave up`, detail: r.title ?? "", to: itemPath(r.repo, r.number) });
  }
  return out;
}

/** Title and kind of items by `repo#number`, in one read. */
async function itemsByRef(db: Db, refs: [string, number][]): Promise<Map<string, { title: string | null; kind: string }>> {
  if (!refs.length) return new Map();
  const rows = await db.prepare("SELECT repo, number, title, kind FROM items WHERE (repo, number) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))").all(JSON.stringify(refs)) as { repo: string; number: number; title: string | null; kind: string }[];
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
}

async function done(db: Db, hidden: string[]): Promise<HomeDone[]> {
  const what = { merge: "merged", "act-close": "closed", "review-post": "review posted" } as const;
  const out: HomeDone[] = [];
  // Newest first by time, so the scan stops at the tenth row that belongs to a visible item; items are read for a chunk of rows at a time.
  type Row = { at: string; action: keyof typeof what; repo: string; number: number };
  let chunk: Row[] = [];
  const flush = async (): Promise<boolean> => {
    const items = await itemsByRef(db, chunk.map((r) => [r.repo, r.number]));
    for (const r of chunk) {
      const it = items.get(`${r.repo}#${r.number}`);
      if (!it) continue;
      out.push({ at: r.at, what: what[r.action], repo: r.repo, number: r.number, title: it.title ?? "", kind: it.kind === "pr" ? "pr" : "issue" });
      if (out.length === DONE) return true;
    }
    chunk = [];
    return false;
  };
  for await (const a of db.prepare(`SELECT at, action, target FROM audit WHERE action IN ('merge', 'act-close', 'review-post') AND json_extract(details, '$.state') = 'done' ORDER BY at DESC`).iterate() as AsyncIterable<{ at: string; action: keyof typeof what; target: string | null }>) {
    const m = /^(.+)#(\d+)$/.exec(a.target ?? "");
    if (!m || isHiddenRepo(hidden, m[1]!)) continue;
    chunk.push({ at: a.at, action: a.action, repo: m[1]!, number: Number(m[2]) });
    if (chunk.length === DONE_CHUNK && await flush()) return out;
  }
  await flush();
  return out;
}

async function running(db: Db, hidden: string[]): Promise<string> {
  const p: Record<string, string> = {};
  const hide = excludeHidden("repo", hidden, p);
  const jobs = (await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'running'${hide ? ` AND (repo IS NULL OR ${hide})` : ""}`).get(p) as { n: number }).n;
  const bp: Record<string, string> = {};
  const bhide = excludeHidden("repo", hidden, bp);
  const batches = (await db.prepare(`SELECT id FROM merge_batches WHERE state = 'checking'${bhide ? ` AND ${bhide}` : ""} ORDER BY id`).all(bp) as { id: number }[]).map((b) => `#${b.id}`);
  const parts = [jobs ? `${jobs} job${jobs === 1 ? "" : "s"} running` : "", batches.length ? `batch${batches.length === 1 ? "" : "es"} ${batches.join(", ")} checking` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing running";
}

async function spendToday(db: Db, hidden: string[]): Promise<number> {
  const p: Record<string, string> = { day: new Date().toISOString().slice(0, 10) };
  const hide = excludeHidden("repo", hidden, p);
  return (await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM token_usage WHERE substr(COALESCE(ended_at, started_at), 1, 10) = :day${hide ? ` AND (repo IS NULL OR ${hide})` : ""}`).get(p) as { s: number }).s;
}

/** Share of the PRs merged since `since` that AutoCraft merged itself or carried in a merged batch. */
async function byAutoCraftPct(db: Db, hidden: string[], since: string): Promise<number> {
  const p: Record<string, string> = { since };
  const hide = excludeHidden("i.repo", hidden, p);
  const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(EXISTS (SELECT 1 FROM main.merges m WHERE m.repo = i.repo AND m.number = i.number AND m.outcome = 'merged')) AS ours
    FROM items i WHERE i.kind = 'pr' AND i.merged_at >= :since${hide ? ` AND ${hide}` : ""}`).get(p) as { n: number; ours: number | null };
  return r.n ? Math.round(((r.ours ?? 0) / r.n) * 100) : 0;
}

/** With a project scope (`req.scope`), every part is that repo's only, as if it were the only one the requester could see. */
export async function home(db: Db, req: Req, deps: Deps): Promise<Home> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const pg = await deps.progress(hidden);
  const start = pg.repos.reduce((s, r) => s + (r.openTrend[0] ?? 0), 0);
  // The Needs page's stopped rows are the problems list's first rows.
  const page = await needsPage(db, req);
  return {
    needs: await needs(db, req, hidden, staff, page),
    problems: await problems(db, hidden, staff, page.stopped),
    phases: await phases(db, hidden),
    running: await running(db, hidden),
    progress: { openNow: pg.funnel.open, openAtStart: start, done24h: pg.perHour.reduce((a, b) => a + b, 0), byAutoCraftPct: await byAutoCraftPct(db, hidden, pg.trackingSince), perHour: pg.perHour, spendTodayUsd: await spendToday(db, hidden) },
    done: await done(db, hidden),
  };
}

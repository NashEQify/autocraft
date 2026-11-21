// The activity stream: the item trace's event rows for all items together, newest first. Each source reads only its newest
// rows by time through an index (never every event of every item), the sources are merged and cut to the page, and the
// cursor is time + id. The row to event mapping is the item trace's (trace.ts).
import { createHash } from "node:crypto";
import { privateStepExpr } from "../../build/tasks.ts";
import type { ActivityEvent, ActivityItem, ActivityPage, TraceKind } from "../../../web/src/api/types.ts";
import { getDecision, reposOf } from "../../decisions.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { quietFixPrs } from "../../security/quiet.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import {
  KINDS, actionEvent, activityEvent, writeActions, writeEvent, checkEvent, ciFixEvent, closedEvent, commentEvent, conflictEvent, decisionEvents, feedbackEvent, fixupEvent, hiddenExpr,
  iso, jobEvent, mergeEvent, mergedEvent, openedEvent, opusEvent, patchCheckEvent, planEventFor, postmergeEvent, premergeEvent, pushEvent, runColumnsExpr, runEvent, stageEvent,
  taskEvent, turnEvent, verifyEvent, plainSummary, veilEvent, VEILED_KINDS, type Ev, type ItemRow,
} from "./trace.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, needVisible, visibleRepos } from "./visible.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { allOwnLogins } from "../../github/identity.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import type { DB } from "../../db/types.ts";
import type { Expression, ExpressionBuilder, SelectQueryBuilder, SqlBool } from "kysely";

export const ACTIVITY_PAGE_DEFAULT = 50, ACTIVITY_PAGE_MAX = 200;
/** Plan changes and stages come from every planner pass of every item and would bury the rest, so they show only when asked for. */
export const ACTIVITY_DEFAULT_KINDS: TraceKind[] = KINDS.filter((k) => k !== "plan");
/** Sorts after every event id of the same time. */
const LAST = "~";

export type Ctx = { db: Db; own: Set<string>; staff: boolean; operator: boolean; hidden: HiddenRepos; visible: string[]; only: boolean; repo: string | null; limit: number; before: { at: string; id: string } | null };
type At = { repo: string; number: number };
type Pulled = { events: (Ev & At)[]; /** Oldest time read when the source had more rows than it returned; null when it returned everything. */ floor: string | null };
export type Source = { kinds: TraceKind[]; table: keyof DB & string; time: string; pull: (c: Ctx) => Promise<Pulled> };

/** A condition on the rows of a source: `only` narrows a source to AutoCraft's rows with one. */
type Cond = (eb: kx.Eb) => Expression<SqlBool>;
/** Always true: every row of the source is AutoCraft's. */
const EVERY: Cond = (eb) => eb.and([]);

/** Newest `limit` rows of one table at or before the cursor's second (the stored times mix second and millisecond precision), each mapped to events. */
async function newest<R extends object>(c: Ctx, o: { q: SelectQueryBuilder<any, any, R>; time: string; repoCol?: string | null; /** Breaks a tie of `time`, newest first. */ tie?: () => kx.Ex; /** With Only AutoCraft: null skips the source (its events are people's), a condition narrows it to AutoCraft's rows, EVERY means every row is AutoCraft's. */ only?: (c: Ctx) => Cond | null; of?: (r: R) => At | null; map: (r: R) => (Ev | null)[]; keep?: (r: R) => Promise<boolean>; one?: (r: R) => string }): Promise<Pulled> {
  // Only visible (tracked, readable) repos are read. The function around the column keeps the planner on the time index instead of a repo index plus a sort. No `repoCol`: the repo is not a column (audit targets), so `of` filters it.
  const repoCol = o.repoCol === undefined ? "repo" : o.repoCol;
  const own = c.only ? o.only?.(c) : undefined;
  if (own === null) return { events: [], floor: null };
  const before = c.before ? `${c.before.at.slice(0, 19)}Z` : null;
  const raw = await c.db.all(o.q.select((eb) => eb.ref(o.time).as(T)).where(o.time, "is not", null)
    .$if(!!own, (q) => q.where(own!))
    .$if(before !== null, (q) => q.where(o.time, "<=", before))
    .$if(!!(repoCol && c.repo), (q) => q.where(repoCol!, "=", c.repo!))
    .$if(!!repoCol, (q) => q.where((eb) => kx.inList(c.db, eb.fn.coalesce(repoCol!, repoCol!), c.visible)))
    .orderBy(o.time, "desc").$if(o.tie !== undefined, (q) => q.orderBy(o.tie!(), "desc")).limit(c.limit));
  const seen = new Set<string>();
  const events: (Ev & At)[] = [];
  for (const r of raw) {
    if (o.keep && !await o.keep(r)) continue;
    if (o.one) { const k = o.one(r); if (seen.has(k)) continue; seen.add(k); }
    const at = o.of ? o.of(r) : (r as unknown as At);
    if (at) for (const e of o.map(r)) if (e) events.push({ ...e, repo: at.repo, number: at.number });
  }
  const floor = raw.length >= c.limit ? iso(raw[raw.length - 1]![T]) : null;
  return { events, floor };
}

const T = "t";
const item = (time: "created_at" | "merged_at" | "closed_at", where: (eb: ExpressionBuilder<DB, "items">) => Expression<SqlBool>, map: (r: ItemRow & At) => Ev): Source => ({
  kinds: ["github"], table: "items", time,
  pull: async (c) => await newest(c, {
    q: c.db.k.selectFrom("items").select(["repo", "number", "kind", "author", "created_at", "closed_at", "merged_at", "merged_by", "head_oid"]).where(where),
    time, only: () => null, map: (r) => [map(r)],
  }),
});
/** A source whose rows carry `repo` and `number` and map to one event each. */
const plain = <R extends object>(kind: TraceKind, table: Source["table"], time: string, q: (db: Db) => SelectQueryBuilder<any, any, R>, map: (r: R, c: Ctx) => Ev, o: { repoCol?: string; tie?: () => kx.Ex; one?: (r: R) => string; only?: (c: Ctx) => Cond | null } = {}): Source => ({
  kinds: [kind], table, time,
  pull: async (c) => await newest<R>(c, { q: q(c.db), time, repoCol: o.repoCol, tie: o.tie, one: o.one, only: o.only, map: (r) => [map(r, c)] }),
});
/** Rows of the authors' column that are among the logins AutoCraft posts as, none when it has no login. */
const byOwn = (col: string): (c: Ctx) => Cond | null => (c) => (c.own.size ? (eb) => kx.inList(c.db, col, [...c.own]) : null);

/** Decisions that name an item and do not touch a repo hidden from the viewer. */
const decisionVisible = async (c: Ctx, id: string): Promise<boolean> => {
  const d = await getDecision(c.db, id);
  return !d || !reposOf(d).some((r) => isHiddenRepo(c.hidden, r));
};
const DECISION_COLS = ["d.id", "d.repo", "d.number", "d.kind", "d.question", "d.asked_at", "d.asked_by", "d.answer", "d.answered_at", "d.answered_by", "d.answer_note"] as const;
/** A decision row's item: a decision of the stream always has both. */
const decisionAt = (r: { repo: string | null; number: number }): At | null => (r.repo === null ? null : { repo: r.repo, number: r.number });

export const SOURCES: Source[] = [
  item("created_at", (eb) => eb("kind", "is not", null), openedEvent),
  item("merged_at", (eb) => eb("merged_at", "is not", null), mergedEvent),
  item("closed_at", (eb) => eb.and([eb("closed_at", "is not", null), eb("merged_at", "is", null)]), closedEvent),
  plain("github", "comments", "created_at", (db) => db.k.selectFrom("comments").select((eb) => ["repo", "number", "id", "kind", "author", "created_at", "review_state", "commit_oid", eb.fn<number>("length", [eb.fn.coalesce("body", eb.val(""))]).as("len")])
    .$narrowType<{ created_at: string }>(), (r, c) => commentEvent(r, c.own), { only: byOwn("author") }),
  plain("github", "item_activity", "at", (db) => db.k.selectFrom("item_activity").select(["repo", "number", "id", "kind", "at", "actor", "label", "after_oid", "before_oid"]), (r, c) => activityEvent(r, c.own), { only: byOwn("actor") }),
  plain("plan", "stages", "at", (db) => db.k.selectFrom("stages").select(["repo", "number", kx.rowid("stages").as("rowid"), "stage", "at", "actor", "note"]), stageEvent),
  plain("plan", "plan_history", "at", (db) => db.k.selectFrom("plan_history").select(["repo", "number", "id", "head", "old_state", "new_state", "wait", "reasons", "at"]), (r, c) => planEventFor(c, r)),
  // A job over many items is one row of the stream, at its newest item.
  plain("job", "job_items", "ji.at", (db) => db.k.selectFrom("job_items as ji").leftJoin("jobs as j", "j.id", "ji.job_id")
    .select(["ji.repo as repo", "ji.number as number", "ji.id", "ji.job_id", "ji.outcome", "ji.at", "j.step", "j.state", "j.error"]), jobEvent, { repoCol: "ji.repo", tie: () => kx.rowid("job_items", "ji"), one: (r) => String(r.job_id) }),
  // A run over many items is one row too: its first item. Runs that touched a hidden repo are left out whole.
  {
    kinds: ["model-call"], table: "agent_runs", time: "started_at",
    pull: async (c) => {
      const firstItem = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom("agent_run_items as x").where("x.run_id", "=", eb.ref("r.id")).orderBy("x.repo").orderBy("x.number").limit(1);
      return await newest(c, {
        q: c.db.k.selectFrom("agent_runs as r")
          .innerJoin("agent_run_items as i", (j) => j.onRef("i.run_id", "=", "r.id").on((eb) => eb.and([eb("i.repo", "=", firstItem(eb).select("x.repo")), eb("i.number", "=", firstItem(eb).select("x.number"))])))
          .leftJoin("claude_accounts as a", "a.id", "r.account_id")
          .select((eb) => [...runColumnsExpr(c.db, eb), "i.repo as repo", "i.number as number"])
          .where((eb) => hiddenExpr(c.db, eb, c.hidden) ?? eb.and([])),
        time: "r.started_at", repoCol: "i.repo", map: (r) => [runEvent(r, c.staff)],
      });
    },
  },
  plain("check", "model_checks", "started_at", (db) => db.k.selectFrom("model_checks").select(["repo", "number", "id", "run_id", "step", "head", "command", "crate", "test_name", "task_id", "outcome", "started_at"]), checkEvent),
  plain("check", "build_tasks", "queued_at", (db) => db.k.selectFrom("build_tasks").select(["repo", "number", "id", "job_id", "step", "head_sha", "state", "summary", "queued_at"]).where((eb) => eb.not(privateStepExpr(eb))), taskEvent),
  plain("check", "push_outcomes", "at", (db) => db.k.selectFrom("push_outcomes").select(["repo", "number", "id", "at", "stage", "action", "to_oid", "before_res", "after_res", "outcome"]), pushEvent),
  plain("check", "patch_checks", "created_at", (db) => db.k.selectFrom("patch_checks").select(["repo", "number", "id", "kind", "subject", "round", "verdict", "model", "reasons", "created_at"]), patchCheckEvent),
  plain("review", "opus_review_history", "at", (db) => db.k.selectFrom("opus_review_history").select(["repo", "number", kx.rowid("opus_review_history").as("rowid"), "head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "claims"]), (r) => opusEvent(r, `opus:${r.rowid}`)),
  plain("review", "premerge_reviews", "at", (db) => db.k.selectFrom("premerge_reviews").select(["repo", "number", "head_oid", "at", "model", "findings", "error", "searched"]), premergeEvent),
  plain("review", "postmerge_reviews", "at", (db) => db.k.selectFrom("postmerge_reviews").select(["repo", "number", "merge_sha", "at", "model", "findings", "error"]), (r, c) => postmergeEvent(r, c.staff)),
  plain("review", "verifications", "created_at", (db) => db.k.selectFrom("verifications").select(["repo", "number", "head_sha", "kind", "state", "reason", "summary", "note", "created_at", "head_task_id"]), verifyEvent),
  {
    kinds: ["decision"], table: "decisions", time: "asked_at",
    pull: async (c) => await newest(c, {
      q: c.db.k.selectFrom("decisions as d").select(DECISION_COLS).where("d.number", "is not", null).$narrowType<{ number: number }>(),
      time: "d.asked_at", repoCol: "d.repo", of: decisionAt, keep: async (r) => await decisionVisible(c, r.id), map: (r) => [decisionEvents(r)[0]!],
    }),
  },
  {
    kinds: ["decision"], table: "decisions", time: "answered_at",
    pull: async (c) => await newest(c, {
      q: c.db.k.selectFrom("decisions as d").select(DECISION_COLS).where("d.number", "is not", null).$narrowType<{ number: number }>(),
      time: "d.answered_at", repoCol: "d.repo", of: decisionAt, only: () => null, keep: async (r) => await decisionVisible(c, r.id), map: (r) => [decisionEvents(r)[1] ?? null],
    }),
  },
  {
    kinds: ["decision"], table: "decision_comments", time: "at",
    pull: async (c) => await newest(c, {
      q: c.db.k.selectFrom("decision_comments as x").innerJoin("decisions as d", "d.id", "x.decision_id")
        .select((eb) => ["d.repo as repo", "d.number as number", "x.decision_id", "x.id as cid", "x.login", "x.at", eb.fn<number>("length", ["x.body"]).as("len")])
        .where("d.number", "is not", null).$narrowType<{ number: number }>(),
      time: "x.at", repoCol: "d.repo", of: decisionAt,
      only: () => null, keep: async (r) => await decisionVisible(c, r.decision_id), map: (r) => [feedbackEvent(r.decision_id, { id: r.cid, login: r.login, at: r.at, len: r.len })],
    }),
  },
  plain("step", "fixups", "created_at", (db) => db.k.selectFrom("fixups").select(["repo", "number", kx.rowid("fixups").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]), fixupEvent),
  plain("step", "ci_fixes", "created_at", (db) => db.k.selectFrom("ci_fixes").select(["repo", "number", kx.rowid("ci_fixes").as("rowid"), "head", "to_head", "kind", "state", "reason", "files", "attempt", "task_id", "created_at"]), ciFixEvent),
  plain("step", "conflict_merges", "created_at", (db) => db.k.selectFrom("conflict_merges").select(["repo", "number", kx.rowid("conflict_merges").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]), conflictEvent),
  plain("step", "merges", "at", (db) => db.k.selectFrom("merges").select(["repo", "number", kx.rowid("merges").as("rowid"), "head_oid", "at", "path", "method", "outcome", "reason"]), mergeEvent),
  plain("step", "actions", "created_at", (db) => db.k.selectFrom("actions").select(["repo", "number", "id", "decision_id", "kind", "state", "reason", "created_at"]), actionEvent),
  plain("conversation", "conversation_turns", "at", (db) => db.k.selectFrom("conversation_turns").select((eb) => ["repo", "number", "id", "kind", "login", "at", eb.fn<number>("length", ["body"]).as("len"), "status"]), turnEvent,
    { only: () => (eb) => eb("kind", "in", ["opus", "system"]) }),
  // Audit rows name their item in `target` (`repo#number`); other targets are not items.
  {
    kinds: ["write"], table: "audit", time: "at",
    async pull(c) {
      const allowed = writeActions(c.staff, c.operator);
      return await newest(c, {
        q: c.db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "login", "action", "details", "target"])
          .where((eb) => eb(eb.fn<number>("instr", ["target", eb.val("#")]), ">", eb.lit(0))).$narrowType<{ target: string }>()
          .$if(!!allowed, (q) => q.where(kx.inList(c.db, "action", allowed!)))
          .$if(!!c.repo, (q) => q.where((eb) => eb(eb.fn<string>("substr", ["target", eb.lit(1), eb.lit(c.repo!.length + 1)]), "=", `${c.repo}#`))),
        time: "at", repoCol: null,
        // A write is AutoCraft's when the viewer is not staff (the actor is hidden) or the pipeline recorded a state with it (writeEvent).
        only: () => (c.staff
          ? (eb) => eb.and([eb(eb.case().when(kx.jsonValid(c.db, "details")).then(kx.jsonType(c.db, "details", "$.state")).end(), "=", "text"), kx.inList(c.db, "action", Object.keys(GITHUB_ACTIONS))])
          : EVERY),
        of: (r) => {
          const i = r.target.lastIndexOf("#"), n = Number(r.target.slice(i + 1)), repo = r.target.slice(0, i);
          return Number.isInteger(n) && repo && c.visible.includes(repo) ? { repo, number: n } : null;
        },
        map: (r) => [writeEvent(r, c.staff)],
      });
    },
  },
];

const after = (a: Ev, b: { at: string; id: string }): boolean => a.at < b.at || (a.at === b.at && a.id < b.id);

/** One round: every wanted source's newest rows before the cursor, merged. Events older than the oldest row of a source that hit its limit may be missing others of that source, so they wait for the next round. */
async function round(c: Ctx, sources: Source[]): Promise<{ events: (Ev & At)[]; bound: string | null }> {
  const events: (Ev & At)[] = [];
  let bound: string | null = null;
  for (const s of sources) {
    const p = await s.pull(c);
    if (p.floor && (!bound || p.floor > bound)) bound = p.floor;
    for (const e of p.events) {
      const at = iso(e.at);
      if (at) events.push({ ...e, at });
    }
  }
  const kept = events.filter((e) => (!bound || e.at >= bound) && (!c.before || after(e, c.before)));
  return { events: kept.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)), bound };
}

type Query = { kinds: Set<TraceKind>; only: boolean; repo: string | null; limit: number; cursor: { at: string; id: string } | null };

async function page(base: Omit<Ctx, "before" | "limit" | "only">, sources: Source[], q: Query): Promise<{ events: (Ev & At)[]; next: { at: string; id: string } | null }> {
  const out: (Ev & At)[] = [];
  const ids = new Set<string>();
  let before = q.cursor;
  let exhausted = false;
  // The autocraft filter drops rows after the read, so a round can come back short: read on, a few rounds at most.
  for (let i = 0; i < 6 && !exhausted && out.length <= q.limit; i++) {
    const { events, bound } = await round({ ...base, limit: q.limit, only: q.only, before }, sources);
    for (const e of events) {
      const key = `${e.repo}#${e.number}|${e.id}`;
      if (ids.has(key) || (q.only && e.actor.type === "person")) continue;
      ids.add(key);
      out.push(e);
    }
    if (!bound) exhausted = true;
    // The next round starts at the oldest time that was fully read; when a whole round sat in one second, step past it.
    else before = { at: before && bound >= before.at ? new Date(Date.parse(before.at) - 1).toISOString() : bound, id: LAST };
  }
  const events = out.slice(0, q.limit);
  return { events, next: out.length > q.limit ? tail(events, q.limit) : exhausted ? null : before };
}
const tail = (events: Ev[], limit: number): { at: string; id: string } | null => {
  const last = events[limit - 1];
  return last ? { at: last.at, id: last.id } : null;
};

/** The newest time and the running counts per wanted source: equal stamps mean a poll has nothing new for the top of the stream. */
async function stampOf(db: Db, sources: Source[], key: unknown[]): Promise<string> {
  const parts: unknown[] = [key];
  for (const s of sources) parts.push((await db.get(db.k.selectFrom(s.table).select((eb) => eb.fn.max<string | null>(kx.ref(s.time.replace(/^\w+\./, ""))).as("m"))))!.m);
  parts.push(Object.values((await db.get(db.k.selectFrom("agent_runs").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "running")))!));
  parts.push(Object.values((await db.get(db.k.selectFrom("jobs").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest")]).where("state", "in", ["queued", "running"])))!));
  parts.push(Object.values((await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", ["queued", "claimed", "running"])))!));
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

const itemsOf = async (db: Db, events: (Ev & At)[]): Promise<Map<string, ActivityItem>> => {
  const out = new Map<string, ActivityItem>();
  for (const e of events) {
    const k = `${e.repo}#${e.number}`;
    if (out.has(k)) continue;
    const r = await db.get(db.k.selectFrom("items").select(["kind", "state", "title"]).where("repo", "=", e.repo).where("number", "=", e.number));
    out.set(k, { repo: e.repo, number: e.number, kind: r?.kind === "pr" || r?.kind === "issue" ? r.kind : null, state: r?.state ? (r.state.toLowerCase() as ActivityItem["state"]) : null, title: r?.title ?? null });
  }
  return out;
};

export async function activity(db: Db, req: Req): Promise<ActivityPage | { unchanged: true; stamp: string }> {
  const q = (k: string) => req.query.get(k) || undefined;
  const limitRaw = q("limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? ACTIVITY_PAGE_DEFAULT), 1), ACTIVITY_PAGE_MAX);
  const kq = q("kinds");
  let kinds = new Set(ACTIVITY_DEFAULT_KINDS);
  if (kq) {
    const list = kq.split(",");
    if (list.some((k) => !KINDS.includes(k as TraceKind))) throw new HttpError(400, `kinds are ${KINDS.join(", ")}`);
    kinds = new Set(list as TraceKind[]);
  }
  const only = q("autocraftOnly") === "1" || q("autocraftOnly") === "true";
  const repo = q("repo") ?? null;
  if (repo) await needVisible(db, req, repo);
  const cq = q("cursor");
  let cursor: { at: string; id: string } | null = null;
  if (cq) {
    const i = cq.indexOf("|");
    const at = i < 1 ? null : iso(cq.slice(0, i));
    if (!at) throw new HttpError(400, "bad cursor");
    cursor = { at, id: cq.slice(i + 1) };
  }
  const base = {
    db, staff: canSeeInternals(req), operator: req.user.role === "operator", hidden: await hiddenRepos(db, req), visible: await visibleRepos(db, req), repo,
    own: await allOwnLogins(db),
  };
  const sources = SOURCES.filter((s) => s.kinds.some((k) => kinds.has(k)));
  const stamp = await stampOf(db, sources, [[...kinds].sort(), only, repo, limit, base.staff, base.operator, base.visible]);
  // `since` applies to the first page; a later page is always read.
  if (!cursor && q("since") === stamp) return { unchanged: true, stamp };
  const { events, next } = await page(base, sources, { kinds, only, repo, limit, cursor });
  const info = await itemsOf(db, events);
  // Viewers get no model or failure text: quiet pull requests lose the model-written kinds, every summary is cut to its plain part.
  const quiet = base.staff ? new Set<string>() : await quietFixPrs(db);
  const shown: typeof events = base.staff ? events : events.flatMap((e) => {
    const q = quiet.has(`${e.repo}#${e.number}`);
    if (q && VEILED_KINDS.includes(e.kind)) return [];
    const v = q ? veilEvent(e) : e;
    return [{ ...v, repo: e.repo, number: e.number, summary: plainSummary(v) }];
  });
  const out: ActivityEvent[] = shown.map(({ detail: _d, repo: r, number: n, ...e }) => ({ ...e, item: info.get(`${r}#${n}`)! }));
  return { events: out, nextCursor: next ? `${next.at}|${next.id}` : null, stamp };
}

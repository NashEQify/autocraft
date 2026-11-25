// `item_workflows` and `workflow_events` (M10 workflow-a).
// reads: implement.implementations, mirror.items (through mirror.openItem), access (canActExpr, writeCheckedAt), changes (operatorFixEnded)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { canActExpr, writeCheckedAt } from "../access/fragments.ts";
import { HOLD_MAX } from "../access/permissions.ts";
import { operatorFixEnded } from "../changes/fragments.ts";
import { openItem } from "../mirror/fragments.ts";
import { attemptOf, LIVE_STATES, notArchived, workScore } from "./fragments.ts";
import type {
  Blocker, EndedWorkflow, Entry, FixupRequest, ItemKind, ItemWorkflow, NewWorkflow, OperatorWork, PlanPart, Preapproval, PrWorkflows, QueuePosition, Recommendation, RefKey, StartedFilter,
  SaidEvent, StartedWork, StoredEvent, Surface, WorkflowEvent, WorkflowEventKind, WorkflowFact, WorkflowFilter, WorkflowPassFacts, WorkflowPatch, WorkflowState,
} from "./types.ts";
import type { Parsed } from "../../workflow/types.ts";

const ACTIVE_LEGS = ["fixup", "review", "ci", "queued"];
/** Attempt states that no longer work a PR (src/remote/started.ts ENDED_ATTEMPTS). */
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];
const GO_ON_EVENTS = ["started", "answered"];

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const isEmpty = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
const flag = (v: unknown): boolean => v === true || Number(v) === 1;
const pairs = (refs: { repo: string; number: number }[]) => refs.map((r) => [r.repo, r.number] as const);

export type WorkflowRow = {
  id: number; repo: string; number: number; kind: string; entry: string; weight: number; state: string; started_by: string; started_at: string; started_via: string;
  base_head: string | null; approved_by: string | null; approved_at: string | null; approved_via: string | null; stopped_by: string | null; stopped_at: string | null;
  blocker: string | null; blocker_params: string | null; rec: string | null; rec_at: string | null; rec_head: string | null; plan: string; legacy_preapproval_id: number | null;
  updated_at: string; step: string | null;
};

/** An `item_workflows` row as the domain type (the module's one mapper). */
export function workflowOf(r: WorkflowRow): ItemWorkflow {
  return {
    id: Number(r.id), repo: r.repo, number: Number(r.number), kind: r.kind as ItemKind, entry: r.entry as Entry, weight: Number(r.weight), state: r.state as WorkflowState,
    startedBy: r.started_by, startedAt: r.started_at, startedVia: r.started_via as Surface, baseHead: r.base_head,
    approvedBy: r.approved_by, approvedAt: r.approved_at, approvedVia: r.approved_via as Surface | null,
    stoppedBy: r.stopped_by, stoppedAt: r.stopped_at,
    blocker: r.blocker as Blocker | null, blockerParams: parse<Record<string, unknown> | null>(r.blocker_params, null),
    rec: parse<Recommendation | null>(r.rec, null), recAt: r.rec_at, recHead: r.rec_head,
    plan: parse<PlanPart[]>(r.plan, []), step: r.step, legacyPreapprovalId: r.legacy_preapproval_id === null ? null : Number(r.legacy_preapproval_id), updatedAt: r.updated_at,
  };
}

const factOf = (w: ItemWorkflow, own: boolean): WorkflowFact => ({
  id: w.id, entry: w.entry, approved: w.approvedBy !== null, approvedBy: w.approvedBy, startedBy: w.startedBy, startedAt: w.startedAt, weight: w.weight, state: w.state, own,
});

/** Case-insensitive `col IN logins` with a statement text that does not depend on the list. */
const loginIn = (db: Db, eb: kx.AnyEb, col: string, logins: string[], alias: string) =>
  eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, kx.json(logins), alias)).select(one(eb)).where(kx.ciEq(db, col, `${alias}.value`)));

type EndedRow = { repo: string; number: number | string; state: string };

/** The newest workflow of each item of `keys`, or of the issue a PR of `keys` was opened for, whichever is newer, when it has ended. */
const endedQuery = (db: Db, keys: KeySource) => {
  const k = queryDb(db).k as any;
  const on = (alias: string, repo: string, number: string) => (j: any) => j.onRef(`${alias}.repo`, "=", repo).onRef(`${alias}.number`, "=", number);
  const own = k.selectFrom("main.item_workflows as w").innerJoin(resolveKeys(db, keys, "ke"), on("ke", "w.repo", "w.number")).select(["w.repo as repo", "w.number as number", "w.state as state", "w.id as id"]);
  const ofPr = k.selectFrom("main.implementations as i").innerJoin(resolveKeys(db, keys, "kf"), on("kf", "i.repo", "i.pr_number"))
    .innerJoin("main.item_workflows as w", on("w", "i.repo", "i.number")).where("w.entry", "=", "implement")
    .select(["i.repo as repo", "i.pr_number as number", "w.state as state", "w.id as id"]);
  const ranked = k.selectFrom(own.union(ofPr).as("u"))
    .select((e: any) => ["u.repo", "u.number", "u.state", e.fn.agg("row_number").over((o: any) => o.partitionBy(["u.repo", "u.number"]).orderBy("u.id", "desc")).as("rn")]);
  return k.selectFrom(ranked.as("x")).select(["x.repo", "x.number", "x.state"]).where("x.rn", "=", 1).where("x.state", "not in", LIVE_STATES).orderBy("x.repo").orderBy("x.number");
};
const endedOf = (rows: EndedRow[]): Map<RefKey, EndedWorkflow> => new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), r.state as EndedWorkflow]));

/** How the newest workflow of each item, or of the issue a PR was opened for, ended; items whose newest is live, or that have none, are left out. One statement. */
export async function loadEndedWorkflows(db: Db, keys: KeySource): Promise<Map<RefKey, EndedWorkflow>> {
  if (isEmpty(keys)) return new Map();
  return endedOf(await queryDb(db).all(endedQuery(db, keys)) as EndedRow[]);
}

/**
 * The planner pass's set loader: live workflows with their implementation PR, latest ended state per item (a PR's own or its issue's), merge holds, queued requests and
 * active legs; five statements in one wave. A request counts only while its maker may still act on the repo (`access.canActExpr`, a
 * write permission GitHub confirmed within `HOLD_MAX` of `nowMs`) and while no final fix-up row of it exists.
 */
export async function loadWorkflowFacts(db: Db, keys: KeySource, o: { nowMs?: number } = {}): Promise<WorkflowPassFacts> {
  const out: WorkflowPassFacts = { live: new Map(), ofPr: new Map(), ended: new Map(), holds: new Set(), operator: new Map() };
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const after = new Date((o.nowMs ?? Date.now()) - HOLD_MAX).toISOString();
  const keyed = (alias: string, a: string, b: string) => (eb: any) => eb.exists(k.selectFrom(resolveKeys(db, keys, alias)).select(one(eb)).whereRef(`${alias}.repo`, "=", a).whereRef(`${alias}.number`, "=", b));

  const liveQ = k.selectFrom("main.item_workflows as w")
    .leftJoin("main.implementations as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number").on("w.entry", "=", "implement").on("i.pr_number", "is not", null).on((eb: any) => attemptOf(eb, "i", "w")))
    .selectAll("w")
    .select((eb: any) => [
      "i.pr_number as pr",
      eb.case().when(keyed("ko", "w.repo", "w.number")(eb)).then(1).else(0).end().as("own"),
      eb.case().when(eb.and([eb("i.pr_number", "is not", null), keyed("kp", "w.repo", "i.pr_number")(eb)])).then(1).else(0).end().as("pr_hit"),
    ])
    .where("w.state", "in", LIVE_STATES)
    .where((eb: any) => eb.or([keyed("ko2", "w.repo", "w.number")(eb), eb.and([eb("i.pr_number", "is not", null), keyed("kp2", "w.repo", "i.pr_number")(eb)])]))
    .orderBy("w.id");

  const endedQ = endedQuery(db, keys);

  const holdsQ = k.selectFrom("main.merge_holds as h").innerJoin(resolveKeys(db, keys, "kh"), (j: any) => j.onRef("kh.repo", "=", "h.repo").onRef("kh.number", "=", "h.number")).select(["h.repo", "h.number"]);

  const requestsQ = k.selectFrom("main.operator_fixups as o").innerJoin(resolveKeys(db, keys, "kr"), (j: any) => j.onRef("kr.repo", "=", "o.repo").onRef("kr.number", "=", "o.number"))
    .selectAll("o").select((eb: any) => writeCheckedAt(db, eb, "o.by", "o.repo").as("maker_checked_at")).where("o.state", "=", "queued")
    .where((eb: any) => canActExpr(db, eb, "o.by", "o.repo", after))
    .where((eb: any) => eb.not(operatorFixEnded(eb, "o.id")))
    .orderBy("o.repo").orderBy("o.number").orderBy("o.from_head").orderBy("o.id");

  const legsQ = k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, keys, "kl"), (j: any) => j.onRef("kl.repo", "=", "p.repo").onRef("kl.number", "=", "p.number"))
    .selectAll("p").where("p.state", "in", ACTIVE_LEGS).orderBy("p.id");

  const [live, ended, holds, requests, legs] = await db.together(() => Promise.all([q.all(liveQ), q.all(endedQ), q.all(holdsQ), q.all(requestsQ), q.all(legsQ)])) as
    [(WorkflowRow & { pr: number | null; own: unknown; pr_hit: unknown })[], { repo: string; number: number; state: string }[], { repo: string; number: number }[], OperatorWork["requests"], Preapproval[]];

  for (const r of live) {
    const w = workflowOf(r);
    if (flag(r.own)) out.live.set(refKey(w.repo, w.number), factOf(w, true));
    if (flag(r.pr_hit) && w.entry === "implement" && r.pr !== null) out.ofPr.set(refKey(w.repo, Number(r.pr)), factOf(w, false));
  }
  for (const [key, state] of endedOf(ended)) out.ended.set(key, state);
  for (const r of holds) out.holds.add(refKey(r.repo, Number(r.number)));
  const work = (repo: string, number: number): OperatorWork => {
    const key = refKey(repo, Number(number));
    let w = out.operator.get(key);
    if (!w) out.operator.set(key, (w = { requests: [], legs: [] }));
    return w;
  };
  for (const r of requests) work(r.repo, r.number).requests.push(r);
  for (const p of legs) work(p.repo, p.number).legs.push(p);
  return out;
}

/** Filter loader ordered by id. An empty list in any filter matches nothing. */
export async function listWorkflows(db: Db, f: WorkflowFilter = {}): Promise<ItemWorkflow[]> {
  if (f.ids?.length === 0 || f.refs?.length === 0 || f.repos?.length === 0 || f.states?.length === 0 || f.logins?.length === 0) return [];
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w").selectAll("w")
    .$if(!!f.ids, (b: any) => b.where(kx.inList(db, "w.id", f.ids!, "bigint")))
    .$if(f.live !== undefined, (b: any) => b.where("w.state", f.live ? "in" : "not in", LIVE_STATES))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "w.repo", f.repos!)))
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "w", pairs(f.refs!))))
    .$if(!!f.states, (b: any) => b.where(kx.inList(db, "w.state", f.states!)))
    .$if(!!f.logins, (b: any) => b.where((eb: any) => eb.or([loginIn(db, eb, "w.started_by", f.logins!, "ls"), loginIn(db, eb, "w.approved_by", f.logins!, "la")])))
    .$if(f.approved !== undefined, (b: any) => b.where("w.approved_by", f.approved ? "is not" : "is", null))
    .$if(f.recAfter !== undefined, (b: any) => b.where("w.rec_at", ">", f.recAfter!))
    .orderBy("w.id")) as WorkflowRow[];
  return rows.map(workflowOf);
}

/** The items with an open recommendation, per repo of `repos`. One statement; a repo without one is absent. */
export async function countWaiting(db: Db, repos: string[]): Promise<Map<string, number>> {
  if (repos.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_workflows as w").select((eb) => ["w.repo", eb.fn.countAll<number>().as("n")])
    .where("w.state", "=", "recommending").where("w.rec", "is not", null).where(kx.inList(db, "w.repo", repos)).groupBy("w.repo"));
  return new Map(rows.map((r) => [r.repo, Number(r.n)]));
}

/**
 * The live workflow that works on each PR: its own, else the one its active merge leg belongs to, else the implement workflow of the
 * issue an attempt opened it for (attemptOf). `others`: without the PR's own. One statement.
 */
export async function loadPrWorkflows(db: Db, refs: { repo: string; number: number }[], o: { others?: boolean } = {}): Promise<PrWorkflows> {
  const out: PrWorkflows = new Map();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const onKey = (alias: string, number: string) => (j: any) => j.onRef("kk.repo", "=", `${alias}.repo`).onRef("kk.number", "=", `${alias}.${number}`);
  const own = k.selectFrom("main.item_workflows as o").innerJoin(resolveKeys(db, refs, "kk"), onKey("o", "number"))
    .select((eb: any) => ["o.repo as repo", "o.number as number", "o.id as wid", eb.lit(0).as("rank")]).where("o.state", "in", LIVE_STATES);
  const leg = k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, refs, "kk"), onKey("p", "number"))
    .select((eb: any) => ["p.repo as repo", "p.number as number", "p.workflow_id as wid", eb.lit(1).as("rank")]).where("p.state", "in", ACTIVE_LEGS).where("p.workflow_id", "is not", null);
  const attempt = k.selectFrom("main.implementations as i").innerJoin(resolveKeys(db, refs, "kk"), onKey("i", "pr_number"))
    .innerJoin("main.item_workflows as iw", (j: any) => j.onRef("iw.repo", "=", "i.repo").onRef("iw.number", "=", "i.number"))
    .select((eb: any) => ["i.repo as repo", "i.pr_number as number", "iw.id as wid", eb.lit(2).as("rank")]).where("iw.entry", "=", "implement").where("iw.state", "in", LIVE_STATES)
    .where((eb: any) => attemptOf(eb, "i", "iw"));
  const rows = await q.all(k.selectFrom(own.unionAll(leg).unionAll(attempt).as("h")).innerJoin("main.item_workflows as w", "w.id", "h.wid")
    .selectAll("w").select(["h.number as pr", "h.rank as rank"]).where("w.state", "in", LIVE_STATES)
    .$if(!!o.others, (b: any) => b.whereRef("w.number", "<>", "h.number")).orderBy("h.rank", "desc").orderBy("w.id")) as (WorkflowRow & { pr: number | string; rank: number })[];
  // The best match of a PR comes last and is the one kept.
  for (const { pr, rank: _rank, ...row } of rows) out.set(refKey(row.repo, Number(pr)), workflowOf(row as WorkflowRow));
  return out;
}

/** Every workflow of each item, oldest first. */
export async function loadWorkflowHistory(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, ItemWorkflow[]>> {
  const out = new Map<RefKey, ItemWorkflow[]>();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w").selectAll("w").where(kx.refIn(db, "w", pairs(refs))).orderBy("w.id")) as WorkflowRow[];
  for (const r of rows) {
    const key = refKey(r.repo, Number(r.number));
    (out.get(key) ?? out.set(key, []).get(key)!).push(workflowOf(r));
  }
  return out;
}

type EventRow = { id: number; workflow_id: number | null; repo: string; number: number; login: string; via: string; kind: string; parsed: string | null; line: string | null; at: string };

type EventFilter = { lastPerRef?: number; kinds?: WorkflowEventKind[] };
/**
 * Events in the order written; `lastPerRef` keeps the newest n of each item. `archived` adds the history of the decision system before the
 * maintainer workflow, whose rows are written later than their `at`.
 */
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o: EventFilter & { archived: true }): Promise<Map<RefKey, StoredEvent[]>>;
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o?: EventFilter): Promise<Map<RefKey, SaidEvent[]>>;
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o: EventFilter & { archived?: true } = {}): Promise<Map<RefKey, StoredEvent[]>> {
  const out = new Map<RefKey, StoredEvent[]>();
  if (refs.length === 0 || o.kinds?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const base = k.selectFrom("main.workflow_events as e")
    .select(["e.id", "e.workflow_id", "e.repo", "e.number", "e.login", "e.via", "e.kind", "e.parsed", "e.line", "e.at"])
    .where(kx.refIn(db, "e", pairs(refs)))
    .$if(!o.archived, (b: any) => b.where((eb: any) => notArchived(eb, "e.kind")))
    .$if(!!o.kinds, (b: any) => b.where(kx.inList(db, "e.kind", o.kinds!)));
  const query = o.lastPerRef === undefined
    ? base.orderBy("e.id")
    : k.selectFrom(base.select((e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["e.repo", "e.number"]).orderBy("e.id", "desc")).as("rn")).as("x")).selectAll("x").where("x.rn", "<=", o.lastPerRef).orderBy("x.id");
  for (const r of await q.all(query) as EventRow[]) {
    const key = refKey(r.repo, Number(r.number));
    (out.get(key) ?? out.set(key, []).get(key)!).push({
      id: Number(r.id), workflowId: r.workflow_id === null ? null : Number(r.workflow_id), repo: r.repo, number: Number(r.number), login: r.login, via: r.via as Surface,
      kind: r.kind as WorkflowEventKind, parsed: parse<Parsed | null>(r.parsed, null), line: r.line, at: r.at,
    });
  }
  return out;
}

/** Latest event kind per item. */
export async function loadLastEventKinds(db: Db, keys: KeySource): Promise<Map<RefKey, WorkflowEventKind>> {
  const out = new Map<RefKey, WorkflowEventKind>();
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newest = k.selectFrom("main.workflow_events as m").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "m.repo").onRef("kk.number", "=", "m.number"))
    .select((eb: any) => eb.fn.max("m.id").as("id")).where((eb: any) => notArchived(eb, "m.kind")).groupBy(["m.repo", "m.number"]);
  for (const r of await q.all(k.selectFrom("main.workflow_events as e").select(["e.repo", "e.number", "e.kind"]).where("e.id", "in", newest)) as { repo: string; number: number; kind: string }[]) {
    out.set(refKey(r.repo, Number(r.number)), r.kind as WorkflowEventKind);
  }
  return out;
}

/** Latest `answered` event per workflow. */
export async function loadAnswers(db: Db, workflowIds: number[]): Promise<Map<number, { login: string; at: string }>> {
  const out = new Map<number, { login: string; at: string }>();
  if (workflowIds.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newest = k.selectFrom("main.workflow_events as m").select((eb: any) => eb.fn.max("m.id").as("id")).where("m.kind", "=", "answered")
    .where(kx.inList(db, "m.workflow_id", workflowIds, "bigint")).groupBy("m.workflow_id");
  for (const r of await q.all(k.selectFrom("main.workflow_events as e").select(["e.workflow_id", "e.login", "e.at"]).where("e.id", "in", newest)) as { workflow_id: number; login: string; at: string }[]) {
    out.set(Number(r.workflow_id), { login: r.login, at: r.at });
  }
  return out;
}

/** Latest `started` or `answered` event time, else the start: when a person last chose to go on with what the workflow showed them. */
export async function loadGoOnAt(db: Db, workflows: { id: number; startedAt: string }[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (workflows.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.workflow_events as e").select(["e.workflow_id"]).select((eb: any) => eb.fn.max("e.at").as("at"))
    .where("e.kind", "in", GO_ON_EVENTS).where(kx.inList(db, "e.workflow_id", workflows.map((w) => w.id), "bigint")).groupBy("e.workflow_id")) as { workflow_id: number; at: string | null }[];
  const latest = new Map(rows.map((r) => [Number(r.workflow_id), r.at]));
  for (const w of workflows) {
    const at = latest.get(w.id) ?? null;
    out.set(w.id, at !== null && at > w.startedAt ? at : w.startedAt);
  }
  return out;
}

/** Command rate limit count: events of `login` on `via` after `since`. */
export async function countEventsSince(db: Db, c: { login: string; via: Surface; since: string }): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workflow_events").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", c.login).where("via", "=", c.via).where("at", ">", c.since)
    .where((eb) => notArchived(eb, "kind")));
  return Number(r?.n ?? 0);
}

/**
 * Inserts workflows in the `running` state, one statement per 500 rows, `ON CONFLICT DO NOTHING` against the unique index of live workflows: a
 * ref missing from the result already has a live workflow. A row with `approvedBy` is approved at its `at`. Joins the caller's `db.write`.
 */
export async function startWorkflows(db: Db, rows: NewWorkflow[]): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const batch of kx.batches(rows)) {
      const got = await q.all((q.k as any).insertInto("main.item_workflows").values(batch.map((w) => {
        const at = w.at ?? now;
        return {
          repo: w.repo, number: w.number, kind: w.kind, entry: w.entry, weight: w.weight, state: "running", started_by: w.startedBy, started_at: at, started_via: w.startedVia,
          base_head: w.baseHead ?? null, approved_by: w.approvedBy ?? null, approved_at: w.approvedBy ? at : null, approved_via: w.approvedBy ? w.approvedVia ?? null : null,
          plan: JSON.stringify(w.plan ?? []), step: w.step ?? null, updated_at: at,
        };
      })).onConflict((oc: any) => oc.doNothing()).returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
      for (const r of got) out.set(refKey(r.repo, Number(r.number)), Number(r.id));
    }
  });
  return out;
}

type Cell = string | number | null;
const PATCH_COLUMNS: { [K in keyof WorkflowPatch]-?: (v: never) => [string, Cell] } = {
  entry: (v) => ["entry", v], weight: (v) => ["weight", v], state: (v) => ["state", v], baseHead: (v) => ["base_head", v],
  approvedBy: (v) => ["approved_by", v], approvedAt: (v) => ["approved_at", v], approvedVia: (v) => ["approved_via", v],
  stoppedBy: (v) => ["stopped_by", v], stoppedAt: (v) => ["stopped_at", v], blocker: (v) => ["blocker", v],
  blockerParams: (v) => ["blocker_params", v ? JSON.stringify(v) : null], rec: (v) => ["rec", v ? JSON.stringify(v) : null], recAt: (v) => ["rec_at", v],
  recHead: (v) => ["rec_head", v], plan: (v) => ["plan", JSON.stringify(v ?? [])], step: (v) => ["step", v], legacyPreapprovalId: (v) => ["legacy_preapproval_id", v],
};

/** The rows to write per distinct column set; patches of the same id merge in order. Every row sets `updated_at` (the live topic `workflows`). */
function patchGroups(rows: { id: number; patch: WorkflowPatch; at?: string }[]): Record<string, Cell>[][] {
  const now = new Date().toISOString();
  const byId = new Map<number, Record<string, Cell>>();
  for (const r of rows) {
    const set = byId.get(r.id) ?? { id: r.id, updated_at: r.at ?? now };
    if (r.at) set.updated_at = r.at;
    for (const [key, value] of Object.entries(r.patch)) {
      if (value === undefined) continue;
      const [col, v] = PATCH_COLUMNS[key as keyof WorkflowPatch](value as never);
      set[col] = v;
    }
    byId.set(r.id, set);
  }
  const groups = new Map<string, Record<string, Cell>[]>();
  for (const set of byId.values()) {
    const shape = Object.keys(set).sort().join(",");
    (groups.get(shape) ?? groups.set(shape, []).get(shape)!).push(set);
  }
  return [...groups.values()];
}

/** Batched update, one statement per distinct patch column set. Returns the rows changed. */
export async function saveWorkflows(db: Db, rows: { id: number; patch: WorkflowPatch; at?: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  return await db.write(async () => {
    let changed = 0;
    for (const group of patchGroups(rows)) changed += await kx.updateFrom(db, "main.item_workflows", ["id"], group);
    return changed;
  });
}

/**
 * `saveWorkflows` for rows read before this write: one that changed since (`was`: the state and `updated_at` it was read with) is left as it
 * is. One patch per id. Returns the ids written. Joins the caller's `db.write`.
 */
export async function moveWorkflows(db: Db, rows: { id: number; patch: WorkflowPatch; at: string; was: { state: WorkflowState; updatedAt: string } }[]): Promise<Set<number>> {
  if (rows.length === 0) return new Set();
  const q = queryDb(db);
  return await db.write(async () => {
    const now = new Map((await q.all((q.k as any).selectFrom("main.item_workflows as w").select(["w.id", "w.state", "w.updated_at"]).where(kx.inList(db, "w.id", rows.map((r) => r.id), "bigint"))) as
      { id: number | string; state: string; updated_at: string }[]).map((r) => [Number(r.id), r]));
    const same = rows.filter((r) => { const n = now.get(r.id); return n?.state === r.was.state && n.updated_at === r.was.updatedAt; });
    await saveWorkflows(db, same);
    return new Set(same.map((r) => r.id));
  });
}

/** Batched insert, 500 rows a statement. */
export async function recordEvents(db: Db, rows: WorkflowEvent[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const batch of kx.batches(rows)) {
      await q.run((q.k as any).insertInto("main.workflow_events").values(batch.map((e) => ({
        workflow_id: e.workflowId, repo: e.repo, number: e.number, login: e.login, via: e.via ?? "cli", kind: e.kind,
        parsed: e.parsed ? JSON.stringify(e.parsed) : null, line: e.line ?? null, at: e.at ?? now,
      }))));
    }
  });
}

/**
 * `1e15 + weight * 1e12 - workflow.id` for every item of `keys` with a live workflow and for the implementation PR of a live implement
 * workflow (the maximum when both apply). One statement.
 */
export async function loadWorkScores(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const own = k.selectFrom("main.item_workflows as w").innerJoin(resolveKeys(db, keys, "ks"), (j: any) => j.onRef("ks.repo", "=", "w.repo").onRef("ks.number", "=", "w.number"))
    .select((eb: any) => ["w.repo as repo", "w.number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES);
  const viaPr = k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .innerJoin(resolveKeys(db, keys, "kt"), (j: any) => j.onRef("kt.repo", "=", "i.repo").onRef("kt.number", "=", "i.pr_number"))
    .select((eb: any) => ["i.repo as repo", "i.pr_number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES).where("w.entry", "=", "implement").where("i.pr_number", "is not", null).where((eb: any) => attemptOf(eb, "i", "w"));
  for (const r of await q.all(own.unionAll(viaPr)) as { repo: string; number: number; s: number | string }[]) {
    const key = refKey(r.repo, Number(r.number)), s = Number(r.s), old = out.get(key);
    if (old === undefined || s > old) out.set(key, s);
  }
  return out;
}

/** The weight behind each item's work score (loadWorkScores): its live workflow's, or that of the issue its PR implements. One statement. */
export async function loadWorkWeights(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  // Workflow ids stay below the score's weight step of 1e12.
  return new Map([...await loadWorkScores(db, keys)].map(([key, s]) => [key, Math.ceil((s - 1e15) / 1e12)]));
}

/** Open items with a live workflow ordered by weight then id, with `row_number()` and `count(*) OVER ()` over the whole queue; `repos` narrows the result, not the positions. */
export async function loadQueuePositions(db: Db, f: { repos?: string[] } = {}): Promise<Map<RefKey, QueuePosition>> {
  const out = new Map<RefKey, QueuePosition>();
  if (f.repos?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const all = k.selectFrom("main.item_workflows as w")
    .select((e: any) => ["w.repo", "w.number", "w.weight", "w.started_by", e.fn.agg("row_number").over((o: any) => o.orderBy("w.weight", "desc").orderBy("w.id")).as("pos"), e.fn.countAll().over().as("total")])
    .where("w.state", "in", LIVE_STATES).where((eb: any) => openItem(eb, "w.repo", "w.number"));
  const rows = await q.all(k.selectFrom(all.as("x")).selectAll("x").$if(!!f.repos, (b: any) => b.where(kx.inList(db, "x.repo", f.repos!))).orderBy("x.pos")) as
    { repo: string; number: number; weight: number; started_by: string; pos: number; total: number }[];
  for (const r of rows) out.set(refKey(r.repo, Number(r.number)), { position: Number(r.pos), of: Number(r.total), weight: Number(r.weight), startedBy: r.started_by });
  return out;
}

/** Items a person started or approved (case-insensitive login), with the implementation PR of a live implement workflow; narrowed by workflow state, refs, repos and open state. */
export async function loadStartedRefs(db: Db, f: StartedFilter = {}): Promise<Set<RefKey>> {
  const out = new Set<RefKey>();
  if (f.refs?.length === 0 || f.repos?.length === 0 || f.states?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const who = (b: any) => f.login === undefined ? b : b.where((eb: any) => eb.or([loginIn(db, eb, "w.started_by", [f.login!], "ls"), loginIn(db, eb, "w.approved_by", [f.login!], "la")]));
  const states = f.states ?? LIVE_STATES;
  const own = who(k.selectFrom("main.item_workflows as w").select(["w.repo as repo", "w.number as number"]).where("w.state", "in", states));
  const viaPr = who(k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .select(["i.repo as repo", "i.pr_number as number"]).where("w.state", "in", states).where("w.entry", "=", "implement").where("i.pr_number", "is not", null).where((eb: any) => attemptOf(eb, "i", "w")));
  const rows = await q.all(k.selectFrom(own.union(viaPr).as("s")).select(["s.repo", "s.number"])
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "s", pairs(f.refs!))))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "s.repo", f.repos!)))
    .$if(!!f.openOnly, (b: any) => b.where((eb: any) => openItem(eb, "s.repo", "s.number")))) as { repo: string; number: number }[];
  for (const r of rows) out.add(refKey(r.repo, Number(r.number)));
  return out;
}

/** The Task Runner snapshot's input: live workflows and the PRs of live implement workflows with an attempt still working; two result sets in one wave. */
export async function loadStartedWork(db: Db): Promise<StartedWork> {
  const q = queryDb(db);
  const k = q.k as any;
  const [live, prs] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.item_workflows as w").select(["w.repo", "w.number", "w.entry", "w.state", "w.started_by", "w.approved_by"]).where("w.state", "in", LIVE_STATES).orderBy("w.id")),
    q.all(k.selectFrom("main.implementations as i").innerJoin("main.item_workflows as w", (j: any) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number"))
      .select(["i.repo as repo", "i.pr_number as pr", "w.started_by as started_by", "w.approved_by as approved_by"]).distinct()
      .where("i.pr_number", "is not", null).where("i.state", "not in", ENDED_ATTEMPTS).where("w.entry", "=", "implement").where("w.state", "in", LIVE_STATES)),
  ])) as [{ repo: string; number: number; entry: Entry; state: WorkflowState; started_by: string; approved_by: string | null }[], { repo: string; pr: number; started_by: string; approved_by: string | null }[]];
  return {
    live: live.map((r) => ({ repo: r.repo, number: Number(r.number), entry: r.entry, state: r.state, startedBy: r.started_by, approvedBy: r.approved_by })),
    prs: prs.map((r) => ({ repo: r.repo, pr: Number(r.pr), startedBy: r.started_by, approvedBy: r.approved_by })),
  };
}

/** Repos with a live workflow. */
export async function loadLiveRepos(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  return new Set((await q.all(q.k.selectFrom("main.item_workflows").select("repo").distinct().where("state", "in", LIVE_STATES))).map((r) => r.repo));
}

/** Distinct logins the pipeline acts for with their repo: active leg owners, queued fix-up requesters, and `approved_by` or `started_by` of live workflows; one `UNION`. */
export async function loadActingPairs(db: Db): Promise<{ login: string; repo: string }[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const legs = k.selectFrom("main.preapprovals as p").select(["p.by as login", "p.repo as repo"]).where("p.state", "in", ACTIVE_LEGS);
  const requests = k.selectFrom("main.operator_fixups as o").select(["o.by as login", "o.repo as repo"]).where("o.state", "=", "queued");
  const approvers = k.selectFrom("main.item_workflows as w").select(["w.approved_by as login", "w.repo as repo"]).where("w.state", "in", LIVE_STATES).where("w.approved_by", "is not", null);
  const starters = k.selectFrom("main.item_workflows as w").select(["w.started_by as login", "w.repo as repo"]).where("w.state", "in", LIVE_STATES);
  return await q.all(k.selectFrom(legs.union(requests).union(approvers).union(starters).as("a")).select(["a.login", "a.repo"]).orderBy("a.repo").orderBy("a.login")) as { login: string; repo: string }[];
}

/**
 * How each workflow's path ended after the approval made at `approvedAt`: `stopped` when the approval was withdrawn or replaced (another or no
 * `approved_at`) or the workflow was stopped or went to the backlog, `closed`, `merged` for a finished workflow (`done`), null while the approval
 * stands on a live workflow. A workflow row that is gone reads `stopped`.
 */
export async function loadPathEnds(db: Db, rows: { workflowId: number; approvedAt: string }[]): Promise<Map<number, "merged" | "closed" | "stopped" | null>> {
  const out = new Map<number, "merged" | "closed" | "stopped" | null>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const got = await q.all(q.k.selectFrom("main.item_workflows").select(["id", "state", "approved_at"]).where(kx.inList(db, "id", rows.map((r) => r.workflowId), "bigint")));
  const byId = new Map(got.map((r) => [Number(r.id), r]));
  for (const r of rows) {
    const w = byId.get(r.workflowId);
    if (!w || w.approved_at !== r.approvedAt) out.set(r.workflowId, "stopped");
    else out.set(r.workflowId, w.state === "done" ? "merged" : w.state === "closed" ? "closed" : w.state === "stopped" || w.state === "backlog" ? "stopped" : null);
  }
  return out;
}

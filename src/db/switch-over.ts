// The switch to the maintainer workflow, once: what older processes wrote after the state copy is carried over, the answered
// and open questions and the results of the decision system become `archived` workflow events, every tracked repo runs the
// maintainer workflow, and each open fast-track row becomes a started workflow.
//
// When. The runner runs it after it won its lease and before it starts work (src/runner/index.ts), on both engines. By then
// the older runner and its jobs are fenced, so their last writes are in place; older dashboards may serve for some minutes
// more. Nothing is dropped or locked as a whole: reads are paged by primary key, every page is a short write transaction, and
// what older processes still write to the old places afterwards is not read again.
//
// Idempotent. The archive skips rows it has written (unique index workflow_events_archived), the carry-over compares values,
// and the rest commits in one transaction with the marker SWITCH_KEY, so a run cut short is completed by the next one and a
// second run does nothing. The marker names the older runner's last heartbeat: when an older release ran again in between (a
// rollback), the heartbeat moved and the switch runs again for what that release wrote.
//
// Which side wins, per copied place (`old` is what older processes write, `new` the module's table):
// - lane_state, dupe_drops, merge_state, liveness_state, classify_state `jev_failed`, the review_state counters: only the
//   runner writes them, and the older one wrote last, so old wins, rows it removed included.
// - merge_repo_state, build_state, classify_state `current_run`: people change them too, so on the first run a new row written
//   after the copy stays; otherwise old wins.
// - review_state.stale_at, stage_limits.reset_at and a Task Runner's idle claim: the later time wins.
// - repo_step_approvals: a person's later grant or revocation wins, whichever side it was made on, and both sides are equal
//   afterwards. It decides nothing itself.
// - sync_state: the side with the later org_high_water wins whole (the periodic copy changes hands on its own).
// - stage_limits: one table; a limit an older process stored on a row that only recorded a reset counts as set.
// - agent_runs first item, remote_call_items, merge_batch_prs.repo, merge_batches.fork, discord_alert_msgs workflow key,
//   duplicate group ids, a Task Runner's machine: filled where empty.
// - discord_filed, plan_pass_stats and every other table: one place for both, nothing to carry.
import type { ReviewWorkflow } from "../data/review/types.ts";
import { afterSteps, atBlocker, type ReviewView } from "../workflow/recommend.ts";
import type { Parsed, PlanPart } from "../workflow/types.ts";
import type { Db } from "./index.ts";
import * as kx from "./kx.ts";
import { ACTIVE_LEG_STATES, backfills, boundsSql, settingsState, spans, STATE_COPY_DONE, type StateRows, type Task, type Value } from "./state-copy.ts";

export const SWITCH_KEY = "workflow_switch";
const ACTOR = "pipeline";
const LIVE = ["running", "waiting", "blocked", "recommending"];
const WITHDRAWN = "withdrawn";
const BACKLOG = "backlog";
const PAGE = 500;
const DAY_MS = 86_400_000;
/** Longest question or reason kept on an archived line, and how many refs a list of the report holds. */
const LINE_CHARS = 300;
const LISTED = 200;

export interface SwitchReport {
  at: string;
  archived: { answered: number; withdrawn: number; actions: number; withoutItem: number };
  /** Copied state that differed and was carried over, rows per table. */
  carried: Record<string, number>;
  /** Stopped pre-approvals ended, and the workflows that wait with a recommendation for them. */
  legsEnded: number;
  recommending: string[];
  /** Pre-approved merges in progress on an item nobody started in the workflow: the pre-approval pass ends them. */
  legsWithoutWorkflow: string[];
  /** Answers nothing had acted on yet. */
  unapplied: string[];
  repos: number;
  fastTrack: { item: string; entry: string; by: string; weight: number; workflow: number }[];
  fastTrackSkipped: { item: string; why: string }[];
  backlog: number;
  taskItems: number;
}

export interface SwitchOptions {
  now?: string;
  log?: (line: string) => void;
  /** Daily limits per step, for a reset of a step that has no limit row. */
  perDay?: Record<string, number | null>;
}

/** Runs the switch when it is due; null when there is nothing to do. */
export async function switchOver(db: Db, o: SwitchOptions = {}): Promise<SwitchReport | null> {
  const now = o.now ?? new Date().toISOString();
  const marker = await markerOf(db);
  const heartbeat = await setting(db, "runner_heartbeat");
  if (marker && marker.heartbeat === heartbeat) return null;
  const copied = await setting(db, STATE_COPY_DONE);
  // Both sides were equal at this time: at the last switch, else at the state copy (a copy without a time: now).
  const since = marker?.at ?? (copied !== null && /^\d{4}-/.test(copied) ? copied : now);
  const r: SwitchReport = {
    at: now, archived: { answered: 0, withdrawn: 0, actions: 0, withoutItem: 0 }, carried: {}, legsEnded: 0, recommending: [], legsWithoutWorkflow: [],
    unapplied: [], repos: 0, fastTrack: [], fastTrackSkipped: [], backlog: 0, taskItems: 0,
  };
  await carryState(db, r, { now, since, keepAfter: marker ? null : since, perDay: o.perDay });
  await carryColumns(db, r, since);
  await archiveDecisions(db, r, now, true);
  await archiveActions(db, r);
  await db.write(async () => {
    await endAskedLegs(db, r, now);
    r.repos = (await run(db, q(db).updateTable("main.tracked_repos").set({ workflow: "new" }).where("workflow", "<>", "new"))).changes;
    await startFastTracked(db, r, now);
    r.taskItems = (await run(db, q(db).updateTable("main.user_settings").set({ value: "started", updated_at: now }).where("key", "=", "task_items").where("value", "=", "fast"))).changes;
    await reportLeft(db, r);
    await run(db, q(db).insertInto("main.audit").values({ at: now, login: ACTOR, action: "workflow-switch", target: null, details: JSON.stringify(r) }));
    await run(db, q(db).insertInto("main.settings").values({ key: SWITCH_KEY, value: JSON.stringify({ at: now, heartbeat }) })
      .onConflict((oc: any) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  });
  for (const line of reportLines(r)) o.log?.(line);
  return r;
}

/** The report as log lines. */
export function reportLines(r: SwitchReport): string[] {
  const a = r.archived;
  const carried = Object.entries(r.carried).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ");
  return [
    `switch to the maintainer workflow: ${a.answered} answered and ${a.withdrawn} open questions and ${a.actions} actions archived (${a.withoutItem} questions without an item in the audit log)`,
    `  ${r.repos} repos moved, ${r.legsEnded} stopped pre-approvals ended, ${r.backlog} items kept in the backlog, ${r.taskItems} Task Runner settings renamed; carried over: ${carried || "nothing"}`,
    ...r.fastTrack.map((f) => `  fast track: ${f.item} starts ${f.entry} for ${f.by} at weight ${f.weight} (workflow ${f.workflow})`),
    ...r.fastTrackSkipped.map((f) => `  fast track: ${f.item} not started: ${f.why}`),
    ...(r.recommending.length ? [`  waiting with a recommendation: ${r.recommending.join(", ")}`] : []),
    ...(r.legsWithoutWorkflow.length ? [`  pre-approved merges that end because nobody started the item: ${r.legsWithoutWorkflow.join(", ")}`] : []),
    ...(r.unapplied.length ? [`  answers nothing had acted on: ${r.unapplied.join(", ")}`] : []),
  ];
}

// ---- helpers -------------------------------------------------------------------------------------------------------

type Row = Record<string, any>;
/** Read at each use: the builder of the open transaction. */
const q = (db: Db): any => db.k;
const all = (db: Db, x: any): Promise<Row[]> => db.all(x) as Promise<Row[]>;
const get = (db: Db, x: any): Promise<Row | undefined> => db.get(x) as Promise<Row | undefined>;
const run = (db: Db, x: any): Promise<{ changes: number }> => db.run(x);
const key = (r: { repo: string; number: number | string }): string => `${r.repo}#${r.number}`;

const setting = async (db: Db, name: string): Promise<string | null> =>
  ((await get(db, q(db).selectFrom("main.settings").select("value").where("key", "=", name)))?.value as string | undefined) ?? null;

async function markerOf(db: Db): Promise<{ at: string; heartbeat: string | null } | null> {
  const v = parse(await setting(db, SWITCH_KEY)) as { at?: unknown; heartbeat?: unknown } | null;
  return v && typeof v.at === "string" ? { at: v.at, heartbeat: typeof v.heartbeat === "string" ? v.heartbeat : null } : null;
}

function parse(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One line of at most LINE_CHARS characters. */
const oneLine = (text: string): string => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s;
};

// ---- state copied out of settings ----------------------------------------------------------------------------------

type CarryOptions = { now: string; since: string; keepAfter: string | null; perDay?: Record<string, number | null> };

async function carryState(db: Db, r: SwitchReport, o: CarryOptions): Promise<void> {
  const rows = await all(db, q(db).selectFrom("main.settings").select(["key", "value"]).where("value", "is not", null));
  const s = settingsState(rows, o.now);
  const t = s.tables;
  const replace = async (st: StateRows, keys: string[], x: ReplaceOptions = {}): Promise<void> => {
    r.carried[st.table] = (r.carried[st.table] ?? 0) + await db.write(() => replaceState(db, st, keys, x));
  };
  await replace(t.lane_state, ["kind", "step", "repo"], { stamp: "at" });
  await replace(t.dupe_drops, ["repo", "key"]);
  await replace(t.merge_state, ["repo", "number"]);
  await replace(t.liveness_state, ["id"]);
  await replace(t.merge_repo_state, ["repo"], { stamp: "updated_at", keepAfter: o.keepAfter });
  await replace(t.build_state, ["key"], { stamp: "updated_at", keepAfter: o.keepAfter });
  await replace(t.classify_state, ["kind", "repo", "number"], { stamp: "at", keepAfter: o.keepAfter, only: ["kind", "current_run"] });
  await replace(t.review_state, ["repo", "number"], { latest: "stale_at" });
  r.carried.sync_state = await db.write(() => carrySync(db, t.sync_state));
  r.carried.repo_step_approvals = await db.write(() => carryApprovals(db, rows, t.repo_step_approvals, o.since));
  r.carried.stage_limits = await db.write(() => carryLimits(db, s.resets, o.perDay));
  r.carried.jev_failed = await db.write(() => carryJevFailed(db, o));
}

type ReplaceOptions = {
  /** The column that says when the row was written: not compared, since the settings rows carry no time for it. */
  stamp?: string;
  /** A stored row whose stamp is later stays, whatever the settings say. */
  keepAfter?: string | null;
  /** [column, value]: only the stored rows that have it are compared. */
  only?: [string, string];
  /** A time column the later value of which wins; a stored row that has one is never removed. */
  latest?: string;
};

/** Makes the stored rows of `s.table` those of `s`, by `keys`; returns how many it changed. */
async function replaceState(db: Db, s: StateRows, keys: string[], o: ReplaceOptions): Promise<number> {
  const name = `main.${s.table}`;
  const id = (x: Row): string => JSON.stringify(keys.map((c) => x[c]));
  const num = (c: string): boolean => c === "number" || c === "id";
  const norm = (x: Row): Row => Object.fromEntries(s.cols.map((c) => [c, num(c) && x[c] !== null ? Number(x[c]) : x[c]]));
  let stored = q(db).selectFrom(name).select(s.cols);
  if (o.only) stored = stored.where(o.only[0], "=", o.only[1]);
  const have = new Map((await all(db, stored)).map(norm).map((x) => [id(x), x]));
  const want = new Map(s.rows.map((v) => norm(Object.fromEntries(s.cols.map((c, i) => [c, v[i]])))).map((x) => [id(x), x]));
  const later = (x: Row): boolean => !!o.stamp && !!o.keepAfter && String(x[o.stamp] ?? "") > o.keepAfter;
  const put: Row[] = [];
  const gone: Row[] = [];
  for (const [k, w] of want) {
    const h = have.get(k);
    if (h && later(h)) continue;
    const next = h && o.latest && String(h[o.latest] ?? "") > String(w[o.latest] ?? "") ? { ...w, [o.latest]: h[o.latest] } : w;
    if (!h || s.cols.some((c) => c !== o.stamp && !same(h[c], next[c]))) put.push(next);
  }
  for (const [k, h] of have) if (!want.has(k) && !later(h) && !(o.latest && h[o.latest])) gone.push(h);
  for (const part of kx.batches(gone)) {
    await run(db, q(db).deleteFrom(name).where(kx.tupleIn(db, keys, part.map((h) => keys.map((c) => h[c])), keys.map((c) => (num(c) ? "bigint" : "text")))));
  }
  const set = s.cols.filter((c) => !keys.includes(c));
  for (const part of kx.batches(put)) await run(db, q(db).insertInto(name).values(part).onConflict((oc: any) => oc.columns(keys).doUpdateSet(kx.excluded(set))));
  return put.length + gone.length;
}

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null) || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

async function carrySync(db: Db, s: StateRows): Promise<number> {
  if (!s.rows.length) return 0;
  const old = Object.fromEntries(s.cols.map((c, i) => [c, s.rows[0]![i]])) as Row;
  const have = await get(db, q(db).selectFrom("main.sync_state").selectAll().where("id", "=", 1));
  if (have && String(have.org_high_water ?? "") >= String(old.org_high_water ?? "")) return 0;
  if (have) await run(db, q(db).deleteFrom("main.sync_state").where("id", "=", 1));
  await run(db, q(db).insertInto("main.sync_state").values(old));
  return 1;
}

async function carryApprovals(db: Db, settings: Row[], s: StateRows, since: string): Promise<number> {
  const keyOf = (x: { repo: string; step: string }): string => `${x.step}_approved:${x.repo}`;
  type Approval = { repo: string; step: string; by: string; at: string };
  // An approval stored without a time is as old as the copy.
  const timed = new Set(settings.filter((x) => typeof (parse(x.value) as Row | null)?.at === "string").map((x) => x.key as string));
  const old = new Map(s.rows.map(([repo, step, by, at]) => ({ repo, step, by, at }) as Approval).map((a) => [keyOf(a), timed.has(keyOf(a)) ? a : { ...a, at: "" }]));
  const have = new Map((await all(db, q(db).selectFrom("main.repo_step_approvals").select(["repo", "step", "by", "at"]))).map((a) => [keyOf(a as Approval), a as Approval]));
  let n = 0;
  const store = async (a: Approval): Promise<void> => {
    n++;
    await run(db, q(db).insertInto("main.repo_step_approvals").values(a).onConflict((oc: any) => oc.columns(["repo", "step"]).doUpdateSet(kx.excluded(["by", "at"]))));
  };
  const write = async (k: string, a: Approval | null): Promise<void> => {
    if (!a) return void await run(db, q(db).deleteFrom("main.settings").where("key", "=", k));
    await run(db, q(db).insertInto("main.settings").values({ key: k, value: JSON.stringify({ by: a.by, at: a.at }) }).onConflict((oc: any) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  };
  for (const [k, a] of old) {
    const h = have.get(k);
    if (h ? a.at > h.at : a.at > since) await store(a);
    else if (!h) await write(k, null);
    else if (h.at > a.at) await write(k, h);
  }
  for (const [k, h] of have) {
    if (old.has(k)) continue;
    if (h.at > since) await write(k, h);
    else {
      n++;
      await run(db, q(db).deleteFrom("main.repo_step_approvals").where("repo", "=", h.repo).where("step", "=", h.step));
    }
  }
  return n;
}

async function carryLimits(db: Db, resets: [string, string][], perDay: Record<string, number | null> | undefined): Promise<number> {
  let n = (await run(db, q(db).updateTable("main.stage_limits").set({ limit_set: 1 }).where("limit_set", "=", 0).where("updated_at", "is not", null))).changes;
  for (const [step, at] of resets) {
    n += (await run(db, q(db).updateTable("main.stage_limits").set({ reset_at: at }).where("step", "=", step).where((eb: any) => eb.or([eb("reset_at", "is", null), eb("reset_at", "<", at)])))).changes;
    if (perDay) n += (await run(db, q(db).insertInto("main.stage_limits").values({ step, per_day: perDay[step] ?? null, reset_at: at, limit_set: 0 }).onConflict((oc: any) => oc.doNothing()))).changes;
  }
  return n;
}

async function carryJevFailed(db: Db, o: CarryOptions): Promise<number> {
  const gone = await db.prepare(`DELETE FROM main.classify_state WHERE kind = 'jev_failed' AND (CAST(? AS TEXT) IS NULL OR at <= ?)
    AND NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = classify_state.repo AND i.number = classify_state.number AND i.jev_failed_hash = classify_state.value)`).run(o.keepAfter, o.keepAfter);
  const put = await db.prepare(`INSERT INTO main.classify_state (kind, repo, number, value, at)
    SELECT 'jev_failed', repo, number, jev_failed_hash, CAST(? AS TEXT) FROM main.items WHERE jev_failed_hash IS NOT NULL
    ON CONFLICT (kind, repo, number) DO UPDATE SET value = excluded.value, at = excluded.at WHERE classify_state.value <> excluded.value`).run(o.now);
  return Number(gone.changes) + Number(put.changes);
}

// ---- columns older processes leave empty ----------------------------------------------------------------------------

async function carryColumns(db: Db, r: SwitchReport, since: string): Promise<void> {
  const t = backfills("main.");
  // A run older than a day before the copy had its items then; started_at is indexed.
  const from = new Date(Date.parse(since) - DAY_MS).toISOString();
  await backfill(db, t.agentRuns, (await get(db, q(db).selectFrom("main.agent_runs").select((eb: any) => [eb.fn.min("id").as("lo"), eb.fn.max("id").as("hi")]).where("started_at", ">=", from))));
  for (const task of [t.callItems, t.batchPrs, t.batchForks, t.alerts, t.groups, t.groupItems]) await backfill(db, task);
  const idle = (col: string): string => `(SELECT t.${col} FROM main.mcp_tokens t WHERE t.id = remote_helpers.token_id)`;
  r.carried.remote_helpers = await db.write(async () => Number((await db.prepare(`UPDATE main.remote_helpers
      SET idle_claim_at = ${idle("idle_claim_at")}, idle_tiers = ${idle("idle_tiers")}, idle_repos = ${idle("idle_repos")}
      WHERE ${idle("idle_claim_at")} > COALESCE(idle_claim_at, 0)`).run()).changes)
    + Number((await db.prepare(`UPDATE main.remote_helpers SET machine = ${idle("machine")} WHERE machine IS NULL AND ${idle("machine")} IS NOT NULL`).run()).changes));
}

/** Runs a backfill of the state copy again, one write transaction per unit. */
async function backfill(db: Db, t: Task, bounds?: Row): Promise<void> {
  const b = t.range ? bounds ?? await db.prepare(boundsSql(t, "main.")).get() : undefined;
  for (const [lo, hi] of spans(t, b)) {
    await db.write(async () => {
      const read = t.read?.(lo, hi);
      const rows = read ? await db.prepare(read.sql).all(...read.params as Value[]) : [];
      for (const w of t.writes(rows, lo, hi)) await db.prepare(w.sql).run(...w.params as Value[]);
    });
  }
}

// ---- archive --------------------------------------------------------------------------------------------------------

type Archived = { repo: string; number: number; login: string; legacy: string; line: string; at: string };

/** Writes archived events; a row already archived (same item and `legacy`) is skipped. Returns how many it wrote. */
async function addArchived(db: Db, rows: Archived[]): Promise<number> {
  let n = 0;
  for (const part of kx.batches(rows)) {
    n += (await run(db, q(db).insertInto("main.workflow_events").values(part.map((e) => ({
      workflow_id: null, repo: e.repo, number: e.number, login: e.login, via: "cli", kind: "archived",
      parsed: JSON.stringify({ kind: "archived", legacy: e.legacy }), line: e.line, at: e.at,
    }))).onConflict((oc: any) => oc.doNothing()))).changes;
  }
  return n;
}

type ItemAnswer = { repo: string; number: number; answer?: string };

/** The items of a decision: its own, or those its `items` JSON names. */
function itemsOf(d: Row): ItemAnswer[] {
  if (d.number !== null && d.repo !== null) return [{ repo: d.repo as string, number: Number(d.number) }];
  const list = (text: unknown): ItemAnswer[] => {
    const v = parse(text);
    return (Array.isArray(v) ? v : []).filter((x): x is ItemAnswer => typeof x?.repo === "string" && Number.isInteger(x?.number));
  };
  const other = new Map(list(d.exceptions).map((x) => [key(x), x.answer]));
  return list(d.items).map((x) => ({ repo: x.repo, number: x.number, answer: other.get(key(x)) }));
}

/** The label of an answer among the decision's options, else its key. */
function labelOf(d: Row, answer: string): string {
  const options = parse(d.options);
  const label = (Array.isArray(options) ? options : []).find((x) => x?.key === answer)?.label as unknown;
  return typeof label === "string" && label ? label : answer;
}

/**
 * Archives every answered decision and, with `open`, every unanswered one as withdrawn: one event per item it names, or an
 * audit row for a decision that names none. Paged by id, a transaction per page.
 */
export async function archiveDecisions(db: Db, r: Pick<SwitchReport, "archived">, now: string, open: boolean): Promise<void> {
  const listed = new Set((await all(db, q(db).selectFrom("main.audit").select("target").where("action", "=", "decision-archived"))).map((x) => x.target as string));
  for (let last = ""; ;) {
    const page = await all(db, q(db).selectFrom("main.decisions").select(["id", "kind", "repo", "number", "items", "question", "options", "exceptions", "answer", "answered_by", "answered_at", "asked_at"])
      .where("id", ">", last).orderBy("id").limit(PAGE));
    if (!page.length) return;
    last = page.at(-1)!.id as string;
    const answered: Archived[] = [];
    const withdrawn: Archived[] = [];
    const audits: Row[] = [];
    for (const d of page) {
      const done = d.answer !== null;
      if (!done && !open) continue;
      const items = itemsOf(d);
      const line = (answer: string | null): string => (answer === null ? `${oneLine(d.question)} Withdrawn at the switch to the maintainer workflow.`
        : answer === WITHDRAWN ? `${oneLine(d.question)} Withdrawn.` : `${oneLine(d.question)} Answer: ${oneLine(labelOf(d, answer))}.`);
      const login = (done ? d.answered_by as string | null : null) ?? ACTOR;
      const at = (done ? (d.answered_at ?? d.asked_at) as string : now);
      const legacy = `decision:${d.id}${done ? "" : ":open"}`;
      for (const i of items) (done ? answered : withdrawn).push({ repo: i.repo, number: i.number, login, legacy, line: line(done ? i.answer ?? d.answer as string : null), at });
      if (!items.length && !listed.has(legacy)) audits.push({ at, login, action: "decision-archived", target: legacy, details: JSON.stringify({ repo: d.repo, kind: d.kind, line: line(d.answer as string | null) }) });
    }
    await db.write(async () => {
      r.archived.answered += await addArchived(db, answered);
      r.archived.withdrawn += await addArchived(db, withdrawn);
      if (audits.length) await run(db, q(db).insertInto("main.audit").values(audits));
    });
    r.archived.withoutItem += audits.length;
  }
}

const ACTION_WORDS: Record<string, string> = { "comment-close": "Comment and close" };

/** Archives every row of `actions`, once per state it was seen in. */
export async function archiveActions(db: Db, r: Pick<SwitchReport, "archived">): Promise<void> {
  for (let last = 0; ;) {
    const page = await all(db, q(db).selectFrom("main.actions as a").leftJoin("main.decisions as d", "d.id", "a.decision_id")
      .select(["a.id", "a.repo", "a.number", "a.kind", "a.state", "a.comment_url", "a.reason", "a.created_at", "d.answered_by"]).where("a.id", ">", last).orderBy("a.id").limit(PAGE));
    if (!page.length) return;
    last = Number(page.at(-1)!.id);
    const rows = page.map((a): Archived => ({
      repo: a.repo, number: Number(a.number), login: a.answered_by ?? ACTOR, legacy: `action:${a.id}:${a.state}`, at: a.created_at,
      line: oneLine(`${ACTION_WORDS[a.kind as string] ?? a.kind}: ${a.state}${a.reason ? ` (${a.reason})` : ""}${a.comment_url ? ` ${a.comment_url}` : ""}`),
    }));
    r.archived.actions += await db.write(() => addArchived(db, rows));
  }
}

// ---- pre-approvals --------------------------------------------------------------------------------------------------

/**
 * Ends the pre-approvals that stopped for a Merge? question. A running workflow whose newest leg stopped so, with no answer
 * since, waits with the review's recommendation; without one, with a sentence that names the stop.
 */
async function endAskedLegs(db: Db, r: SwitchReport, now: string): Promise<void> {
  const stopped = await all(db, q(db).selectFrom("main.preapprovals as p").innerJoin("main.item_workflows as w", "w.id", "p.workflow_id")
    .innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .leftJoin("main.opus_reviews as o", (j: any) => j.onRef("o.repo", "=", "p.repo").onRef("o.number", "=", "p.number").onRef("o.head_oid", "=", "i.head_oid"))
    .select(["w.id", "w.repo", "w.number", "w.plan", "p.reason", "i.head_oid as head", "o.verdict", "o.sure", "o.workflow"])
    .where("p.state", "=", "asked").where("w.state", "in", ["running", "waiting"]).where("i.state", "=", "OPEN")
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.preapprovals as n").select(eb.lit(1).as("one")).whereRef("n.repo", "=", "p.repo").whereRef("n.number", "=", "p.number").whereRef("n.id", ">", "p.id"))))
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.workflow_events as e").select(eb.lit(1).as("one")).whereRef("e.workflow_id", "=", "w.id")
      .where("e.kind", "in", ["started", "answered"]).whereRef("e.at", ">", "p.updated_at")))));
  for (const s of stopped) {
    const plan = (parse(s.plan) ?? []) as PlanPart[];
    const review = parse(s.workflow) as ReviewWorkflow | null;
    const view: ReviewView | null = s.verdict === null ? null : { verdict: s.verdict, sure: Number(s.sure) === 1, rec: review?.recommendation ?? null };
    const rec = view?.rec ? afterSteps(view, plan) : atBlocker({ blocker: "other", params: s.reason ? { reason: s.reason } : {} }, view, plan);
    await run(db, q(db).updateTable("main.item_workflows").set({ state: "recommending", rec: JSON.stringify(rec), rec_at: now, rec_head: s.head, updated_at: now }).where("id", "=", s.id));
    r.recommending.push(key(s as { repo: string; number: number }));
  }
  // updated_at stays: it says when the leg stopped, and a stop older than the workflow's last answer is no new one.
  r.legsEnded = (await run(db, q(db).updateTable("main.preapprovals").set({ state: "cancelled" }).where("state", "=", "asked"))).changes;
}

// ---- fast track and backlog -------------------------------------------------------------------------------------------

/** The items a Backlog answer holds (its own, a batch's, a duplicate group's members), with the latest such answer. */
async function backlogAnswers(db: Db): Promise<Map<string, { by: string; at: string }>> {
  const out = new Map<string, { by: string; at: string }>();
  const add = (item: string, d: Row): void => {
    const x = { by: (d.answered_by as string | null) ?? ACTOR, at: (d.answered_at ?? d.asked_at) as string };
    if ((out.get(item)?.at ?? "") < x.at) out.set(item, x);
  };
  const rows = await all(db, q(db).selectFrom("main.decisions").select(["id", "repo", "number", "items", "exceptions", "answered_by", "answered_at", "asked_at"]).where("answer", "=", BACKLOG));
  for (const d of rows) for (const i of itemsOf(d)) add(key(i), d);
  const members = await all(db, q(db).selectFrom("main.dupe_group_items as g").innerJoin("main.decisions as d", "d.id", "g.decision_id")
    .select(["g.repo", "g.number", "d.answered_by", "d.answered_at", "d.asked_at"]).where("d.answer", "=", BACKLOG));
  for (const m of members) add(key(m as { repo: string; number: number }), m);
  return out;
}

/**
 * Starts a workflow for each open fast-track row: an issue's `implement`, a PR's `review`, for the person who fast-tracked it at
 * its weight, in the order added (the workflow id orders equal weights). Not when the item has a live workflow, its own or the
 * one whose implementation PR it is, or when a workflow of it started or a person sent it away after the row was added. Then
 * records each remaining open item a Backlog answer holds as a workflow in the backlog, which the automatic path leaves alone.
 */
async function startFastTracked(db: Db, r: SwitchReport, now: string): Promise<void> {
  const backlog = await backlogAnswers(db);
  const workflows = await all(db, q(db).selectFrom("main.item_workflows").select(["id", "repo", "number", "state", "entry", "started_at", "stopped_at"]).orderBy("id"));
  const of = new Map<string, Row[]>();
  for (const w of workflows) (of.get(key(w as never)) ?? of.set(key(w as never), []).get(key(w as never))!).push(w);
  const live = new Set(workflows.filter((w) => LIVE.includes(w.state as string)).map((w) => key(w as never)));
  const implementing = new Set(workflows.filter((w) => LIVE.includes(w.state as string) && w.entry === "implement").map((w) => key(w as never)));

  const rows = await all(db, q(db).selectFrom("main.fast_track as f").innerJoin("main.tracked_repos as t", "t.name", "f.repo")
    .innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number"))
    .select(["f.id", "f.repo", "f.number", "f.added_by", "f.added_at", "f.weight", "i.kind", "i.head_oid"]).where("i.state", "=", "OPEN").orderBy("f.id"));
  const prs = rows.filter((f) => f.kind === "pr");
  const issueOf = new Map<string, string>();
  if (prs.length) {
    const ims = await all(db, q(db).selectFrom("main.implementations").select(["repo", "number", "pr_number"]).where(kx.tupleIn(db, ["repo", "pr_number"], prs.map((f) => [f.repo, Number(f.number)]), ["text", "bigint"])));
    for (const im of ims) issueOf.set(`${im.repo}#${im.pr_number}`, key(im as never));
  }
  // Issues first: the PR of an issue that starts here goes with the issue.
  const start = async (kind: "issue" | "pr"): Promise<void> => {
    const entry = kind === "issue" ? "implement" : "review";
    for (const f of rows.filter((x) => (x.kind === "pr") === (kind === "pr"))) {
      const item = key(f as never);
      const why = live.has(item) ? "it has a live workflow"
        : issueOf.has(item) && implementing.has(issueOf.get(item)!) ? `it is the implementation of ${issueOf.get(item)}`
        : of.get(item)?.some((w) => w.started_at >= f.added_at || (w.stopped_at ?? "") >= f.added_at) ? "a workflow of it started or stopped later"
        : (backlog.get(item)?.at ?? "") > f.added_at ? "it was moved to the backlog later" : null;
      if (why) {
        r.fastTrackSkipped.push({ item, why });
        continue;
      }
      const weight = Number(f.weight);
      const got = await all(db, q(db).insertInto("main.item_workflows").values({
        repo: f.repo, number: Number(f.number), kind, entry, weight, state: "running", started_by: f.added_by, started_at: now, started_via: "cli",
        base_head: kind === "pr" ? f.head_oid : null, plan: "[]", updated_at: now,
      }).onConflict((oc: any) => oc.doNothing()).returning("id"));
      if (!got.length) {
        r.fastTrackSkipped.push({ item, why: "it has a live workflow" });
        continue;
      }
      const id = Number(got[0]!.id);
      live.add(item);
      if (entry === "implement") implementing.add(item);
      const parsed: Parsed = { kind: "commands", items: [], parts: [{ word: entry }, { word: "weight", weight }] };
      await run(db, q(db).insertInto("main.workflow_events").values({
        workflow_id: id, repo: f.repo, number: Number(f.number), login: f.added_by, via: "cli", kind: "started", parsed: JSON.stringify(parsed),
        line: `Started from the fast track at weight ${weight}.`, at: now,
      }));
      r.fastTrack.push({ item, entry, by: f.added_by, weight, workflow: id });
    }
  };
  await start("issue");
  await start("pr");

  const held = [...backlog].filter(([item, b]) => !live.has(item) && !of.get(item)?.some((w) => w.state === "stopped" || w.state === BACKLOG || w.started_at >= b.at));
  for (const part of kx.batches(held)) {
    const open = await all(db, q(db).selectFrom("main.items as i").innerJoin("main.tracked_repos as t", "t.name", "i.repo").select(["i.repo", "i.number", "i.kind"])
      .where("i.state", "=", "OPEN").where(kx.refIn(db, "i", part.map(([item]) => item))));
    if (!open.length) continue;
    const at = (i: Row): { by: string; at: string } => backlog.get(key(i as never))!;
    await run(db, q(db).insertInto("main.item_workflows").values(open.map((i) => ({
      repo: i.repo, number: Number(i.number), kind: i.kind, entry: i.kind === "pr" ? "review" : "implement", state: BACKLOG, started_by: at(i).by, started_at: at(i).at, started_via: "cli",
      plan: "[]", updated_at: now,
    }))));
    r.backlog += open.length;
  }
}

/** What the switch leaves to people: legs no workflow works, and answers nothing acted on. */
async function reportLeft(db: Db, r: SwitchReport): Promise<void> {
  const legs = await all(db, q(db).selectFrom("main.preapprovals as p").select(["p.repo", "p.number"]).where("p.state", "in", [...ACTIVE_LEG_STATES]).where("p.workflow_id", "is", null)
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.item_workflows as w").select(eb.lit(1).as("one")).whereRef("w.repo", "=", "p.repo").whereRef("w.number", "=", "p.number").where("w.state", "in", LIVE))))
    .orderBy("p.id").limit(LISTED));
  r.legsWithoutWorkflow = legs.map((l) => key(l as never));
  r.unapplied = (await all(db, q(db).selectFrom("main.decisions").select("id").where("answer", "is not", null).where("answer", "not in", [WITHDRAWN, BACKLOG]).where("applied_at", "is", null).orderBy("id").limit(LISTED)))
    .map((d) => d.id as string);
}

// The queue of card presses that wait for room under the daily GitHub write limit. A press that finds no room is not refused:
// the card stays with the presser's note and skipped steps, holds the lock of the decision it settles, and the Act step runs
// queued cards in order (item priority level, then the time of the press) once room returns, which is 00:00 UTC or an operator's
// raise of the limit. Waiting for room is the registered "Daily limit" wait (src/stages/registry.ts); no timer runs.
// Card writes and Act's closes share one count (src/conversations/usage.ts), held to the Act limit.
import { actLimit, actUsedToday } from "./usage.ts";
import { holdsIssues, type CardParams } from "./cards.ts";
import { RUNNING_STALE_MS } from "../answers/hold.ts";
import { actBlockedReason } from "../runner/autopilot.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import type { NotNull } from "kysely";

/** What a queued card needs to run later as the press would have run: the presser's choices at the time. */
export type QueueArgs = { skip?: number[]; note?: string; noteStaysOut?: boolean; role?: string };

const WRITE_STEPS_ONE = new Set(["comment", "label", "close", "unlabel", "reopen", "open_issue", "transfer", "assign", "request_reviewers"]);

/**
 * The GitHub writes a card makes when pressed: one per write step, two for a close that comes with a comment and for a duplicate close. Review and
 * fix-up steps start pipeline work and write nothing here; an issue the card holds until the merge is counted when it is filed (src/conversations/held.ts).
 */
export function cardWriteCount(params: CardParams, text: string | null): number {
  switch (params.kind) {
    case "comment": case "label": return 1;
    case "close": return text ? 2 : 1;
    case "duplicate": return 2;
    case "resolution": {
      const held = holdsIssues(params);
      return params.steps.reduce((n, s) => n + (s.kind === "duplicate" ? 2 : s.kind === "open_issue" && held ? 0 : WRITE_STEPS_ONE.has(s.kind) ? 1 : 0), 0);
    }
    default: return 0;
  }
}

/** The writes of cards that run now and have not made them yet: counted as used, so two presses at once cannot both take the last room. */
async function runningReserve(db: Db, ms: number): Promise<number> {
  const rows = await db.all(db.k.selectFrom("main.conversation_cards").select(["id", "params", "text", "acted_at"]).$narrowType<{ acted_at: NotNull }>()
    .where("state", "=", "running").where("acted_at", ">", new Date(ms - RUNNING_STALE_MS).toISOString()));
  const valid = (eb: kx.AnyEb) => eb.case().when(kx.jsonValid(db, "details")).then(eb.ref("details")).end();
  let n = 0;
  for (const r of rows) {
    let need = 0;
    try { need = cardWriteCount(JSON.parse(r.params) as CardParams, r.text); } catch { continue; }
    const written = (await db.get(db.k.selectFrom("main.audit").select((eb) => eb.fn.countAll<number>().as("n")).where((eb) => eb.and([
      eb(kx.jsonText(db, valid(eb), "$.source"), "=", "conversation"), eb(kx.jsonNum(db, valid(eb), "$.card"), "=", r.id),
      eb(kx.jsonText(db, valid(eb), "$.state"), "=", "done"), eb("at", ">=", r.acted_at)]))))!.n;
    n += Math.max(0, need - written);
  }
  return n;
}

/**
 * Room under the daily limit for `need` more card writes. A card larger than the whole limit runs on an empty day instead of waiting for ever.
 * Call it inside the transaction that claims the card, so the check and the claim are one step.
 */
export async function actRoom(db: Db, need: number, ms: number = Date.now()): Promise<boolean> {
  const limit = await actLimit(db);
  if (limit === null || need === 0) return true;
  const used = await actUsedToday(db, ms) + await runningReserve(db, ms);
  return used + need <= limit || (used === 0 && need > limit && limit > 0);
}

export type QueuedRow = { id: number; repo: string; number: number; queued_at: string; acted_by: string | null; dispute_by: string | null; dispute_reason: string | null; dispute_at: string | null };

/**
 * Queued cards in the order they run: higher item priority level first (security raised), then the earlier press. One query.
 * Cards whose repo the pipeline cannot run Act for now are left out, so they hold no place and block nobody; the drain asks for them with `all`.
 */
export async function queuedCards(db: Db, o: { all?: boolean } = {}): Promise<QueuedRow[]> {
  const rows = await queuedRows(db);
  if (o.all) return rows;
  const blocked = new Map<string, boolean>();
  return await filterSeq(rows, async (r) => {
    if (!blocked.has(r.repo)) blocked.set(r.repo, await actBlockedReason(db, r.repo) !== null);
    return !blocked.get(r.repo);
  });
}

async function queuedRows(db: Db): Promise<QueuedRow[]> {
  return await db.all(db.k.selectFrom("main.conversation_cards as c")
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "c.repo").onRef("r.number", "=", "c.number"))
    .select((eb) => ["c.id", "c.repo", "c.number", eb.fn.coalesce("c.queued_at", eb.val("")).as("queued_at"), "c.acted_by", "c.dispute_by", "c.dispute_reason", "c.dispute_at"])
    .where("c.state", "=", "queued")
    .orderBy((eb) => eb.fn.coalesce(eb.cast<number>(eb("r.score", "/", eb.lit(10000)), "bigint"), eb.lit(2)), "desc")
    .orderBy("c.queued_at", (o) => o.asc().nullsFirst()).orderBy("c.id"));
}

/** Places (from 1) of the queued cards that will run: a disputed press has none. Read once per request. */
export async function queuePlaces(db: Db, rows?: QueuedRow[]): Promise<Map<number, number>> {
  if (rows === undefined) rows = await queuedCards(db);
  const out = new Map<number, number>();
  for (const r of rows) if (!r.dispute_by) out.set(r.id, out.size + 1);
  return out;
}

/** 1-based place of the card in the queue, or null when it is not queued or is disputed. */
export const queuePlace = async (db: Db, cardId: number): Promise<number | null> => (await queuePlaces(db)).get(cardId) ?? null;

/** The shown reason of a queued press. The place is read when shown, never stored. */
export const queueReason = (place: number | null): string => (place === null ? "daily GitHub write limit" : `daily GitHub write limit, #${place} in line`);

/** Whether any card other than `except` waits in the queue (disputed ones are skipped by the drain and do not hold a place). */
export const queuedAhead = async (db: Db, except?: number): Promise<boolean> =>
  (await queuedCards(db)).some((r) => !r.dispute_by && r.id !== except);

/** Records a dispute of a queued press. False when the card is not queued, is the disputer's own, or is already disputed. */
export async function disputeCard(db: Db, id: number, by: string, reason: string, at: string): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("main.conversation_cards").set({ dispute_by: by, dispute_reason: reason, dispute_at: at })
    .where("id", "=", id).where("state", "=", "queued").where("dispute_by", "is", null).where((eb) => eb.not(kx.ciEq(db, "acted_by", eb.val(by)))))).changes) === 1;
}

export async function keepCard(db: Db, id: number): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("main.conversation_cards").set({ dispute_by: null, dispute_reason: null, dispute_at: null })
    .where("id", "=", id).where("state", "=", "queued").where("dispute_by", "is not", null))).changes) === 1;
}

/** The first undisputed queued card and what it needs, for the planner: it proposes the drain only when the head fits. */
export async function queueHead(db: Db): Promise<{ repo: string; fits: boolean } | null> {
  const head = (await queuedCards(db)).find((r) => !r.dispute_by);
  if (!head) return null;
  const c = (await db.get(db.k.selectFrom("main.conversation_cards").select(["params", "text", "queue_args"]).where("id", "=", head.id)))!;
  try { return { repo: head.repo, fits: await actRoom(db, needOf(c)) }; } catch { return { repo: head.repo, fits: true }; }
}

/** Writes the queued card still makes: the card's writes minus the steps the presser removed. */
export function needOf(c: { params: string; text: string | null; queue_args?: string | null }): number {
  const params = JSON.parse(c.params) as CardParams;
  const args = JSON.parse(c.queue_args ?? "{}") as QueueArgs;
  const left = params.kind === "resolution" && args.skip?.length ? { ...params, steps: params.steps.filter((_, k) => !args.skip!.includes(k)) } : params;
  return cardWriteCount(left, c.text);
}

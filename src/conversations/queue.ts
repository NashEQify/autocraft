// The queue of card presses that wait for room under the daily GitHub write limit. A press that finds no room is not refused:
// the card stays with the presser's note and skipped steps, and the Act step runs
// queued cards in order (item priority level, then the time of the press) once room returns, which is 00:00 UTC or an operator's
// raise of the limit. Waiting for room is the registered "Daily limit" wait (src/stages/registry.ts); no timer runs.
// Card writes and Act's closes share one count (src/conversations/usage.ts), held to the Act limit.
import { holdsIssues, type CardParams } from "./cards.ts";
import { loadActRoom, loadQueue, type ActRoom } from "../data/conversations/index.ts";
import type { Db } from "../db/index.ts";

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

/** Writes the queued card still makes: the card's writes minus the steps the presser removed. */
export function needOf(c: { params: string; text: string | null; queue_args?: string | null }): number {
  const params = JSON.parse(c.params) as CardParams;
  const args = JSON.parse(c.queue_args ?? "{}") as QueueArgs;
  const left = params.kind === "resolution" && args.skip?.length ? { ...params, steps: params.steps.filter((_, k) => !args.skip!.includes(k)) } : params;
  return cardWriteCount(left, c.text);
}

/**
 * Whether `room` (the limit, the count used and the cards running now) leaves space for `need` more card writes. Cards that run now and have not
 * made their writes yet count as used, so two presses at once cannot both take the last room. A card larger than the whole limit runs on an empty
 * day instead of waiting for ever.
 */
export function roomFor(room: ActRoom, need: number): boolean {
  if (room.limit === null || need === 0) return true;
  const used = room.used + room.running.reduce((n, r) => { try { return n + Math.max(0, needOf(r) - r.written); } catch { return n; } }, 0);
  return used + need <= room.limit || (used === 0 && need > room.limit && room.limit > 0);
}

/** Room under the daily limit for `need` more card writes. Call it inside the transaction that claims the card, so the check and the claim are one step. */
export async function actRoom(db: Db, need: number, ms: number = Date.now()): Promise<boolean> {
  return roomFor(await loadActRoom(db, new Date(ms)), need);
}

export type QueuedRow = { id: number; repo: string; number: number; queued_at: string; acted_by: string | null; place: number };

/**
 * Queued cards in the order they run: higher item priority level first (security raised), then the earlier press. One wave.
 * Cards whose repo the pipeline cannot run Act for now are left out, so they hold no place and block nobody; the drain asks for them with `all`.
 */
export async function queuedCards(db: Db, o: { all?: boolean } = {}): Promise<QueuedRow[]> {
  return (await loadQueue(db, o)).rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, queued_at: r.queued_at ?? "", acted_by: r.acted_by, place: r.place }));
}

/** Places (from 1) of the queued cards that will run. Read once per request. */
export async function queuePlaces(db: Db, rows?: QueuedRow[]): Promise<Map<number, number>> {
  return new Map((rows ?? await queuedCards(db)).map((r) => [r.id, r.place]));
}

/** 1-based place of the card in the queue, or null when it is not queued. */
export const queuePlace = async (db: Db, cardId: number): Promise<number | null> => (await queuePlaces(db)).get(cardId) ?? null;

/** The shown reason of a queued press. The place is read when shown, never stored. */
export const queueReason = (place: number | null): string => (place === null ? "daily GitHub write limit" : `daily GitHub write limit, #${place} in line`);

/** Whether any card other than `except` waits in the queue. */
export const queuedAhead = async (db: Db, except?: number): Promise<boolean> =>
  (await queuedCards(db)).some((r) => r.id !== except);

/** The first queued card and what it needs, for the planner: it proposes the drain only when the head fits. */
export async function queueHead(db: Db): Promise<{ repo: string; fits: boolean } | null> {
  const [queue, room] = await db.together(() => Promise.all([loadQueue(db), loadActRoom(db, new Date())]));
  const head = queue.rows[0];
  if (!head) return null;
  try { return { repo: head.repo, fits: roomFor(room, needOf(head)) }; } catch { return { repo: head.repo, fits: true }; }
}

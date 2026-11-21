// One answer per question. While a conversation card settles a decision, the decision is locked ("settling"); once it is answered
// and before the pipeline applies it, another person can dispute it ("disputed") instead of answering again. Both states live in
// decisions.exec_state; the pipeline reads a disputed answer as no answer (see settlers.ts).
import { BACKLOG, getDecision, optionsOf, type DecisionRow, type Kind } from "../decisions.ts";
import { audit } from "../dash/audit.ts";
import { settledBy, settledByExpr, settledBySql } from "../settlers.ts";
import { writeEffect } from "../act/index.ts";
import { queuePlace } from "../conversations/queue.ts";
import { findSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { ciEq, distinctFrom } from "../db/portable.ts";
import * as kx from "../db/kx.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";

export const SETTLING = "settling";
export const DISPUTED = "disputed";

/** A card that has run longer than this is taken as crashed (conversations/act.ts marks it failed). */
export const RUNNING_STALE_MS = 10 * 60_000;

/**
 * SQL: the lock of `t` (a decisions table or alias) is live: its card is still running and not stale, or is queued for room under the
 * daily GitHub write limit. A lock whose card ended or died counts for nothing, so no path has to clear it for the decision to be answerable.
 */
export const lockLiveSql = (t = "decisions", now: Date = new Date()): string =>
  // CASE, not AND: in a select list SQLite evaluates both sides of AND, and the card scan would run for every row.
  `(CASE WHEN ${t}.exec_state = '${SETTLING}' THEN EXISTS (SELECT 1 FROM main.conversation_cards lc WHERE (lc.state = 'queued' OR (lc.state = 'running' AND lc.acted_at > '${new Date(now.getTime() - RUNNING_STALE_MS).toISOString()}')) AND ${t}.exec_reason LIKE lc.id || ':%') ELSE FALSE END)`;

/** `lockLiveSql` as an expression (`t`: the decisions table name or alias in the caller's query). */
export function lockLiveExpr(db: Db, eb: kx.AnyEb, t = "decisions", now: Date = new Date()): AliasableExpression<SqlBool> {
  const since = new Date(now.getTime() - RUNNING_STALE_MS).toISOString();
  return eb.case().when(eb.ref(`${t}.exec_state`), "=", SETTLING).then(eb.exists(kx.schemaEb(eb).selectFrom("main.conversation_cards as lc").select(eb.lit(1).as("one"))
    .where((w) => w.or([w("lc.state", "=", "queued"), w.and([w("lc.state", "=", "running"), w("lc.acted_at", ">", since)])]))
    .where(kx.like(db, eb.ref(`${t}.exec_reason`), eb(eb.ref("lc.id"), "||", eb.val(":%"))))))
    .else(eb.lit(false)).end();
}

/** SQL: when the running card that holds the lock of `t` started (its lock is not live from RUNNING_STALE_MS later); null when no running card holds it. */
export const lockRunningAtSql = (t = "decisions"): string =>
  `(CASE WHEN ${t}.exec_state = '${SETTLING}' THEN (SELECT max(lc.acted_at) FROM main.conversation_cards lc WHERE lc.state = 'running' AND ${t}.exec_reason LIKE lc.id || ':%') END)`;

/** `lockRunningAtSql` as an expression. */
export function lockRunningAtExpr(db: Db, eb: kx.AnyEb, t = "decisions"): AliasableExpression<string | null> {
  return eb.case().when(eb.ref(`${t}.exec_state`), "=", SETTLING).then(kx.schemaEb(eb).selectFrom("main.conversation_cards as lc").select((s) => s.fn.max("lc.acted_at").as("at"))
    .where("lc.state", "=", "running").where(kx.like(db, eb.ref(`${t}.exec_reason`), eb(eb.ref("lc.id"), "||", eb.val(":%"))))).end();
}

/** The login of the person whose card is settling an open decision right now, or null. */
export async function settlingBy(db: Db, d: Pick<DecisionRow, "id" | "answer" | "exec_state" | "exec_reason">): Promise<string | null> {
  if (d.answer !== null || d.exec_state !== SETTLING) return null;
  if (!await db.get(db.k.selectFrom("main.decisions").select("id").where("id", "=", d.id).where((eb) => lockLiveExpr(db, eb, "decisions")))) return null;
  const r = d.exec_reason ?? "";
  return r.slice(r.indexOf(":") + 1) || "someone";
}

export const settlingMessage = (by: string): string => `${by} is applying their answer`;

/** The queued card that holds the open decision's lock, if any. */
export async function queuedLock(db: Db, d: Pick<DecisionRow, "id" | "exec_state" | "exec_reason">): Promise<number | null> {
  if (d.exec_state !== SETTLING) return null;
  const id = Number((d.exec_reason ?? "").split(":")[0]);
  if (!Number.isInteger(id)) return null;
  return await db.get(db.k.selectFrom("main.conversation_cards").select("id").where("id", "=", id).where("state", "=", "queued")) ? id : null;
}

/** Why an answer to the locked decision is refused: a card is running, or the press waits for room (the place is read now). */
export async function lockMessage(db: Db, d: DecisionRow): Promise<string> {
  const by = await settlingBy(db, d) ?? "someone";
  const card = await queuedLock(db, d);
  if (card === null) return settlingMessage(by);
  const place = await queuePlace(db, card);
  return `${by}'s answer waits for the daily GitHub write limit${place ? ` (#${place})` : ""}`;
}

/**
 * Claims the open decision for the card inside the transaction that queues the card or starts its run. A lock the card already holds
 * (it was queued) is taken over. Throws when another live card holds it. A decision that is answered or missing is left alone: the run reports "the decision changed".
 */
export async function claimSettling(db: Db, decisionId: string, cardId: number, login: string): Promise<void> {
  const r = await db.run(db.k.updateTable("main.decisions").set({ exec_state: SETTLING, exec_reason: `${cardId}:${login}` })
    .where("id", "=", decisionId).where("answer", "is", null)
    .where((eb) => eb.or([eb.not(lockLiveExpr(db, eb, "decisions")), eb.and([eb("exec_state", "=", SETTLING), kx.like(db, "exec_reason", eb.val(`${cardId}:%`))])])));
  if (r.changes === 1) return;
  const d = await getDecision(db, decisionId);
  if (d && await settlingBy(db, d)) throw new Error(await lockMessage(db, d));
}

/** Clears the lock of the card. The answer's own exec state replaces it when the card answered the decision. */
export async function releaseSettling(db: Db, decisionId: string, cardId: number): Promise<void> {
  await db.run(db.k.updateTable("main.decisions").set({ exec_state: null, exec_reason: null }).where("id", "=", decisionId).where("exec_state", "=", SETTLING)
    .where((eb) => kx.like(db, "exec_reason", eb.val(`${cardId}:%`))));
}

/** Locks left by a card that no longer runs (a crashed process). A queued card keeps its lock. */
export async function sweepSettling(db: Db): Promise<number> {
  return Number((await db.run(db.k.updateTable("main.decisions").set({ exec_state: null, exec_reason: null }).where("exec_state", "=", SETTLING)
    .where((eb: kx.AnyEb) => eb.not(eb.exists(kx.schemaEb(eb).selectFrom("main.conversation_cards as c").select(eb.lit(1).as("one")).where("c.state", "in", ["running", "queued"])
      .where(kx.like(db, eb.ref("decisions.exec_reason"), eb(eb.ref("c.id"), "||", eb.val(":%"))))))))).changes);
}

export const isDisputed = (d: Pick<DecisionRow, "exec_state" | "answer" | "applied_at">): boolean => d.exec_state === DISPUTED && d.answer !== null && !d.applied_at;

/**
 * The answered decision on the item whose GitHub write the pipeline has not made yet and still will: someone chose, GitHub does not show it yet.
 * Backlog only holds, an option without a write (take, small-extra, need-info) leaves nothing to race, and an answer whose answerer no longer
 * settles is not carried out.
 */
export async function pendingAnswerOn(db: Db, repo: string, number: number): Promise<DecisionRow | null> {
  const rows = await db.all(db.k.selectFrom("main.decisions").select(kx.cols("main.decisions")).$narrowType<{ kind: Kind }>().where("repo", "=", repo).where("number", "=", number)
    .where("answer", "is not", null).where("applied_at", "is", null).where("answer", "<>", BACKLOG.key)
    .where((eb) => eb.not(kx.like(db, "id", eb.val("%~replaced-%"))))
    .orderBy("answered_at", (o) => o.desc().nullsLast()));
  return await findSeq(rows, async (d) => writeEffect(d.kind, d.answer!) !== null && (isDisputed(d) || await settledBy(db, d))) ?? null;
}

/** The reason a card of `by` that writes to the item must not run, or null. */
export async function pendingAnswerRefusal(db: Db, repo: string, number: number, by: string): Promise<string | null> {
  const d = await pendingAnswerOn(db, repo, number);
  if (!d) return null;
  const label = optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer;
  if (isDisputed(d)) return `${d.answered_by}'s answer "${label}" is disputed by ${d.dispute_by}; it has to be kept or undone first`;
  if (d.answered_by?.toLowerCase() === by.toLowerCase()) return `You already answered "${d.question}" with "${label}". Undo your answer first`;
  return `${d.answered_by} already answered "${d.question}" with "${label}"; dispute that answer to change it`;
}

/** True while any answer on the item is disputed: no pipeline write for the item goes ahead. */
export async function disputeOn(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("main.decisions").select("id").where("repo", "=", repo).where("number", "=", number).where("exec_state", "=", DISPUTED)
    .where("answer", "is not", null).where("applied_at", "is", null).limit(1));
}

/** Records the dispute. False when the decision is no longer disputable (answered by the disputer, applied, running or already disputed). */
export async function openDispute(db: Db, id: string, by: string, reason: string, at: string): Promise<boolean> {
  const r = await db.run(db.k.updateTable("main.decisions").set({ exec_state: DISPUTED, exec_reason: null, dispute_by: by, dispute_reason: reason, dispute_at: at })
    .where("id", "=", id).where("answer", "is not", null).where("applied_at", "is", null).where("answer", "<>", BACKLOG.key)
    .where((eb) => eb.not(kx.ciEq(db, "answered_by", eb.val(by))))
    .where((eb) => eb.or([eb("exec_state", "is", null), eb("exec_state", "in", ["pending", "waiting-token", "waiting-permission", "failed"])])));
  if (r.changes !== 1) return false;
  await audit(db, by, "dispute", id, { reason });
  return true;
}

export async function clearDispute(db: Db, id: string): Promise<void> {
  await db.run(db.k.updateTable("main.decisions").set({ exec_state: null, exec_reason: null, dispute_by: null, dispute_reason: null, dispute_at: null })
    .where("id", "=", id).where("exec_state", "=", DISPUTED));
}

/**
 * SQL (decisions unaliased): an answered, unapplied decision the viewer has to look at: a disputed one (the answerer, or any operator), or one an
 * operator has to reassign because its answerer no longer settles and its option writes to GitHub.
 */
export function heldOpenSql(db: Db, login: string, operator: boolean): string {
  const me = `'${login.replace(/'/g, "''")}'`;
  const writes = `((decisions.answer = 'close' AND decisions.kind IN ('scope', 'close', 'duplicate', 'merge', 'hold')) OR (decisions.answer = 'merge' AND decisions.kind = 'merge')
    OR (decisions.kind = 'duplicate' AND (decisions.answer = 'accept' OR decisions.answer LIKE 'keep:%')))`;
  // An open decision whose queued press someone disputed: the presser and operators look at it.
  const queuedDispute = `(decisions.answer IS NULL AND decisions.exec_state = '${SETTLING}' AND EXISTS (SELECT 1 FROM main.conversation_cards hc WHERE hc.state = 'queued' AND hc.dispute_by IS NOT NULL
    AND decisions.exec_reason LIKE hc.id || ':%' AND ${operator ? "TRUE" : ciEq(db, "hc.acted_by", me)}))`;
  return `(${queuedDispute} OR decisions.answer IS NOT NULL AND decisions.applied_at IS NULL AND decisions.answer <> '${BACKLOG.key}' AND decisions.id NOT LIKE '%~replaced-%'
    AND ((decisions.exec_state = '${DISPUTED}' AND ${operator ? "TRUE" : ciEq(db, "decisions.answered_by", me)})
      OR (${operator ? "TRUE" : "FALSE"} AND ${distinctFrom(db, "decisions.exec_state", `'${DISPUTED}'`)} AND decisions.answered_by IS NOT NULL AND decisions.answered_by <> 'pipeline' AND ${writes} AND NOT ${settledBySql(db, "decisions")})))`;
}

/** `heldOpenSql` as an expression; `a` names the decisions table in the caller's query. */
export function heldOpenExpr(db: Db, eb: kx.AnyEb, login: string, operator: boolean, a = "decisions"): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb);
  const c = (col: string) => eb.ref(`${a}.${col}`);
  const writes = eb.or([
    eb.and([eb(c("answer"), "=", "close"), eb(c("kind"), "in", ["scope", "close", "duplicate", "merge", "hold"])]),
    eb.and([eb(c("answer"), "=", "merge"), eb(c("kind"), "=", "merge")]),
    eb.and([eb(c("kind"), "=", "duplicate"), eb.or([eb(c("answer"), "=", "accept"), kx.like(db, c("answer"), eb.val("keep:%"))])]),
  ]);
  // An open decision whose queued press someone disputed: the presser and operators look at it.
  const queuedDispute = eb.and([eb(c("answer"), "is", null), eb(c("exec_state"), "=", SETTLING), eb.exists(t.selectFrom("main.conversation_cards as hc").select(eb.lit(1).as("one"))
    .where("hc.state", "=", "queued").where("hc.dispute_by", "is not", null)
    .where(kx.like(db, c("exec_reason"), eb(eb.ref("hc.id"), "||", eb.val(":%"))))
    .$if(!operator, (q) => q.where((w) => kx.ciEq(db, "hc.acted_by", w.val(login)))))]);
  const reassign = operator ? [eb.and([eb(c("exec_state"), "is distinct from", DISPUTED), eb(c("answered_by"), "is not", null), eb(c("answered_by"), "<>", "pipeline"), writes,
    eb.not(settledByExpr(db, eb, a))])] : [];
  return eb.or([queuedDispute, eb.and([eb(c("answer"), "is not", null), eb(c("applied_at"), "is", null), eb(c("answer"), "<>", BACKLOG.key), eb.not(kx.like(db, c("id"), eb.val("%~replaced-%"))),
    eb.or([eb.and([eb(c("exec_state"), "=", DISPUTED), ...(operator ? [] : [kx.ciEq(db, c("answered_by"), eb.val(login))])]), ...reassign])])]);
}

// A review made again at the same head commit replaces the one a "Merge this PR?" decision was asked from.
import { audit } from "../dash/audit.ts";
import { clearAskedStage } from "../decisions.ts";
import { holdDecisionId, mergeDecisionId, type QueueEntry } from "./queue.ts";
import { openGroupExpr } from "../core/rule-queries.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Answer value of a question the pipeline set aside; no operator wrote it, so no later step acts on it. */
export const WITHDRAWN = "withdrawn";

/** Renames a decision and what hangs on its id, freeing the id for a new question. */
async function renameDecision(db: Db, id: string, to: string): Promise<void> {
  await db.run(db.k.updateTable("decisions").set({ id: to }).where("id", "=", id));
  await db.run(db.k.updateTable("decision_opinions").set({ decision_id: to }).where("decision_id", "=", id));
  await db.run(db.k.updateTable("decision_comments").set({ decision_id: to }).where("decision_id", "=", id));
  await db.run(db.k.updateTable("decision_claims").set({ decision_id: to }).where("decision_id", "=", id));
}

/** Answers the still-open decision `id` "withdrawn" by the pipeline, applied at once, with `note`. */
async function closeWithdrawn(db: Db, at: string, note: string, id: string): Promise<void> {
  await db.run(db.k.updateTable("main.decisions")
    .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: note, adopted_opinion: null })
    .where("id", "=", id).where("answer", "is", null));
}

/**
 * Sets the head's merge decision aside, answered or not, by renaming it (and what hangs on its id) so it no longer
 * matches the PR: the question is asked again from the new review and an earlier "merge" answer does not count.
 * The old row stays for the record and is closed: an open one is answered "withdrawn" by the pipeline, an
 * answered one that was not acted on yet is marked applied with a note.
 */
export async function withdrawMergeQuestion(db: Db, repo: string, number: number, head: string, at: string, why = "superseded by a new review"): Promise<boolean> {
  return await setAside(db, mergeDecisionId(repo, number, head), repo, number, head, at, why, (a) => a !== "merge");
}

/** Sets the head's Hold question aside the same way. A close answer waiting for Act still stands. */
export async function withdrawHoldQuestion(db: Db, repo: string, number: number, head: string, at: string, why = "superseded by a new review"): Promise<boolean> {
  return await setAside(db, holdDecisionId(repo, number, head), repo, number, head, at, why, (a) => a === "close");
}

async function setAside(db: Db, id: string, repo: string, number: number, head: string, at: string, why: string, stands: (answer: string) => boolean): Promise<boolean> {
  const row = await db.get(db.k.selectFrom("decisions").select(["answer", "applied_at"]).where("id", "=", id));
  // An answer that waits for Act and does not depend on the review still stands: the new review doesn't change it.
  if (!row || (row.answer !== null && stands(row.answer) && !row.applied_at)) return false;
  const old = `${id}~replaced-${at}`;
  return await db.write(async () => {
    await renameDecision(db, id, old);
    if (row.answer === null) {
      await db.run(db.k.updateTable("main.decisions")
        .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: why }).where("id", "=", old));
      await audit(db, "pipeline", "merge-question-withdrawn", old, { repo, number, head });
    } else if (!row.applied_at) {
      await db.run(db.k.updateTable("main.decisions")
        .set((eb) => ({ applied_at: at, answer_note: eb(eb.fn.coalesce(eb("answer_note", "||", eb.val(" — ")), eb.val("")), "||", eb.val(`${why}; the answer was not applied`)) }))
        .where("id", "=", old));
      await audit(db, "pipeline", "merge-answer-superseded", old, { repo, number, head, answer: row.answer });
    }
    return true;
  });
}

/**
 * Sets aside the Merge? decisions of PRs a maintainer's "changes requested" review blocks; they are asked again if the
 * block clears. Only an open question or an unapplied merge answer is touched: a hold or close answer stands.
 */
export async function withdrawBlockedQuestions(db: Db, queue: QueueEntry[], at: string): Promise<number> {
  let n = 0;
  for (const e of queue) {
    // A block seen only in the mirror may be wrong (the association is relative to the viewer): wait for a live read.
    if (e.state !== "changes-requested" || !e.blockedLive || !e.decisionId) continue;
    const row = await db.get(db.k.selectFrom("decisions").select(["answer", "applied_at"]).where("id", "=", e.decisionId));
    if (!row || (row.answer !== null && (row.answer !== "merge" || row.applied_at))) continue;
    if (await withdrawMergeQuestion(db, e.repo, e.number, e.head, at)) n++;
  }
  return n;
}

/** Why a Merge? question is set aside while its PR is in an open duplicate group. */
export const IN_GROUP_NOTE = "set aside while the PR is in a duplicate group";

/**
 * Sets aside the open Merge? decision (or unapplied merge answer) of every PR that is a member of an open duplicate
 * group decision, so an item has one current decision. The PR that stays open is asked again after the group is answered.
 */
export async function withdrawGroupedQuestions(db: Db, at: string, repo?: string): Promise<number> {
  const rows = await db.all(db.k.selectFrom("decisions as m").distinct()
    .innerJoin("dupe_group_items as gi", (j) => j.onRef("gi.repo", "=", "m.repo").onRef("gi.number", "=", "m.number"))
    .innerJoin("decisions as g", (j) => j.onRef("g.id", "=", "gi.decision_id").on("gi.role", "<>", "stay"))
    .select(["m.repo", "m.number", "m.id"])
    .where((eb) => eb.and([
      openGroupExpr(db, eb), eb("m.kind", "=", "merge"), eb.not(kx.like(db, "m.id", eb.val("%~replaced-%"))),
      eb.or([eb("m.answer", "is", null), eb.and([eb("m.answer", "=", "merge"), eb("m.applied_at", "is", null)])]),
    ]))
    .$if(!!repo, (q) => q.where("m.repo", "=", repo!))
    .$narrowType<{ repo: string; number: number }>());
  let n = 0;
  for (const r of rows) {
    const head = r.id.slice(r.id.indexOf(":merge@") + ":merge@".length);
    if (mergeDecisionId(r.repo, r.number, head) === r.id && await withdrawMergeQuestion(db, r.repo, r.number, head, at, IN_GROUP_NOTE)) n++;
  }
  return n;
}

/** Closes the PR's open Merge? questions at every head once it merged, whatever path merged it. */
export async function closeMergedQuestions(db: Db, repo: string, number: number, at: string): Promise<void> {
  await db.run(db.k.updateTable("main.decisions")
    .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: "the PR merged" })
    .where("kind", "=", "merge").where("repo", "=", repo).where("number", "=", number).where("answer", "is", null));
}

/** Sets aside the PR's unanswered Merge? questions at heads other than the one just asked about. */
export async function withdrawOtherHeadQuestions(db: Db, repo: string, number: number, keepHead: string, at: string): Promise<void> {
  const prefix = `${repo}#${number}:merge@`;
  const rows = await db.all(db.k.selectFrom("decisions").select("id")
    .where("repo", "=", repo).where("number", "=", number).where("kind", "=", "merge").where("answer", "is", null)
    .where((eb) => eb(eb.fn<string>("substr", ["id", eb.val(1), eb.val(prefix.length)]), "=", prefix))
    .where((eb) => eb.not(kx.like(db, "id", eb.val("%~replaced-%")))));
  for (const r of rows) {
    const head = r.id.slice(prefix.length);
    if (head !== keepHead) await withdrawMergeQuestion(db, repo, number, head, at, "superseded by a question at a newer head");
  }
}

/** Why a scope answer by a maintainer is set aside once it no longer counts. */
const LAPSED_NOTE = "the maintainer's answer no longer counts";

/**
 * Sets aside the answered scope decision `id` whose maintainer answer no longer counts (src/settlers.ts): the row is renamed
 * (`<id>~lapsed-<at>`) with its answer, note and answerer kept and marked applied, so the id is free for a fresh question.
 * Returns false when there is no answered row.
 */
export async function setAsideLapsedScope(db: Db, id: string, at: string): Promise<boolean> {
  const row = await db.get(db.k.selectFrom("decisions").select(["repo", "number", "answer"])
    .where("id", "=", id).where("kind", "=", "scope").where("answer", "is not", null)
    .$narrowType<{ answer: string }>());
  if (!row) return false;
  const old = `${id}~lapsed-${at}`;
  await db.write(async () => {
    await renameDecision(db, id, old);
    await db.run(db.k.updateTable("main.decisions")
      .set((eb) => ({ applied_at: eb.fn.coalesce("applied_at", eb.val(at)), answer_note: eb(eb.fn.coalesce(eb("answer_note", "||", eb.val(" — ")), eb.val("")), "||", eb.val(LAPSED_NOTE)) }))
      .where("id", "=", old));
    await audit(db, "pipeline", "scope-answer-lapsed", old, { repo: row.repo, number: row.number, answer: row.answer });
  });
  return true;
}

/** Why a question is set aside for a newer one. */
const NEWER_NOTE = "superseded by a newer question about the item";

/** Why a Merge? or Close? question is set aside once its PR's head moved on. */
const HEAD_MOVED_NOTE = "the pull request changed since";

/**
 * Sets aside open Merge? and Close? questions asked at a head that is no longer the PR's head in the mirror: the merge queue
 * and Act read only the current head's id, so an answer to the old one has no effect. Answered decisions are not touched.
 */
async function setAsideOldHeadQuestions(db: Db, at: string, repo?: string): Promise<number> {
  const rows = await db.all(db.k.selectFrom("decisions as d")
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
    .select(["d.id", "d.kind", "d.repo", "d.number"])
    .where((eb) => {
      const idOf = (tail: string) => eb(eb(eb(eb(eb.ref("d.repo"), "||", eb.val("#")), "||", kx.exprOf(eb, "d.number")), "||", eb.val(":")), "||", eb("d.kind", "||", eb.val(tail)));
      return eb.and([
        eb("d.answer", "is", null), eb("d.kind", "in", ["merge", "close", "hold"]), eb.not(kx.like(db, "d.id", eb.val("%~replaced-%"))),
        eb("i.kind", "=", "pr"), eb("i.head_oid", "is not", null),
        eb("d.id", "<>", eb(idOf("@"), "||", eb.ref("i.head_oid"))), kx.like(db, "d.id", idOf("@%")),
      ]);
    })
    .$if(!!repo, (q) => q.where("d.repo", "=", repo!)));
  if (!rows.length) return 0;
  await db.write(async () => {
    for (const r of rows) {
      const old = `${r.id}~replaced-${at}`;
      await renameDecision(db, r.id, old);
      await closeWithdrawn(db, at, HEAD_MOVED_NOTE, old);
      await audit(db, "pipeline", "decision-withdrawn", old, { repo: r.repo, number: r.number, kind: r.kind, why: HEAD_MOVED_NOTE });
    }
  });
  return rows.length;
}

/**
 * An item has at most one open single-item decision: of its open scope, merge and close questions the newest asked stays
 * and the others are set aside (renamed like a superseded Merge? question, so an answer to them never counts). A set-aside
 * scope question keeps its stages row, so Decide does not ask it again. Merge? and Close? questions at a head the PR has
 * moved past are set aside too. Returns how many were set aside. Idempotent.
 */
export async function setAsideSupersededQuestions(db: Db, at: string, repo?: string): Promise<number> {
  const stale = await setAsideOldHeadQuestions(db, at, repo);
  const rows = await db.all(db.k.selectFrom("decisions").select(["id", "kind", "repo", "number"])
    .where("answer", "is", null).where("number", "is not", null).where("kind", "in", ["scope", "merge", "close", "hold"])
    .where((eb) => eb.and([eb.not(kx.like(db, "id", eb.val("%:dupegroup:%"))), eb.not(kx.like(db, "id", eb.val("%~replaced-%")))]))
    .$if(!!repo, (q) => q.where("repo", "=", repo!))
    .orderBy("asked_at", "desc").orderBy(kx.rowid("decisions"), "desc")
    .$narrowType<{ number: number }>());
  const seen = new Set<string>();
  const aside: { r: (typeof rows)[number]; why: string }[] = [];
  for (const r of rows) {
    const k = `${r.repo}#${r.number}`;
    if (seen.has(k)) aside.push({ r, why: NEWER_NOTE });
    else seen.add(k);
  }
  if (!aside.length) return stale;
  await db.write(async () => {
    for (const { r, why } of aside) {
      const old = `${r.id}~replaced-${at}`;
      await renameDecision(db, r.id, old);
      await closeWithdrawn(db, at, why, old);
      await audit(db, "pipeline", "decision-withdrawn", old, { repo: r.repo, number: r.number, kind: r.kind, why });
    }
  });
  return stale + aside.length;
}

const closedWhy = (r: { state: string; itemKind: string }): string => r.state === "MERGED" ? "the pull request was merged" : `the ${r.itemKind === "pr" ? "pull request" : "issue"} was closed on GitHub`;

/**
 * Withdraws the open scope, merge, close and (single-item) duplicate questions of items that are closed or merged in the
 * mirror, and an open duplicate-group question with fewer than two open members. The row is answered "withdrawn" by the
 * pipeline with the reason as its note and audited; nothing is written to GitHub. A single-item question is renamed like
 * a superseded Merge? question, so an item that reopens is asked again under the same id; a scope question also loses
 * the stages row Decide wrote, so the item counts as never asked. Idempotent: it writes only when something is left to withdraw.
 */
export async function withdrawClosedQuestions(db: Db, at: string): Promise<number> {
  const single = await db.all(db.k.selectFrom("decisions as d")
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
    .select(["d.id", "d.kind", "d.repo", "d.number", "i.state", "i.kind as itemKind"])
    .where("d.answer", "is", null).where("d.number", "is not", null).where("d.kind", "in", ["scope", "close", "merge", "hold", "duplicate"])
    .where((eb) => eb.and([eb.not(kx.like(db, "d.id", eb.val("%:dupegroup:%"))), eb.not(kx.like(db, "d.id", eb.val("%~replaced-%")))]))
    .where("i.state", "in", ["CLOSED", "MERGED"])
    .$narrowType<{ number: number }>());
  const groups = await db.all(db.k.selectFrom("decisions as d").select(["d.id", "d.kind", "d.repo", "d.number"])
    .where("d.answer", "is", null).where("d.kind", "=", "duplicate")
    .where((eb) => eb.and([
      kx.like(db, "d.id", eb.val("%:dupegroup:%")), eb.not(kx.like(db, "d.id", eb.val("%~replaced-%"))),
      eb(eb.selectFrom("dupe_group_items as gi")
        .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "gi.repo").onRef("i.number", "=", "gi.number"))
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("gi.decision_id", "=", "d.id").where("i.state", "=", "OPEN"), "<", 2),
    ])));
  if (!single.length && !groups.length) return 0;
  const clear = clearAskedStage(db);
  await db.write(async () => {
    for (const r of single) {
      const old = `${r.id}~replaced-${at}`;
      await renameDecision(db, r.id, old);
      const why = closedWhy(r);
      await closeWithdrawn(db, at, why, old);
      if (r.kind === "scope") await clear(r.repo!, r.number, r.id);
      await audit(db, "pipeline", "decision-withdrawn", old, { repo: r.repo, number: r.number, kind: r.kind, why });
    }
    for (const r of groups) {
      const why = "the duplicate group has one open item left";
      await closeWithdrawn(db, at, why, r.id);
      await audit(db, "pipeline", "decision-withdrawn", r.id, { kind: r.kind, why });
    }
  });
  return single.length + groups.length;
}

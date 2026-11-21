// Answers that can no longer be applied are closed out, so they neither linger as "waiting" nor block the question.
import { BACKLOG, factsOf, type DecisionRow, type Kind } from "../decisions.ts";
import { HEAD_FACT } from "../core/rules.ts";
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

const ACTOR = "pipeline";

/** Why the answer can no longer be applied (the item is gone from open, or a Merge/Close answer was given for another head), or null. */
async function staleReason(db: Db, d: DecisionRow): Promise<string | null> {
  if (d.repo === null || d.number === null) return null;
  const it = await db.get(db.k.selectFrom("main.items").select(["state", "head_oid"]).where("repo", "=", d.repo).where("number", "=", d.number));
  if (!it) return null;
  if (it.state === "MERGED") return "the PR merged";
  if (it.state === "CLOSED") return "the item is closed";
  if (d.kind === "merge" || d.kind === "close" || d.kind === "hold") {
    const f = factsOf(d).find((x) => x.startsWith(HEAD_FACT));
    const head = f ? f.slice(HEAD_FACT.length).trim() : null;
    if (head && it.head_oid && head !== it.head_oid) return "the PR changed after the answer";
  }
  return null;
}

/** The PR merged at the head the answer was given for, alone or inside a merged batch: the answer was carried out, only its row was not closed. */
async function mergedAtHead(db: Db, d: DecisionRow): Promise<boolean> {
  if (d.kind !== "merge") return false;
  const f = factsOf(d).find((x) => x.startsWith(HEAD_FACT));
  const head = f ? f.slice(HEAD_FACT.length).trim() : null;
  if (!head || !d.repo || d.number === null) return false;
  return !!await db.get(db.k.selectFrom("main.merges").select("repo").where("repo", "=", d.repo).where("number", "=", d.number).where("head_oid", "=", head).where("outcome", "=", "merged"))
    || !!await db.get(db.k.selectFrom("main.merge_batch_prs as x").innerJoin("main.merge_batches as b", "b.id", "x.batch_id").select("x.number")
      .where("b.repo", "=", d.repo).where("x.number", "=", d.number).where("x.head_oid", "=", head).where("b.state", "=", "merged"));
}

/** Marks answered, unapplied single-item decisions of `repo` (all repos when omitted) that can no longer apply as applied, with a note. Returns how many. */
export async function sweepStaleAnswers(db: Db, at: string, repo?: string): Promise<number> {
  const rows = await db.all(db.k.selectFrom("main.decisions").select(kx.cols("main.decisions")).$narrowType<{ kind: Kind }>().where("answer", "is not", null).where("applied_at", "is", null)
    .where("answer", "<>", BACKLOG.key).where("answered_by", "<>", ACTOR).where("repo", "is not", null).where("number", "is not", null)
    .where((eb) => eb.and([eb.not(kx.like(db, "id", eb.val("%:dupegroup:%"))), eb.not(kx.like(db, "id", eb.val("%~replaced-%")))]))
    .$if(!!repo, (q) => q.where("repo", "=", repo!)));
  let n = 0;
  for (const d of rows) {
    const done = await mergedAtHead(db, d);
    const why = done ? "the PR merged at the answered head" : await staleReason(db, d);
    if (!why) continue;
    const note = done ? "" : `not applied: ${why}`;
    const r = await db.run(db.k.updateTable("main.decisions").set((eb) => ({
      applied_at: at, exec_state: "done", exec_reason: null, dispute_by: null, dispute_reason: null, dispute_at: null,
      ...(note === "" ? {} : { answer_note: eb.case().when(eb.or([eb("answer_note", "is", null), eb("answer_note", "=", "")])).then(note).else(eb("answer_note", "||", ` (${note})`)).end() }),
    })).where("id", "=", d.id).where("answer", "is not", null).where("applied_at", "is", null));
    if (r.changes === 1) { await audit(db, ACTOR, "answer-sweep", d.id, { answer: d.answer, why }); n++; }
  }
  return n;
}

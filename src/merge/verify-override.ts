// An operator's Merge answer to a Merge? question that named a failed or errored verification stands only when it was given after that
// verification result at the same head. A pre-approved merge's hand-over never answers over a failed verification (src/preapproval).
import { settledByExpr } from "../settlers.ts";
import { jsonText } from "../db/kx.ts";
import { mergeDecisionId } from "../core/rules.ts";
import { withdrawMergeQuestion } from "./withdraw.ts";
import type { Db } from "../db/index.ts";

export async function verifyOverride(db: Db, repo: string, number: number, head: string): Promise<boolean> {
  // The result time is finished_at: created_at is the plan time, and a retry plans the same row again.
  const v = await db.get(db.k.selectFrom("verifications").select("finished_at").where("repo", "=", repo).where("number", "=", number).where("head_sha", "=", head)
    .where("state", "in", ["failed", "error"]).where("finished_at", "is not", null).$narrowType<{ finished_at: string }>());
  if (!v) return false;
  const id = mergeDecisionId(repo, number, head);
  if (await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("target", "=", id).where("action", "=", "answer")
    .where((eb) => eb(jsonText(db, "details", "$.source"), "=", "preapproval")).limit(1))) return false;
  return !!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", id).where("kind", "=", "merge").where("answer", "=", "merge")
    .where("answered_at", ">", v.finished_at).where((eb) => settledByExpr(db, eb, "decisions")));
}

/** A Merge answer given before the verification failed does not cover the failure: it is set aside so the Merge? question is asked again with the failure as a reason. */
export async function setAsideAnswerBeforeFailure(db: Db, repo: string, number: number, head: string, at: string): Promise<boolean> {
  const d = await db.get(db.k.selectFrom("decisions").select("answer").where("id", "=", mergeDecisionId(repo, number, head)));
  return d?.answer === "merge" && await withdrawMergeQuestion(db, repo, number, head, at, "verification failed after the Merge answer");
}

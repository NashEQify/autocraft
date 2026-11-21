// The head commit of a PR as best known, the scope answers per item.
import type { Expression, NotNull, SqlBool } from "kysely";
import { settledByExpr } from "../settlers.ts";
import { KEEP_IN_CORE, REVIEW_LABELS, sizeOf, type Size } from "../core/rules.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
export { REVIEW_LABELS, sizeOf, type Size };


function parseRefs(s: string | null): { repo: string; number: number; answer?: string }[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as { repo: string; number: number }[]) : [];
  } catch { return []; }
}

/**
 * The PR's head commit as best known: the checks table's when it was fetched
 * after the mirror last saw the PR change, else the mirror's.
 */
export function headOf(r: { head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null }): string | null {
  if (r.c_head && r.c_at && (!r.updated_at || r.c_at > r.updated_at)) return r.c_head;
  return r.head_oid ?? r.c_head;
}

const maintainerAnswer = (eb: kx.AnyEb) => eb("decisions.answered_by", "in", kx.schemaEb(eb).selectFrom("main.access").select("login").where("role", "=", "maintainer"));

async function scopeRows(db: Db, extra: (eb: kx.AnyEb) => Expression<SqlBool>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rows = await db.all(db.k.selectFrom("decisions").select(["repo", "number", "items", "answer", "exceptions"]).$narrowType<{ answer: NotNull }>()
    .where("kind", "=", "scope").where("answer", "is not", null).where((eb) => eb.not(eb.and([eb("answer", "=", "withdrawn"), eb("answered_by", "=", "pipeline")])))
    .where(extra).orderBy("answered_at", (o) => o.desc().nullsLast()));
  for (const r of rows) {
    if (r.number !== null) {
      const k = `${r.repo}#${r.number}`;
      if (!out.has(k)) out.set(k, r.answer);
      continue;
    }
    const ex = new Map(parseRefs(r.exceptions).map((e) => [`${e.repo}#${e.number}`, e.answer]));
    for (const i of parseRefs(r.items)) {
      const k = `${i.repo}#${i.number}`;
      if (!out.has(k)) out.set(k, ex.get(k) ?? r.answer);
    }
  }
  return out;
}

/**
 * The answer of the latest answered scope decision per item ("repo#n"), for every item at once. A maintainer's answer
 * counts only while it is settled (src/settlers.ts); `operatorsOnly` keeps only answers whose answerer settles.
 */
export async function scopeAnswers(db: Db, operatorsOnly = false): Promise<Map<string, string>> {
  // A disputed answer does not count until it is kept.
  return await scopeRows(db, (eb) => eb.and([eb("decisions.exec_state", "is distinct from", "disputed"),
    operatorsOnly ? settledByExpr(db, eb, "decisions") : eb.not(eb.and([maintainerAnswer(eb), eb.not(settledByExpr(db, eb, "decisions"))]))]));
}

/** Items whose latest scope answer is a maintainer's that no longer counts: the item waits for a decision again instead of being reviewed on it. */
export async function unsettledScope(db: Db): Promise<Set<string>> {
  return new Set((await scopeRows(db, (eb) => eb.and([maintainerAnswer(eb), eb.not(settledByExpr(db, eb, "decisions"))]))).keys());
}

/**
 * The person's keep-in-core scope answer that stands for a PR, with who gave it and their note; null when scope is open,
 * answered otherwise, or answered only by a pipeline step.
 */
export async function settledScope(db: Db, repo: string, number: number): Promise<{ answer: string; by: string | null; note: string | null } | null> {
  const ref = `${repo}#${number}`;
  const answer = (await scopeAnswers(db)).get(ref);
  if (!answer || !KEEP_IN_CORE.includes(answer)) return null;
  const rows = await db.all(db.k.selectFrom("decisions").select(["answered_by", "answer_note", "repo", "number", "items"]).$narrowType<{ answered_by: NotNull }>()
    .where("kind", "=", "scope").where("answer", "=", answer).where("answered_by", "is not", null).where("answered_by", "<>", "pipeline")
    .where((eb) => eb.not(eb.and([maintainerAnswer(eb), eb.not(settledByExpr(db, eb, "decisions"))]))).orderBy("answered_at", (o) => o.desc().nullsLast()));
  const r = rows.find((x) => (x.number !== null ? x.repo === repo && x.number === number : parseRefs(x.items).some((i) => i.repo === repo && i.number === number)));
  if (!r) return null;
  const note = r.answer_note?.replace(/\s+/g, " ").trim().slice(0, 500) || null;
  return { answer, by: r.answered_by, note };
}

/** A tracked issue "repo#n" whose open decision is a scope question (a PR is a code dependency, never only a question). */
export async function isScopeQuestion(db: Db, ref: string): Promise<boolean> {
  const [repo, n] = ref.split("#");
  return !!await db.get(db.k.selectFrom("decisions as d").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number").on("i.kind", "=", "issue"))
    .select((eb) => eb.lit(1).as("one")).where("d.repo", "=", repo!).where("d.number", "=", Number(n)).where("d.kind", "=", "scope").where("d.answer", "is", null).limit(1));
}

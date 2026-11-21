// The Opus check of a patch we wrote, before it reaches GitHub (Fix-up pushes, Fix PRs). The model's reply is
// text our code validates; every check is recorded in patch_checks for the Item page.
import { createHash } from "node:crypto";
import { wholeReplyJson } from "../core/reply-json.ts";
import { CHECK_MAX_PROBLEMS, CHECK_PROBLEM_CHARS, CHECK_REASON_WORDS, type CheckKind, type PatchCheck } from "./types.ts";
import type { Db } from "../db/index.ts";

export const patchHash = (patch: string): string => createHash("sha256").update(patch).digest("hex").slice(0, 16);

const words = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");

/** The reply's one JSON object (see wholeReplyJson), or why it is not one. */
export function parseCheck(reply: string): { ok: true; check: PatchCheck } | { ok: false; error: string } {
  const o = wholeReplyJson(reply);
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "the reply is not exactly one JSON object" };
  const v = o as { verdict?: unknown; reasons?: unknown; problems?: unknown };
  if (v.verdict !== "approve" && v.verdict !== "reject") return { ok: false, error: "verdict is not approve or reject" };
  if (typeof v.reasons !== "string") return { ok: false, error: "reasons is not text" };
  const reasons = words(v.reasons, CHECK_REASON_WORDS);
  if (v.verdict === "reject" && !reasons) return { ok: false, error: "a reject gives no reason" };
  const problems = (Array.isArray(v.problems) ? v.problems : []).filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .slice(0, CHECK_MAX_PROBLEMS).map((p) => p.replace(/\s+/g, " ").trim().slice(0, CHECK_PROBLEM_CHARS));
  return { ok: true, check: { verdict: v.verdict, reasons, problems } };
}

export type PatchCheckRow = {
  id: number; kind: CheckKind; repo: string; number: number; subject: string; patchHash: string; round: number;
  verdict: "approve" | "reject"; reasons: string; problems: string[]; model: string; createdAt: string;
};

/** `subject` is the commit the patch applies to: the PR head (fixup) or the default branch head (fix). */
export async function recordCheck(db: Db, r: { kind: CheckKind; repo: string; number: number; subject: string; patch: string; round: number; model: string; check: PatchCheck; at: string }): Promise<void> {
  await db.run(db.k.insertInto("patch_checks").values({
    kind: r.kind, repo: r.repo, number: r.number, subject: r.subject, patch_hash: patchHash(r.patch), round: r.round, verdict: r.check.verdict,
    reasons: r.check.reasons, problems: JSON.stringify(r.check.problems), model: r.model, created_at: r.at,
  }));
}

export async function checksOf(db: Db, repo: string, number: number): Promise<PatchCheckRow[]> {
  const rows = await db.all(db.k.selectFrom("patch_checks").select(["id", "kind", "subject", "patch_hash", "round", "verdict", "reasons", "problems", "model", "created_at"])
    .where("repo", "=", repo).where("number", "=", number).orderBy("id")
    .$narrowType<{ kind: CheckKind; verdict: "approve" | "reject" }>());
  return rows.map((x) => ({ id: x.id, kind: x.kind, repo, number, subject: x.subject, patchHash: x.patch_hash, round: x.round, verdict: x.verdict, reasons: x.reasons, problems: JSON.parse(x.problems) as string[], model: x.model, createdAt: x.created_at }));
}

/** Reasons and problems as one line for a hold note or the next round's prompt. */
export function checkLine(c: PatchCheck): string {
  return [c.reasons, ...c.problems].filter(Boolean).join("; ");
}

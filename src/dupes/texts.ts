// The comments the Act step posts for a duplicate group. They are written when the decision is asked,
// one set per answer the operator can pick (use this answer, or keep #N instead), and shown with that
// option, so an answer approves exactly the words it posts. They come from the roles and the stored
// comparison points only (no model call) and are never written after an answer.
import { createHash } from "node:crypto";
import { dupeGroupCloseComment, dupeGroupDetailsComment } from "../act/templates.ts";
import { carryAskText } from "../fixup/template.ts";
import { keptOf } from "./held.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export type Row = { number: number; kind: string; role: string; target: number | null; detail: string | null };
/** close: on a member to close; details: on the kept issue; suggestion: on the kept PR when its branch can't be pushed to and the carried parts are suggested instead. */
export type TextStep = "close" | "details" | "suggestion";
export type StoredText = { number: number; step: TextStep; text: string };

const points = (detail: string | null, key: "carry" | "adds"): string[] => {
  try {
    const v = (JSON.parse(detail ?? "null") as Record<string, unknown> | null)?.[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** The roles an answer implies: `keep:N` keeps N; the kept item it replaces closes when `closable`, else stays; the other closing members now point at N. */
export async function rolesFor(rows: Row[], option: string, closable: (n: number) => Promise<boolean>): Promise<Row[]> {
  const n = keptOf(option);
  const row = n === null ? undefined : rows.find((r) => r.number === n);
  if (n === null || !row) return rows;
  return await mapSeq(rows, async (r) => {
    if (r.number === n) return { ...r, role: "keep", target: null };
    if (r.kind !== row.kind) return r;
    if (r.role === "keep") return await closable(r.number) ? { ...r, role: "close", target: n } : { ...r, role: "stay", target: null };
    return r.role === "close" ? { ...r, target: n } : r;
  });
}

/** Every text for a set of roles. */
export function groupTexts(rows: Row[]): StoredText[] {
  const out: StoredText[] = [];
  for (const r of rows) {
    if (r.role === "close" && r.target !== null) out.push({ number: r.number, step: "close", text: dupeGroupCloseComment({ kept: r.target, carry: r.kind === "pr" ? points(r.detail, "carry") : [] }) });
  }
  const keepIssue = rows.find((r) => r.role === "keep" && r.kind === "issue");
  if (keepIssue) {
    const text = dupeGroupDetailsComment(rows.filter((r) => r.kind === "issue" && r.role === "close").map((r) => ({ number: r.number, points: points(r.detail, "adds") })));
    if (text) out.push({ number: keepIssue.number, step: "details", text });
  }
  const keepPr = rows.find((r) => r.role === "keep" && r.kind === "pr");
  if (keepPr) {
    const sources = rows.filter((r) => r.kind === "pr" && r.role === "close").map((r) => ({ number: r.number, points: points(r.detail, "carry") })).filter((s) => s.points.length);
    if (sources.length) out.push({ number: keepPr.number, step: "suggestion", text: carryAskText(sources) });
  }
  return out;
}

/** Writes the text set of every option of a decision, from the roles stored with it. */
export async function storeOptionTexts(db: Db, id: string, options: string[], closable: (n: number) => Promise<boolean>): Promise<void> {
  const rows = await db.prepare("SELECT number, kind, role, target, detail FROM dupe_group_items WHERE decision_id = ?").all(id) as Row[];
  await db.prepare("DELETE FROM dupe_group_texts WHERE decision_id = ?").run(id);
  const ins = db.prepare("INSERT INTO dupe_group_texts (decision_id, option, number, step, text) VALUES (?, ?, ?, ?, ?)");
  for (const option of options) for (const t of groupTexts(await rolesFor(rows, option, closable))) await ins.run(id, option, t.number, t.step, t.text);
}

export async function textsFor(db: Db, id: string, option: string): Promise<StoredText[]> {
  return await db.prepare("SELECT number, step, text FROM dupe_group_texts WHERE decision_id = ? AND option = ? ORDER BY step = 'suggestion', number, step").all(id, option) as StoredText[];
}

export const textsHash = (texts: StoredText[]): string => createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 16);

/** `optionTextsOf` of many decisions in one read, by decision id; decisions without texts are left out. */
export async function optionTextsMany(db: Db, ids: string[]): Promise<Map<string, { option: string; hash: string; texts: StoredText[] }[]>> {
  const by = new Map<string, Map<string, StoredText[]>>();
  for (const r of await db.prepare(`SELECT decision_id, option, number, step, text FROM dupe_group_texts WHERE decision_id IN (SELECT value FROM json_each(?))
    ORDER BY decision_id, option, step = 'suggestion', number, step`).all(JSON.stringify(ids)) as ({ decision_id: string; option: string } & StoredText)[]) {
    const opts = by.get(r.decision_id) ?? by.set(r.decision_id, new Map()).get(r.decision_id)!;
    (opts.get(r.option) ?? opts.set(r.option, []).get(r.option)!).push({ number: r.number, step: r.step, text: r.text });
  }
  return new Map([...by].map(([id, opts]) => [id, [...opts].map(([option, texts]) => ({ option, hash: textsHash(texts), texts }))]));
}

/** What the decision page shows: per option, its hash and every text with the item it goes on. Empty for other decisions. */
export async function optionTextsOf(db: Db, id: string): Promise<{ option: string; hash: string; texts: StoredText[] }[]> {
  const opts = (await db.prepare("SELECT DISTINCT option FROM dupe_group_texts WHERE decision_id = ?").all(id) as { option: string }[]).map((r) => r.option);
  return await mapSeq(opts, async (option) => { const texts = await textsFor(db, id, option); return { option, hash: textsHash(texts), texts }; });
}

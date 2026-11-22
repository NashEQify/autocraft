// The scope decision for one candidate: question, options, recommendation and
// facts. The summary is added by the caller.
import { TIER_LABEL, statsExpr, tierKey, tiersOf } from "../whitelist.ts";
import type { Candidate } from "./select.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/**
 * Answer keys of a scope decision. The step that applies answers reads these
 * keys (never free text):
 * - take: in scope for core; keep open, PRs go to review.
 * - small-extra: keep in core as a small extra (label "small extra").
 * - plugin: keep open, label "plugin candidate"; not for core.
 * - close: out of scope; close with a short reason.
 * - need-info: ask how the reference app behaves before deciding.
 */
export const SCOPE_OPTIONS = {
  take: { key: "take", label: "Wanted in core", hint: "In scope: brings us closer to the reference app. Keep open; PRs go to review." },
  "small-extra": { key: "small-extra", label: "Small extra", hint: "Beyond the reference app but tiny; keep it in core as a small extra." },
  plugin: { key: "plugin", label: "Plug-in candidate", hint: "Not for core. Keep open and label it plugin candidate." },
  close: { key: "close", label: "Out of scope", hint: "Not wanted. Close with a short reason." },
  "need-info": { key: "need-info", label: "Check the reference app", hint: "Ask how the reference app behaves before deciding." },
} as const;
export type OptionKey = keyof typeof SCOPE_OPTIONS;

/** The option each type label points to. */
const OPTION_OF_LABEL: Record<string, OptionKey> = {
  "missing feature": "take", "small extra": "small-extra", "plugin candidate": "plugin",
  bugfix: "take", performance: "take", infra: "take",
};

type Shape = { question: string; options: OptionKey[] };

/** Question and options by the settled label, or by the two labels in a disagreement. The decision asks because the item needs a maintainer's call, so no option is recommended here (see prepare.ts). */
export function shapeOf(c: Candidate): Shape {
  const s = c.settled;
  if (c.reason === "scope-disagreement") {
    const pair = new Set([s.jevLabel, s.haikuLabel]);
    if (pair.has("small extra") && pair.has("plugin candidate"))
      return { question: "Keep this in core as a small extra, or treat it as a plug-in?", options: ["small-extra", "plugin", "take", "need-info", "close"] };
    const other = OPTION_OF_LABEL[pair.has("small extra") ? "small extra" : "plugin candidate"]!;
    return { question: "Does the reference app have this, and do we want it in core?", options: ["take", other, "need-info", "close"] };
  }
  switch (s.label) {
    case "missing feature":
      return { question: "Is this wanted in core?", options: ["take", "plugin", "need-info", "close"] };
    case "small extra":
      return { question: "Keep this small extra in core?", options: ["small-extra", "plugin", "need-info", "close"] };
    case "plugin candidate":
      return { question: "Keep this in core, or treat it as a plug-in?", options: ["take", "plugin", "need-info", "close"] };
    case "bugfix":
      return { question: "Is this change in behaviour wanted?", options: ["take", "need-info", "close"] };
    default:
      return { question: "Is this wanted?", options: ["take", "need-info", "close"] };
  }
}

export const decisionId = (c: { repo: string; number: number }): string => `${c.repo}#${c.number}:scope`;

const list = (s: string | null): unknown[] => {
  try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; }
};

async function authorFact(db: Db, login: string | null, id: number | null): Promise<string> {
  if (!login) return "author: unknown (deleted account)";
  const s = await db.get(statsExpr(db).where("author", "=", login).groupBy("author"));
  const merged = s?.merged ?? 0, closed = s?.closed ?? 0;
  const tier = (await tiersOf(db, [{ login, id }])).get(tierKey({ login, id })) ?? "not";
  return `author: ${login}, ${TIER_LABEL[tier]} (${merged} merged PR${merged === 1 ? "" : "s"}, ${closed} closed unmerged)`;
}

/** Up to five facts: what and how big, author and tier, classifiers, GitHub labels, linked items. */
export async function factsOf(db: Db, c: Candidate, now = Date.now()): Promise<string[]> {
  const i = (await db.get(db.k.selectFrom("items").select(["kind", "author", "created_at", "labels", "additions", "deletions", "changed_files", "comments_count", "closing_issues", "author_id"])
    .$narrowType<{ kind: "pr" | "issue" }>().where("repo", "=", c.repo).where("number", "=", c.number)))!;
  const days = i.created_at ? Math.max(0, Math.floor((now - Date.parse(i.created_at)) / 86_400_000)) : null;
  const age = days === null ? "" : days === 0 ? ", opened today" : `, opened ${days} day${days === 1 ? "" : "s"} ago`;
  const comments = i.comments_count ?? 0;
  const size = i.kind === "pr" ? `, +${i.additions ?? 0} −${i.deletions ?? 0} in ${i.changed_files ?? 0} file${i.changed_files === 1 ? "" : "s"}` : "";
  const facts = [`${c.repo} ${i.kind === "pr" ? "PR" : "issue"}${size}${age}, ${comments} comment${comments === 1 ? "" : "s"}`, await authorFact(db, i.author, i.author_id)];
  const s = c.settled;
  const conf = s.confidence === null ? "" : ` (${s.confidence.toFixed(2)})`;
  facts.push(`Jev: ${s.jevLabel ?? "none"}${conf}; Haiku: ${s.haikuLabel ?? "not asked"}${s.status === "settled" ? `; settled: ${s.label}` : ""}`);
  const labels = list(i.labels).filter((x): x is string => typeof x === "string");
  if (labels.length) facts.push(`GitHub labels: ${labels.join(", ")}`);
  const linked: string[] = [];
  const fixes = list(i.closing_issues).filter((n): n is number => typeof n === "number");
  if (fixes.length) linked.push(`fixes ${fixes.map((n) => `#${n}`).join(", ")}`);
  if (i.kind === "issue") {
    const prs = await db.all(db.k.selectFrom("items").select("number").where("repo", "=", c.repo).where("kind", "=", "pr").where("state", "=", "OPEN")
      .where((eb) => eb.exists(eb.selectFrom(kx.jsonEach(db, "items.closing_issues", "ci", "bigint")).select(eb.lit(1).as("one")).where("ci.value", "=", c.number)))
      .orderBy("number"));
    if (prs.length) linked.push(`open PRs that fix it: ${prs.map((p) => `#${p.number}`).join(", ")}`);
  }
  const dups = await db.all(db.k.selectFrom("classifications").select("dup_of").distinct().where("repo", "=", c.repo).where("number", "=", c.number).where("dup_of", "is not", null)
    .$narrowType<{ dup_of: number }>().orderBy("dup_of"));
  if (dups.length) linked.push(`possible duplicate of ${dups.map((d) => `#${d.dup_of}`).join(", ")}`);
  if (linked.length) facts.push(linked.join("; "));
  return facts.slice(0, 5);
}

export function contextOf(c: Candidate): string {
  const s = c.settled;
  if (c.reason === "scope-disagreement") return `Jev says ${s.jevLabel}, Haiku says ${s.haikuLabel}: a scope call either way.`;
  return `The classifiers settled on ${s.label} and flagged it as needing a maintainer's call.`;
}

/** The question in the shape `ask()` takes; summary fields are added by the caller. */
export type Question = Record<string, unknown> & { id: string; repo: string; number: number };

export async function buildDecision(db: Db, c: Candidate, now = Date.now()): Promise<Question> {
  const shape = shapeOf(c);
  return {
    id: decisionId(c), kind: "scope", repo: c.repo, number: c.number,
    question: shape.question, context: contextOf(c), facts: await factsOf(db, c, now),
    options: shape.options.map((k) => ({ ...SCOPE_OPTIONS[k] })), recommended: null,
    asked_by: "decide",
  };
}

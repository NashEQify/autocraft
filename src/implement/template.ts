// Texts the Implement stage writes on GitHub: the PR title, body and commit message, the branch name and the one issue
// comment. Model text in them (the session's summary, the plan) is untrusted: it is cleaned of links, references, mentions
// and tags here; its reply lint ran in the call that wrote it. No Node imports: the Prompts page shows the templates.
import { dropMarkup, settle } from "../review/public-text.ts";
import { modelLabel, stripLinks } from "../review/post-template.ts";
import type { PlanReply } from "./types.ts";

export const IMPLEMENT_COMMENT_TEMPLATE = "A PR for this is open: {{url}}.";
export const IMPLEMENT_DRAFT_COMMENT_TEMPLATE = "A draft PR for this is open: {{url}}. It needs a maintainer's look before it can go further.";
const SUMMARY_MAX = 3000;
const PLAN_MAX = 20_000;
const CHECK_MAX = 200;

/**
 * The issue title as a line the pipeline may author: no URL, issue reference ("#12", "GH-12", "owner/repo#12") or
 * mention, so a closing keyword in it names nothing and nobody is pinged. A reference reads "issue 12".
 */
export function plainTitle(title: string): string {
  return settle(title.replace(/\s+/g, " "), (t) => dropMarkup(t
    .replace(/<?(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]*>?/gi, "")
    .replace(/(?<![A-Za-z0-9])GH-(\d+)(?![A-Za-z0-9])/gi, "issue $1")
    .replace(/(?<![A-Za-z0-9])(?:[\w.-]+\/[\w.-]+)?#(\d+)(?![A-Za-z0-9])/g, "issue $1"))).replace(/\s+/g, " ").trim();
}

const VERB: Record<PlanReply["kind"], string> = { bugfix: "Fix", feature: "Add", change: "Change" };
/** A leading word of the issue title that says the same as the verb, or tags the kind ("Bug:", "feat:", "[Feature]"). */
const LEAD = /^(?:\[[^\]]{1,20}\]\s*|(?:bug(?:fix)?|fix(?:es|ed)?|feat(?:ure)?(?: request)?|request|add(?:s|ed)?|change(?:s|d)?|enhancement)\b:?\s+)/i;

/** "Fix …" for a bug fix, "Add …" for a feature, "Change …" for a change, from the cleaned issue title (at most about 70 characters of it). */
export function implTitle(kind: PlanReply["kind"], title: string): string {
  let t = plainTitle(title);
  for (let k = 0; k < 3 && LEAD.test(t); k++) t = t.replace(LEAD, "");
  t = t.replace(/[.\s]+$/, "");
  const cut = t.length > 70 ? t.slice(0, 70).replace(/\s+\S*$/, "") : t;
  // A title that keeps an acronym or a name at its start ("PNG export…") keeps its capital.
  const lower = /^[A-Z][a-z]/.test(cut) ? cut.charAt(0).toLowerCase() + cut.slice(1) : cut;
  return lower ? `${VERB[kind] ?? "Change"} ${lower}` : `${VERB[kind] ?? "Change"} the behaviour the issue describes`;
}

/** `autocraft/impl-<number>-<slug>`: the slug comes from the issue title only, and never holds the pipeline account's login. */
export function implBranch(number: number, title: string, login: string): string {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  if (login && slug.includes(login.toLowerCase())) slug = "";
  return `autocraft/impl-${number}${slug ? `-${slug}` : ""}`;
}

/** One check AutoCraft ran on the implementation in the workspace (fmt, clippy, tests), as the PR body lists it. */
export type CheckLine = { name: string; ok: boolean; detail?: string | null };

export type PrBodyInput = {
  number: number;
  /** The session's summary of the change. */
  summary: string;
  checks: CheckLine[];
  plan: string | null;
  /** The model that wrote the change. */
  model: string;
  /** Changed Cargo manifests and lockfiles (validateImplementation). */
  manifests: string[];
  /** Compile-time manifest changes (validateImplementation): the PR opens as a draft for a maintainer. */
  compileTime?: { path: string; what: string }[];
  draft?: boolean;
};

const oneLine = (s: string, max: number): string => {
  const t = stripLinks(s.replace(/\s+/g, " ").trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const block = (s: string, max: number): string => {
  const t = stripLinks(s.replace(/\r\n/g, "\n").trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const code = (p: string): string => `\`${p.replace(/`/g, "")}\``;

export function implPrBody(o: PrBodyInput): string {
  const parts = [`Fixes #${o.number}.`];
  const summary = block(o.summary, SUMMARY_MAX);
  if (summary) parts.push(summary);
  parts.push(o.checks.length
    ? `Checks AutoCraft ran in the workspace:\n${o.checks.map((c) => `- [${c.ok ? "x" : " "}] ${code(c.name.slice(0, 100))}${c.detail ? `: ${oneLine(c.detail, CHECK_MAX)}` : ""}`).join("\n")}`
    : "AutoCraft ran no checks on this change.");
  if (o.manifests.length) parts.push(`This PR changes ${o.manifests.map(code).join(", ")}: check the dependency changes.`);
  if (o.compileTime?.length) {
    parts.push(`Opened as a draft: this change makes Cargo run new code while it builds, so a maintainer decides whether it goes further.\n${o.compileTime.map((c) => `- ${code(c.path)}: ${c.what}`).join("\n")}`);
  } else if (o.draft) parts.push("Opened as a draft: the implementation stopped before it passed every step, and a maintainer chose to open it as it is.");
  const plan = o.plan ? block(o.plan, PLAN_MAX) : "";
  if (plan) parts.push(`<details><summary>Plan</summary>\n\n${plan}\n\n</details>`);
  parts.push(`Written by ${modelLabel(o.model)} in a workspace session. The checks above are AutoCraft's own runs, not the session's report.`);
  return `${parts.join("\n\n")}\n`;
}

/** The commit message; file paths are untrusted and cleaned like titles, so none closes an issue or pings anyone. */
export function implCommitMessage(title: string, number: number, files: string[]): string {
  const shown = files.slice(0, 20).map(plainTitle);
  const list = files.length > 20 ? [...shown, `and ${files.length - 20} more`] : shown;
  return `${title}\n\nFixes #${number}.\n\n${list.map((f) => `- ${f}`).join("\n")}\n`;
}

export const implCommentText = (url: string, draft = false): string => (draft ? IMPLEMENT_DRAFT_COMMENT_TEMPLATE : IMPLEMENT_COMMENT_TEMPLATE).replace("{{url}}", url);

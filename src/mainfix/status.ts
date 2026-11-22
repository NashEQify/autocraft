// What AutoCraft is doing about a red default branch, in words for the Main CI page. Read-only.
import { mainFixApprovals } from "./approval.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Shown first when a head has rows in several states: what needs a person comes before what is running. */
const ORDER = ["fix-failed", "needs-fix", "linting", "asked", "pr-opened", "rerun-requested", "issue-opened", "declined", "nothing-to-do", "rerun-passed"] as const;

const TEXT: Record<(typeof ORDER)[number], string> = {
  "fix-failed": "needs a person",
  "pr-opened": "opened fix PR",
  "needs-fix": "needs a fix",
  linting: "checking a fix",
  asked: "asked an operator",
  "rerun-requested": "rerunning failed jobs",
  "issue-opened": "opened an issue",
  declined: "nothing to do: infra",
  "nothing-to-do": "nothing to do",
  "rerun-passed": "rerun passed",
};

/** Null when the repo has no approval and nothing was done at this head. */
export async function autocraftText(db: Db, repo: string, headSha: string, state: string): Promise<string | null> {
  return (await autocraftTexts(db, [{ repo, headSha, state }])).get(`${repo}\0${headSha}`) ?? null;
}

/** `autocraftText` of many heads in two reads, by repo and head joined by a NUL. */
export async function autocraftTexts(db: Db, heads: { repo: string; headSha: string; state: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!heads.length) return out;
  const rows = await db.all(db.k.selectFrom("main_fixes").select(["repo", "head_sha", "state", "pr_number"])
    .where(kx.tupleIn(db, ["repo", "head_sha"], heads.map((h) => [h.repo, h.headSha]), ["text", "text"])));
  const fixes = new Map<string, typeof rows>();
  for (const r of rows) (fixes.get(`${r.repo}\0${r.head_sha}`) ?? fixes.set(`${r.repo}\0${r.head_sha}`, []).get(`${r.repo}\0${r.head_sha}`)!).push(r);
  const first = (k: string) => { const states = new Set((fixes.get(k) ?? []).map((r) => r.state)); return ORDER.find((s) => states.has(s)); };
  const approvals = await mainFixApprovals(db, [...new Set(heads.filter((h) => h.state === "red" && !first(`${h.repo}\0${h.headSha}`)).map((h) => h.repo))]);
  for (const h of heads) {
    const k = `${h.repo}\0${h.headSha}`;
    const f = first(k);
    if (f === "pr-opened") {
      const n = Math.min(...(fixes.get(k) ?? []).filter((r) => r.state === "pr-opened" && r.pr_number !== null).map((r) => r.pr_number!));
      out.set(k, Number.isFinite(n) && n ? `${TEXT[f]} #${n}` : TEXT[f]);
    } else if (f) out.set(k, TEXT[f]);
    else out.set(k, h.state === "red" && approvals.get(h.repo) ? "reading the failure" : null);
  }
  return out;
}

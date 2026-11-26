// The follow-up issue of a PR a maintainer approved for merge: the defects of its pre-merge review that do not stop the merge
// (src/premerge/types.ts followUpDefects), filed so that a maintainer finds them in the item queue like any issue. One issue per
// PR, opened at the first head with follow-ups; a later head's follow-ups are a comment on it. Runs the Plan's `followups`
// actions (src/core/decide.ts followUpsDue); the PR's merge waits for the try, not for its success.
//
// A head's row is written in state `filing` before the write, so a head is filed once. A write GitHub refused is recorded
// `failed` with its reason, and the merge goes on; one that sent nothing removes the row, so a later run tries again. A head
// whose follow-ups an earlier head filed already (same file and title) is recorded `filed` without a post.
import { guard } from "../core/guard.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import { claimPremergeFollowup, dropPremergeFollowup, loadPremerge, loadPremergeFollowups, settlePremergeFollowup } from "../data/review/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { exec, type Exec } from "../fixup/git.ts";
import { createIssue, ghFollowupComment, IssueError, type Writer } from "../github/write.ts";
import { isUnsent } from "../github/unsent.ts";
import { issueText, issueTitle, refusal } from "../postmerge/template.ts";
import { pipelineLogin } from "../review/discussion.ts";
import { jobItem } from "../runner/job-items.ts";
import { findingsOf, premergeAt } from "./store.ts";
import { followUpDefects, type PremergeFinding } from "./types.ts";

export const ACTOR = "premerge-followup";
const SHORT_TITLE = 80;

export type FollowupsParams = { repo: string; limit?: number; onHandled?: (n: number) => void; by?: By };
export type FollowupsDeps = { exec: Exec; now: () => Date; /** The app lane's token source; default: the secrets file's app. */ lane?: Pick<Writer, "mint" | "appClient"> };
export type FollowupsSummary = { repo: string; filed: string[]; commented: string[]; /** Heads whose follow-ups were all filed before: recorded, nothing posted. */ repeated: string[]; failed: { ref: string; reason: string }[]; skipped: { ref: string; reason: string }[] };

export const defaultFollowupsDeps = (): FollowupsDeps => ({ exec, now: () => new Date() });

const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);

/** "Follow-ups from #12: <the PR's title, cut short>". */
export function followupTitle(pr: number, title: string): string {
  // Only the PR's own title is cleaned: the prefix keeps its #number, which links the PR.
  const t = issueTitle(title);
  return `Follow-ups from #${pr}: ${t.length > SHORT_TITLE ? `${t.slice(0, SHORT_TITLE - 1).trimEnd()}…` : t}`;
}

/** Untrusted model text on one line, cleaned as a public issue's text is (no mentions, URLs, raw HTML or issue references). */
const line = (t: string): string => issueText(t).replace(/\s*\n\s*/g, " ");

/** The findings of one head, numbered: where, what goes wrong, and why it does not stop the merge. */
export function followupBody(pr: number, head: string, fs: readonly PremergeFinding[], first: boolean): string {
  const lead = first
    ? `The pre-merge review of #${pr} at ${head.slice(0, 7)} found these defects. A maintainer approved #${pr} for merge, and none of them stops it, so they are listed here to fix separately.`
    : `The pre-merge review of #${pr} at its new head ${head.slice(0, 7)} found these defects. None of them stops the merge.`;
  const items = fs.map((f, i) => [
    `${i + 1}. **${issueTitle(f.title)}** (\`${f.file.replace(/`/g, "")}${f.line ? `:${f.line}` : ""}\`)`,
    `   ${line(f.scenario)}`,
    ...(f.blocking?.why ? [`   Not blocking: ${line(f.blocking.why)}`] : []),
  ].join("\n"));
  return `${lead}\n\n${items.join("\n\n")}\n`;
}

/** A finding as the "comes back" check of the fix-up rounds matches it: same file and title. */
const findingKey = (f: Pick<PremergeFinding, "file" | "title">): string => `${f.file}\u0000${f.title}`;

/** Runs the repo's due `followups` actions: one issue per PR, a comment on it for a later head. */
export async function runPremergeFollowups(db: Db, params: FollowupsParams, log: (line: string) => void = console.log, deps: FollowupsDeps = defaultFollowupsDeps()): Promise<FollowupsSummary> {
  const { repo } = params, by = params.by ?? CLI_BY;
  const s: FollowupsSummary = { repo, filed: [], commented: [], repeated: [], failed: [], skipped: [] };
  const due = await planned(db, "followups", { repo, by });
  const login = await pipelineLogin(db);
  const w: Writer = { db, login: ACTOR, ...deps.lane };
  let handled = 0;
  for (const { facts: f, action } of due) {
    if (params.limit !== undefined && handled >= params.limit) break;
    const number = f.number, head = action.head!, ref = `${repo}#${number}`;
    const skip = async (reason: string) => { s.skipped.push({ ref, reason }); await jobItem(db, repo, number, `follow-ups not filed: ${reason}`, log); };
    const row = await premergeAt(db, repo, number, head), all = followUpDefects(findingsOf(row));
    if (!all.length) { await skip("the pre-merge review at the head has none"); continue; }
    const g = await guard(db, { repo, number }, { kind: "followups", head }, by);
    if ("refused" in g) { await skip(g.refused); continue; }
    const rows = (await loadPremergeFollowups(db, [{ repo, number }])).get(ref) ?? [];
    // What earlier heads filed (or may have filed) is not posted again: a new head repeats the same findings after every push of ours.
    const before = rows.filter((x) => x.head_oid !== head && x.state !== "failed");
    const earlier = await loadPremerge(db, before.map((x) => ({ repo, number, head: x.head_oid })));
    const sent = new Set([...earlier.values()].flatMap((r) => followUpDefects(findingsOf(r)).map(findingKey)));
    const fs = all.filter((f) => !sent.has(findingKey(f)));
    const prev = rows.findLast((x) => x.issue_number !== null && x.url !== null);
    const shown = await loadShown(db, [{ repo, number }, ...(prev ? [{ repo, number: prev.issue_number! }] : [])]);
    // The issue a later head comments on must still be open; a closed one gets a new issue for what is new.
    const issue = prev && shown.get(`${repo}#${prev.issue_number}`)?.state !== "closed" ? { number: prev.issue_number!, url: prev.url! } : null;
    const title = followupTitle(number, shown.get(ref)?.title ?? "");
    const body = followupBody(number, head, fs, !issue);
    const at = () => deps.now().toISOString();
    const bad = refusal([title, body], login);
    if (!await claimPremergeFollowup(db, { repo, number, head, at: at() })) continue;
    handled++;
    params.onHandled?.(handled);
    if (!fs.length) {
      // Nothing new: the head counts as filed, and its merge goes on.
      await settlePremergeFollowup(db, { repo, number, head, at: at(), state: "filed", issue: prev ? { number: prev.issue_number!, url: prev.url! } : null });
      s.repeated.push(ref);
      continue;
    }
    if (bad) {
      await settlePremergeFollowup(db, { repo, number, head, at: at(), state: "failed", note: bad });
      s.failed.push({ ref, reason: bad });
      continue;
    }
    const note = { by: "model" as const, kind: "issue", model: row?.model ?? null };
    try {
      let made: { number: number; url: string };
      if (issue) {
        const r = await ghFollowupComment(w, g, deps.exec, { issue: issue.number }, note, body, { head });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit code ${r.code}`);
        made = issue;
        s.commented.push(ref);
      } else {
        made = await createIssue(w, g, deps.exec, { repo, target: ref, title, body, action: ACTOR }, note, { head });
        s.filed.push(ref);
      }
      await settlePremergeFollowup(db, { repo, number, head, at: at(), state: "filed", issue: made });
      await jobItem(db, repo, number, `follow-ups filed in ${made.url}`, log);
    } catch (e) {
      const reason = oneLine(e);
      // Nothing was sent: the head is tried again by a later run.
      if (isUnsent(e) || (e instanceof IssueError && (e.later || e.unsettled))) {
        await dropPremergeFollowup(db, { repo, number, head });
        s.skipped.push({ ref, reason });
        continue;
      }
      // An outcome that is not known keeps the `filing` row: the issue may exist, and it is not opened twice.
      if (e instanceof IssueError && !e.clear) { s.failed.push({ ref, reason: `outcome unknown: ${reason}` }); continue; }
      await settlePremergeFollowup(db, { repo, number, head, at: at(), state: "failed", issue, note: reason });
      s.failed.push({ ref, reason });
      await jobItem(db, repo, number, `follow-ups not posted on GitHub: ${reason}`, log);
    }
  }
  log(`premerge-followups ${repo}: ${s.filed.length} issues opened, ${s.commented.length} comments, ${s.repeated.length} with nothing new, ${s.failed.length} failed, ${s.skipped.length} skipped`);
  return s;
}

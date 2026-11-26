// What an approved workflow's merge leg waits for when nothing can move it on: the app identity (as an implement workflow does
// from its start), without which nobody's started work counts; the merge, made as the approver, waiting for them
// to sign in; or the pre-merge check of the PR's head, due once the leg is in `ci`, with no Task Runner that may take it, or only
// the approver's own runners, none of which can claim now (src/remote/takers.ts waitingOn). For a closed workflow: what keeps the
// close from being made. A merge refused for its approver's access is no wait but a question (ask.ts), which an answer closes, or the
// approver's next sign-in (src/github/user-lane.ts retryWaiting). A contributor, or a person on GitHub, whom the item waits for without a question. The status comment, the item page and the agent show it as the state line.
import { loadPremerge, loadPremergeFollowups, PREMERGE_MAX_TRIES } from "../data/review/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import { loadActions, loadLegs, loadLinks, type WorkflowAction } from "../data/workflow/index.ts";
import { loadPlans } from "../data/planner/index.ts";
import type { RefusalCode, WaitCode } from "../core/codes.ts";
import type { Db } from "../db/index.ts";
import { githubIdentity } from "../github/identity.ts";
import { t, tk } from "../i18n/index.ts";
import { takerTestIn, waitingOnIn, type RunnerHold } from "../remote/takers.ts";
import { loadView } from "../remote/view.ts";
import type { ItemWorkflow } from "./types.ts";

/** What became of a close that is not made: it waits for its person, for the Act step, or it did not run. Null once it is made. */
function closeWait(a: WorkflowAction | undefined): string | null {
  switch (a?.state) {
    case "pending": return t("Closing as {login}", { login: a.by });
    case "waiting-token": return t("Waiting for {login} to sign in to AutoCraft, so the close runs as them", { login: a.by });
    case "waiting-permission": return t("Not closed: {login} has no write access here", { login: a.by });
    case "failed": case "skipped": case "stopped": return t("Not closed: {why}", { why: a.reason ?? a.state });
    default: return null;
  }
}

type Waiter = Pick<ItemWorkflow, "id" | "repo" | "number" | "kind" | "state">;

/** legWaits() of one workflow. */
export const legWait = async (db: Db, wf: Waiter, nowMs: number = Date.now()): Promise<string | null> => (await legWaits(db, [wf], nowMs)).get(wf.id) ?? null;

/**
 * Per workflow id the state line of a workflow whose started work waits for the app identity, whose merge leg waits for its approver's
 * sign-in, or for a pre-merge check that no Task Runner can take, or that only the own runners of the people whose work it is take while
 * none of them can claim (offline, held for its usage, cooling off), or for the contributor or a person on GitHub, or whose close is not made,
 * and the line of a done workflow whose PR merged with follow-ups filed; the others are absent.
 */
export async function legWaits(db: Db, wfs: readonly Waiter[], nowMs: number = Date.now()): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const closed = wfs.filter((w) => w.state === "closed"), moving = wfs.filter((w) => w.state === "running" || w.state === "waiting");
  const ofPrs = moving.filter((w) => w.kind === "pr").map((w) => ({ repo: w.repo, number: w.number }));
  const issues = moving.filter((w) => w.kind !== "pr").map((w) => w.id);
  const [identity, closes, actions, links, prLegs] = await db.together(() => Promise.all([
    moving.length ? githubIdentity(db) : "app",
    closed.length ? loadActions(db, { workflowIds: closed.map((w) => w.id), kinds: ["close", "comment-close"] }) : new Map<string, WorkflowAction[]>(),
    moving.length ? loadActions(db, { workflowIds: moving.map((w) => w.id) }) : new Map<string, WorkflowAction[]>(),
    loadLinks(db, { workflowIds: issues }), loadLegs(db, ofPrs, { activeOnly: true, latestOnly: true }),
  ]));
  const add = (id: number, line: string | null): void => { if (line !== null) out.set(id, line); };
  const byWorkflow = (m: ReadonlyMap<string, WorkflowAction[]>): Map<number, WorkflowAction[]> => {
    const by = new Map<number, WorkflowAction[]>();
    for (const a of [...m.values()].flat()) (by.get(a.workflow_id) ?? by.set(a.workflow_id, []).get(a.workflow_id)!).push(a);
    return by;
  };
  const closesOf = byWorkflow(closes), actionsOf = byWorkflow(actions);
  for (const w of closed) add(w.id, closeWait(closesOf.get(w.id)?.at(-1)));
  for (const [id, line] of await followUpLines(db, wfs.filter((w) => w.state === "done"))) add(id, line);
  // The PR the workflow's merge leg is on: the item, or the PR an implement workflow works on.
  const linked = new Map(links.map((l) => [l.workflowId, l.pr]));
  const prOf = (w: Waiter): number | null => (w.kind === "pr" ? w.number : linked.get(w.id) ?? null);
  const implPrs = moving.flatMap((w) => { const pr = w.kind === "pr" ? null : prOf(w); return pr === null ? [] : [{ repo: w.repo, number: pr }]; });
  const planned = moving.map((w) => ({ repo: w.repo, number: prOf(w) ?? w.number }));
  const [implLegs, plans] = await db.together(() => Promise.all([loadLegs(db, implPrs, { activeOnly: true, latestOnly: true }), loadPlans(db, planned)]));
  const legs = new Map([...prLegs, ...implLegs]);
  moving.forEach((w, i) => {
    const p = plans.get(`${w.repo}#${planned[i]!.number}`);
    const code = p?.view.waitCode, line = code && BY_OTHERS[code];
    if (line && !(code === "implement-question" && p!.view.waitKind !== "contributor")) add(w.id, t(line));
  });
  const inCi: { w: Waiter; pr: number; head: string }[] = [];
  for (const w of moving) {
    const pr = prOf(w);
    const p = pr === null ? undefined : legs.get(`${w.repo}#${pr}`)?.find((l) => l.workflow_id === w.id);
    if (identity !== "app" && (p || w.kind === "issue")) { add(w.id, t("Waiting for an operator to switch AutoCraft to its GitHub App: started work acts as the person, which only the app does")); continue; }
    if (pr === null || !p?.head || (p.state !== "ci" && p.state !== "queued")) continue;
    const merge = actionsOf.get(w.id)?.find((a) => a.kind === "merge" && a.number === pr && a.head === p.head && a.state === "waiting-token");
    if (merge) add(w.id, t("Waiting for {login} to sign in to AutoCraft, so the merge runs as them", { login: merge.by }));
    else if (p.state === "ci" && !out.has(w.id)) inCi.push({ w, pr, head: p.head });
  }
  const premerge = await loadPremerge(db, inCi.map((x) => ({ repo: x.w.repo, number: x.pr, head: x.head })));
  const unread = inCi.filter((x) => { const pm = premerge.get(`${x.w.repo}#${x.pr}@${x.head}`); return !(pm && (pm.findings !== null || pm.tries >= PREMERGE_MAX_TRIES)); });
  if (!unread.length) return out;
  const view = await loadView(db, nowMs), takes = takerTestIn(view);
  for (const { w, pr } of unread) {
    const call = { prompt_id: "", repos: [w.repo], step: "premerge", refs: [{ repo: w.repo, number: pr }] };
    if (!takes(call)) { add(w.id, t("Waiting for the pre-merge check: no Task Runner can take it")); continue; }
    const [first] = waitingOnIn(view, call);
    add(w.id, first ? t("Waiting for {login}'s Task Runner ({why})", { login: first.login, why: t(HOLD_WORD[first.hold]) }) : null);
  }
  return out;
}

/** Per workflow id, the line of a done workflow whose PR merged with follow-ups filed in its follow-up issue (src/premerge/followups.ts). */
async function followUpLines(db: Db, done: readonly Waiter[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!done.length) return out;
  const linked = new Map((await loadLinks(db, { workflowIds: done.filter((w) => w.kind !== "pr").map((w) => w.id) })).map((l) => [l.workflowId, l.pr]));
  const prs = done.flatMap((w) => { const pr = w.kind === "pr" ? w.number : linked.get(w.id); return pr == null ? [] : [{ w, repo: w.repo, number: pr }]; });
  const [filed, shown] = await db.together(() => Promise.all([loadPremergeFollowups(db, prs), loadShown(db, prs)]));
  for (const { w, repo, number } of prs) {
    const issue = filed.get(`${repo}#${number}`)?.find((r) => r.issue_number !== null)?.issue_number;
    if (issue != null && shown.get(`${repo}#${number}`)?.state === "merged") out.set(w.id, t("Merged; follow-ups filed in #{issue}", { issue }));
  }
  return out;
}

/** The state line of an item that waits, with no question open, for someone outside AutoCraft. */
const BY_OTHERS: Partial<Record<WaitCode, string>> = {
  "ci-contributor": tk("Waiting for the contributor to fix CI"),
  "fix-contributor": tk("Waiting for the contributor's fixes"),
  "conflict-contributor": tk("Waiting for the contributor to resolve the conflict with the base branch"),
  "conflict-person": tk("Waiting for someone to resolve the conflict with the base branch"),
  "changes-requested": tk("Waiting for the maintainer who asked for changes"),
  "repo-approval": tk("Waiting for the repo's approval of the next step, on the Repos page"),
  breaker: tk("Waiting for someone to resume the next step, which stopped itself here"),
  draft: tk("Waiting for the pull request to be marked ready for review"),
  "implement-question": tk("Waiting for the author's answer"),
};

const HOLD_WORD: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };

/** Why the review post of a started item may not run, by the refusal's code: the stored plan keeps the code only. */
const NOT_POSTED: Partial<Record<RefusalCode, string>> = {
  "repo-approval": tk("comments in {repo} are not approved, and the automatic merge rule started this item"),
  "actor-gone": tk("the person this item acts for can no longer act on {repo}"),
  "actor-unknown": tk("GitHub has not answered on the access of the person this item acts for"),
  "box-identity": tk("AutoCraft writes as its own account; an operator switches it to its GitHub App"),
};

/**
 * Per workflow id, the line saying the Opus review of the item's PR (an implement workflow's: its PR's) or its follow-up issue is not on
 * GitHub, and why: the stored plan holds the review post or the filing refused, or GitHub refused the filing. The others are absent. The item page, the Discord thread, the agent and the CLI show it
 * beside the state line.
 */
export async function notPostedLines(db: Db, wfs: readonly Waiter[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!wfs.length) return out;
  const issues = wfs.filter((w) => w.kind !== "pr").map((w) => w.id);
  const linked = new Map((await loadLinks(db, { workflowIds: issues })).map((l) => [l.workflowId, l.pr]));
  const prs = wfs.flatMap((w) => { const pr = w.kind === "pr" ? w.number : linked.get(w.id); return pr == null ? [] : [{ w, repo: w.repo, number: pr }]; });
  const [plans, filed] = await db.together(() => Promise.all([loadPlans(db, prs.map(({ repo, number }) => ({ repo, number }))), loadPremergeFollowups(db, prs)]));
  for (const { w, repo, number } of prs) {
    const actions = plans.get(`${repo}#${number}`)?.actions ?? [];
    const code = actions.find((a) => a.kind === "post-review")?.refused, fu = actions.find((a) => a.kind === "followups")?.refused;
    const last = filed.get(`${repo}#${number}`)?.at(-1), failed = last?.state === "failed" ? last.note : null;
    const why = code ? (NOT_POSTED[code] ? t(NOT_POSTED[code], { repo }) : t("the review post may not run ({code})", { code }))
      : fu ? (NOT_POSTED[fu] ? t(NOT_POSTED[fu], { repo }) : t("the follow-up issue may not be filed ({code})", { code: fu }))
      : failed ? t("the follow-up issue: {reason}", { reason: failed }) : null;
    if (why) out.set(w.id, t("Not posted on GitHub: {why}", { why }));
  }
  return out;
}

/** notPostedLines() of one workflow. */
export const notPostedLine = async (db: Db, wf: Waiter): Promise<string | null> => (await notPostedLines(db, [wf])).get(wf.id) ?? null;

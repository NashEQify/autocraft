// What an approved workflow's merge leg waits for when nothing can move it on: the merge, made as the approver, waiting for them
// to sign in; or the pre-merge check of the PR's head, due once the leg is in `ci`, with no Task Runner that may take it, or only
// the approver's own runners, none of which can claim now (src/remote/takers.ts waitingOn). For a closed workflow: what keeps the
// close from being made. The status comment, the item page and the agent show it as the state line.
import { loadImplementFacts } from "../data/implement/index.ts";
import { loadPremerge, PREMERGE_MAX_TRIES } from "../data/review/index.ts";
import { loadActions, loadLegs, type WorkflowAction } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
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
 * Per workflow id the state line of a workflow whose merge leg waits for its approver's sign-in, or for a pre-merge check that no Task
 * Runner can take, or that only the own runners of the people whose work it is take while none of them can claim (offline, held for its
 * usage, cooling off), or whose close is not made; the others are absent.
 */
export async function legWaits(db: Db, wfs: readonly Waiter[], nowMs: number = Date.now()): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const closed = wfs.filter((w) => w.state === "closed"), moving = wfs.filter((w) => w.state === "running" || w.state === "waiting");
  const ofPrs = moving.filter((w) => w.kind === "pr").map((w) => ({ repo: w.repo, number: w.number }));
  const issues = moving.filter((w) => w.kind !== "pr").map((w) => ({ repo: w.repo, number: w.number }));
  const [closes, actions, implement, prLegs] = await db.together(() => Promise.all([
    closed.length ? loadActions(db, { workflowIds: closed.map((w) => w.id), kinds: ["close", "comment-close"] }) : new Map<string, WorkflowAction[]>(),
    moving.length ? loadActions(db, { workflowIds: moving.map((w) => w.id) }) : new Map<string, WorkflowAction[]>(),
    loadImplementFacts(db, issues), loadLegs(db, ofPrs, { activeOnly: true, latestOnly: true }),
  ]));
  const add = (id: number, line: string | null): void => { if (line !== null) out.set(id, line); };
  const byWorkflow = (m: ReadonlyMap<string, WorkflowAction[]>): Map<number, WorkflowAction[]> => {
    const by = new Map<number, WorkflowAction[]>();
    for (const a of [...m.values()].flat()) (by.get(a.workflow_id) ?? by.set(a.workflow_id, []).get(a.workflow_id)!).push(a);
    return by;
  };
  const closesOf = byWorkflow(closes), actionsOf = byWorkflow(actions);
  for (const w of closed) add(w.id, closeWait(closesOf.get(w.id)?.at(-1)));
  // The PR the workflow's merge leg is on: the item, or an implement workflow's latest implementation PR.
  const prOf = (w: Waiter): number | null => {
    if (w.kind === "pr") return w.number;
    const a = implement.byIssue.get(`${w.repo}#${w.number}`);
    return a?.attempt.prNumber ?? a?.prAttempts[0]?.prNumber ?? null;
  };
  const implPrs = moving.flatMap((w) => { const pr = w.kind === "pr" ? null : prOf(w); return pr === null ? [] : [{ repo: w.repo, number: pr }]; });
  const legs = new Map([...prLegs, ...await loadLegs(db, implPrs, { activeOnly: true, latestOnly: true })]);
  const inCi: { w: Waiter; pr: number; head: string }[] = [];
  for (const w of moving) {
    const pr = prOf(w);
    if (pr === null) continue;
    const p = (legs.get(`${w.repo}#${pr}`) ?? []).find((l) => l.workflow_id === w.id && (l.state === "ci" || l.state === "queued"));
    if (!p?.head) continue;
    const merge = actionsOf.get(w.id)?.find((a) => a.kind === "merge" && a.number === pr && a.head === p.head && a.state === "waiting-token");
    if (merge) add(w.id, t("Waiting for {login} to sign in to AutoCraft, so the merge runs as them", { login: merge.by }));
    else if (p.state === "ci") inCi.push({ w, pr, head: p.head });
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

const HOLD_WORD: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };

// What an approved workflow's merge leg waits for when nothing can move it on: the merge, made as the approver, waiting for them
// to sign in; or the pre-merge check of the PR's head, due once the leg is in `ci`, with no Task Runner that may take it, or only
// the approver's own runners, none of which can claim now (src/remote/takers.ts waitingOn). For a closed workflow: what keeps the
// close from being made. The status comment, the item page and the agent show it as the state line.
import { loadImplementFacts } from "../data/implement/index.ts";
import { loadPremerge, PREMERGE_MAX_TRIES } from "../data/review/index.ts";
import { loadActions, loadLegs } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { t, tk } from "../i18n/index.ts";
import { takerTest, waitingOn, type RunnerHold } from "../remote/takers.ts";
import type { ItemWorkflow } from "./types.ts";

/** The PR the workflow's merge leg is on: the item, or an implement workflow's latest implementation PR. */
async function legPr(db: Db, wf: Pick<ItemWorkflow, "repo" | "number" | "kind">): Promise<number | null> {
  if (wf.kind === "pr") return wf.number;
  const a = (await loadImplementFacts(db, [{ repo: wf.repo, number: wf.number }])).byIssue.get(`${wf.repo}#${wf.number}`);
  return a?.attempt.prNumber ?? a?.prAttempts[0]?.prNumber ?? null;
}

/** What became of a close that is not made: it waits for its person, for the Act step, or it did not run. Null once it is made. */
async function closeWait(db: Db, wf: Pick<ItemWorkflow, "id">): Promise<string | null> {
  const a = [...(await loadActions(db, { workflowIds: [wf.id], kinds: ["close", "comment-close"] })).values()].flat().at(-1);
  switch (a?.state) {
    case "pending": return t("Closing as {login}", { login: a.by });
    case "waiting-token": return t("Waiting for {login} to sign in to AutoCraft, so the close runs as them", { login: a.by });
    case "waiting-permission": return t("Not closed: {login} has no write access here", { login: a.by });
    case "failed": case "skipped": case "stopped": return t("Not closed: {why}", { why: a.reason ?? a.state });
    default: return null;
  }
}

/**
 * The state line of a workflow whose merge leg waits for its approver's sign-in, or for a pre-merge check that no Task Runner can
 * take, or that only the own runners of the people whose work it is take while none of them can claim (offline, held for its
 * usage, cooling off), or whose close is not made; else null.
 */
export async function legWait(db: Db, wf: Pick<ItemWorkflow, "id" | "repo" | "number" | "kind" | "state">, nowMs: number = Date.now()): Promise<string | null> {
  if (wf.state === "closed") return await closeWait(db, wf);
  if (wf.state !== "running" && wf.state !== "waiting") return null;
  const pr = await legPr(db, wf);
  if (pr === null) return null;
  const [legs, actions] = await db.together(() => Promise.all([
    loadLegs(db, [{ repo: wf.repo, number: pr }], { activeOnly: true, latestOnly: true }),
    loadActions(db, { workflowIds: [wf.id] }),
  ]));
  const p = (legs.get(`${wf.repo}#${pr}`) ?? []).find((l) => l.workflow_id === wf.id && (l.state === "ci" || l.state === "queued"));
  if (!p?.head) return null;
  const merge = [...actions.values()].flat().find((a) => a.kind === "merge" && a.number === pr && a.head === p.head && a.state === "waiting-token");
  if (merge) return t("Waiting for {login} to sign in to AutoCraft, so the merge runs as them", { login: merge.by });
  if (p.state !== "ci") return null;
  const pm = (await loadPremerge(db, [{ repo: wf.repo, number: pr, head: p.head }])).get(`${wf.repo}#${pr}@${p.head}`) ?? null;
  if (pm && (pm.findings !== null || pm.tries >= PREMERGE_MAX_TRIES)) return null;
  const call = { prompt_id: "", repos: [wf.repo], step: "premerge", refs: [{ repo: wf.repo, number: pr }] };
  if (!await takerTest(db, nowMs)(call)) return t("Waiting for the pre-merge check: no Task Runner can take it");
  const [first] = await waitingOn(db, call, nowMs);
  return first ? t("Waiting for {login}'s Task Runner ({why})", { login: first.login, why: t(HOLD_WORD[first.hold]) }) : null;
}

const HOLD_WORD: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };

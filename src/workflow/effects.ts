// What a maintainer's command does to the machinery that already works: the review-again mark, operator fix-ups, pre-approved
// merges (the merge leg, owned through preapprovals.workflow_id), the close made as the person (a `workflow_actions` row the
// action executor carries out), autorepin and the stop of every queued step. A start, an answer and a close check first and return
// what they write; the command core (apply.ts) writes that in one transaction with the workflow row, so no check reads state the
// command itself creates and a refusal leaves nothing behind. Nothing here touches item_workflows.
import { endWorkspace } from "../build/workspaces.ts";
import { resumeStage, setPipelineFlags } from "../data/control/index.ts";
import { cancelUnopened } from "../data/implement/index.ts";
import { releaseHeld } from "../data/intake/index.ts";
import { withdrawItemCalls } from "../data/runners/index.ts";
import { adoptLegs, endFixupRequests, holdMerges, listWorkflowLegs, listWorkflows, loadActions, loadFixupRequests, loadHolds, loadLegs, releaseMerges, saveActions, type CloseAs, type Preapproval } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import type { Exec } from "../fixup/git.ts";
import { queueLaneActions } from "../github/user-lane.ts";
import { t } from "../i18n/index.ts";
import { removeFromBatch } from "../merge/controls.ts";
import { byHand, conflictPath } from "../core/decide.ts";
import { loadPrFact } from "../core/facts.ts";
import { cancelPreapproval, checkFixup, checkMergeLeg, inActiveBatch, INSTRUCTIONS_MAX, PreapprovalRefused, type CheckedStep } from "../preapproval/index.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { requestRepin } from "../repin/index.ts";
import { markReviewsStale } from "../review/discussion.ts";
import type { ItemKind, ItemWorkflow, PlanPart, Surface } from "./types.ts";

/** A legacy step refused the command; its message says why, translated (`effectText`). */
export class EffectError extends Error {}

/**
 * The refusals of the legacy steps a command runs on, as translated text. The steps write English for logs and the classic pages; a
 * refusal this table does not know stays as written.
 */
const LEGACY_TEXT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(\S+#\d+) is not a pull request$/, (m) => t("{ref} is not a pull request.", { ref: m[1]! })],
  [/^(\S+#\d+) is not open$/, (m) => t("{ref} is not open.", { ref: m[1]! })],
  [/^(\S+#\d+) is outside the pipeline's scope/, (m) => t("{ref} is outside the pipeline's scope.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: it is a draft$/, (m) => t("{ref} is a draft, so it cannot be reviewed yet.", { ref: m[1]! })],
  [/^(\S+#\d+) has no head commit in the mirror yet$/, (m) => t("AutoCraft has not read the head commit of {ref} yet.", { ref: m[1]! })],
  [/^the PR changed after your comment; comment again$/, () => t("The pull request changed after the command was written. Send it again.")],
  [/^pushing is not approved for (\S+)$/, (m) => t("Pushing is not approved for {repo}. An operator or a maintainer of the repo can turn it on, on the Repos page.", { repo: m[1]! })],
  [/^(\S+#\d+) already has a pre-approved merge in progress$/, (m) => t("{ref} is already on its way to a merge.", { ref: m[1]! })],
  [/^(\S+#\d+) conflicts with its base branch/, (m) => t("{ref} conflicts with its base branch: the conflict merge comes first.", { ref: m[1]! })],
  [/^can't push to the contributor's branch$/, () => t("AutoCraft can't push to the contributor's branch.")],
  [/^the fix-up tries for this PR are used up$/, () => t("The fix-up tries for this pull request are used up.")],
  [/^a fix-up of (\S+#\d+) is already queued$/, (m) => t("A fix-up of {ref} is already queued.", { ref: m[1]! })],
  [/^the instructions are over (\d+) characters$/, (m) => t("The fix-up instructions are over {n} characters.", { n: m[1]! })],
  [/^the author's permission on the repository could not be read yet/, () => t("The author's permission on the repository could not be read yet. Try again.")],
  [/^(\S+#\d+) has no pre-approved merge in progress$/, (m) => t("{ref} is not on its way to a merge.", { ref: m[1]! })],
];

/** A legacy step's refusal as translated text; unknown text stays as written. */
export function effectText(message: string): string {
  for (const [re, text] of LEGACY_TEXT) {
    const m = re.exec(message);
    if (m) return text(m);
  }
  return message;
}

export type Target = { repo: string; number: number; kind: ItemKind; head: string | null };
/** `workflowId`: the item's live workflow, whose merge legs (possibly on another item: an issue's implementation PR) a stop ends. */
export type Ctx = { db: Db; by: string; via: Surface; at: string; item: Target; exec?: Exec; workflowId?: number; /** The head of the question it answers, when pushes of ours lead from it to the item's. */ shown?: string };

const ref = (t: { repo: string; number: number }): string => `${t.repo}#${t.number}`;

/** Turns a refusal of an existing step into an EffectError, so the item's line says why and the other items go on. */
async function step<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof EffectError ? e : new EffectError(effectText((e as Error).message));
  }
}

/** The PR's active merge leg. */
const activeLeg = async (db: Db, t: Target): Promise<Preapproval | null> =>
  (await loadLegs(db, [{ repo: t.repo, number: t.number }], { activeOnly: true })).get(ref(t))?.at(-1) ?? null;

// ---- starts --------------------------------------------------------------------------------------------------------------

/** What a checked command writes, in the caller's transaction, for the workflow: a refusal rolls it back. */
export type Write = (workflowId: number) => Promise<void>;
const nothing: Write = async () => {};

const writeOf = (s: CheckedStep): Write => async (id) => {
  try {
    await s.write(id);
  } catch (e) {
    throw e instanceof PreapprovalRefused ? new EffectError(effectText(e.message)) : e;
  }
};

/** The merge leg: a pre-approved merge at the current head, or the one already in progress (`had`). */
async function mergeLeg(c: Ctx, had: Preapproval | null): Promise<Write> {
  if (had === null) return writeOf(await step(() => checkMergeLeg(c.db, { repo: c.item.repo, number: c.item.number, by: c.by, via: c.via, ...(c.item.head ? { head: c.item.head } : {}), ...(c.shown ? { fromHead: c.shown } : {}) })));
  const owner = had.workflow_id;
  if (owner === null) return async (id) => void await adoptLegs(c.db, [{ id: had.id, workflowId: id }]);
  // A merge is made through its own workflow's leg. One of another live workflow (the PR's issue) is already at work; one whose workflow
  // ended is cancelled by the pre-approval pass, and this workflow's leg starts after it (src/workflow/advance.ts).
  if (owner !== c.workflowId && (await listWorkflows(c.db, { ids: [owner], live: true })).length) throw new EffectError(t("{ref} is already on its way to a merge.", { ref: ref(c.item) }));
  return nothing;
}

/**
 * Starts the item at `entry`. Review and Fix-up mark the PR for a review of its current head (the fix-up follows from what the
 * review finds); the merge queue pre-approves the merge; an implement start is the workflow row itself. An approved PR gets its
 * merge leg at once.
 */
export async function start(c: Ctx, entry: ItemWorkflow["entry"], approved: boolean): Promise<Write> {
  const { db, by, item } = c;
  if (entry === "implement") return nothing;
  const leg = approved || entry === "merge" ? await mergeLeg(c, await activeLeg(db, item)) : nothing;
  return async (id) => {
    await leg(id);
    if (entry !== "merge") await markReviewsStale(db, by, item.repo, item.number);
  };
}

// ---- answers on a started item -------------------------------------------------------------------------------------------

/** The fix-up instructions for the named parts of the plan; the latest review's fixes when the plan names none. */
export function fixInstructions(plan: readonly PlanPart[], fix: readonly number[]): string {
  const parts = plan.filter((p) => fix.includes(p.n));
  if (!parts.length) return "Make the fixes the latest review of this pull request lists.";
  let out = "Fix these findings of the review, and nothing else:";
  for (const p of parts) {
    const line = `\n${p.n}. ${p.title}${p.file ? ` (${p.file})` : ""}`;
    if (out.length + line.length > INSTRUCTIONS_MAX) break;
    out += line;
  }
  return out;
}

/**
 * What runs again on a started PR: a review of the current head, or a fix-up of the named parts. With `merges`, the fix-up
 * carries the merge (a new pre-approval in `fixup`), unless a pre-approved merge is already in progress; a PR with no fix-up
 * this time gets its merge leg when it has none. No fix-up can be made on a PR that conflicts with its base branch (conflictPath). Where the
 * pipeline merges the base into an approved PR, the fix-up follows that merge (`note` says so): the pipeline makes a take-fix review's
 * minor fixes itself, and any other fix-up waits as a request. Where a person has to resolve the conflict, only the merge leg starts, and
 * waits for them (`waits`).
 */
export async function again(c: Ctx, o: { again: "review" | "fixup" | null; plan: readonly PlanPart[]; fix: readonly number[]; merges: boolean }): Promise<{ write: Write; note?: string; waits?: "contributor" | "person" }> {
  const { db, by, item } = c;
  if (item.kind !== "pr") return { write: nothing };
  const had = o.merges ? await activeLeg(db, item) : null;
  const f = o.merges ? await loadPrFact(db, item.repo, item.number) : null;
  const path = conflictPath(f);
  if (byHand(path) && o.again !== "review") return { write: await mergeLeg(c, had), waits: path, note: t("New commits come back to you.") };
  const first = path === "merge" ? t("{ref} conflicts with its base branch: that merge comes first, then the review's fixes.", { ref: ref(item) })
    : path === "tomorrow" ? t("{ref} conflicts with its base branch, and today's merges of that branch into it are used up: that merge comes first, tomorrow.", { ref: ref(item) }) : null;
  const note = first !== null && (o.again === "fixup" || path === "tomorrow") ? { note: first } : {};
  // A major finding the person said to fix would come back as a question at the next head; their request is the answer to it.
  const major = o.plan.some((p) => p.major && o.fix.includes(p.n));
  if (o.again === "fixup" && path !== null && f?.review?.verdict === "take-fix" && !major) return { write: await mergeLeg(c, had), ...note };
  if (o.again === "fixup") {
    const merge = o.merges && had === null;
    const fix = writeOf(await step(() => checkFixup(db, { repo: item.repo, number: item.number, by, instructions: fixInstructions(o.plan, o.fix), merge, afterBase: path !== null })));
    const leg = o.merges && !merge ? await mergeLeg(c, had) : nothing;
    return { write: async (id) => { await leg(id); await fix(id); }, ...note };
  }
  const leg = o.merges ? await mergeLeg(c, had) : nothing;
  return {
    ...note, ...(byHand(path) ? { waits: path } : {}),
    write: async (id) => {
      await leg(id);
      if (o.again === "review") await markReviewsStale(db, by, item.repo, item.number);
    },
  };
}

// ---- stop, backlog, close ------------------------------------------------------------------------------------------------

/**
 * Stops everything that runs or waits for the item: its pre-approved merge (out of its batch first), queued fix-ups, its place in
 * an integration batch, queued model calls made for it alone, the implementation attempt of an issue that has no PR yet, and the
 * merge legs of the workflow's implementation PRs, and a close nobody made yet. Leased calls finish; nothing acts on their result once the workflow stopped.
 * Every part runs; the ones that could not stop are returned.
 */
export async function stopAll(c: Ctx): Promise<string[]> {
  const { db, by, item, at } = c;
  const why = `stopped by ${by}`;
  const failed: string[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { failed.push(effectText((e as Error).message)); }
  };
  const one = [{ repo: item.repo, number: item.number }];
  await stopCloses(c);
  if (item.kind === "pr") {
    const [active, requests, holds] = await db.together(() => Promise.all([
      activeLeg(db, item), loadFixupRequests(db, { open: true, refs: one, anyMaker: true }), loadHolds(db, { refs: one }),
    ]));
    if (active !== null) await attempt(() => cancelPreapproval(db, by, item.repo, item.number, c.exec, c.via));
    await endFixupRequests(db, requests.filter((r) => r.state === "queued").map((r) => ({ id: r.id, reason: why })));
    if (await inActiveBatch(db, item.repo, item.number)) {
      await attempt(async () => {
        await removeFromBatch(db, by, item.repo, item.number, c.exec);
        if (!holds.has(ref(item))) await releaseMerges(db, one, by);
      });
    }
  } else {
    for (const w of await cancelUnopened(db, [{ ...one[0]!, reason: why }], by, at)) {
      if (w.workspaceId !== null) await endWorkspace(db, w.workspaceId);
    }
  }
  // The workflow's merge legs on other items: an issue's implementation PRs.
  if (c.workflowId !== undefined && item.kind === "issue") {
    for (const p of await listWorkflowLegs(db, [c.workflowId])) {
      await attempt(() => cancelPreapproval(db, by, p.repo, p.number, c.exec, c.via));
    }
  }
  await withdrawItemCalls(db, ref(item), why);
  return failed;
}

/** Takes back the closes of the item, and those its workflow made of other items, that are still to be made: queued, or waiting for their person's sign-in or access. */
export async function stopCloses(c: Ctx): Promise<void> {
  const open = ["pending", "waiting-token", "waiting-permission"] as const;
  const of = { kinds: ["close", "comment-close"], states: open } as const;
  const maps = await c.db.together(() => Promise.all([
    loadActions(c.db, { refs: [{ repo: c.item.repo, number: c.item.number }], ...of }), ...(c.workflowId === undefined ? [] : [loadActions(c.db, { workflowIds: [c.workflowId], ...of })]),
  ]));
  const rows = maps.flatMap((m) => [...m.values()].flat());
  await saveActions(c.db, rows.map((a) => ({ id: a.id, state: "stopped", reason: `stopped by ${c.by}`, at: c.at })), { from: open });
}

/**
 * Queues the close of the item as the person: a close action the action executor carries out (a comment as the app, then the close
 * through the user lane). A PR's action names its current head, so a push after the command stops the close. Everything that runs is
 * stopped first (`stopAll`), so no fix-up pushes to an item about to close.
 */
export async function queueClose(c: Ctx, workflowId: number, item: Target, closeAs: CloseAs | null = null): Promise<void> {
  const { db, by, at } = c;
  await queueLaneActions(db, [{ workflowId, repo: item.repo, number: item.number, kind: "comment-close", by, head: item.kind === "pr" ? item.head : null, at, closeAs }]);
}

// ---- autorepin -----------------------------------------------------------------------------------------------------------

/** The existing autorepin command, unchanged: `<pull request> [via <branch>]` or `off`. The caller has applied the act rule. */
export async function autorepin(c: Ctx, args: string, githubId: number | null): Promise<string> {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args.trim());
  if (!m) throw new EffectError(t("autorepin needs a pull request, or off."));
  const off = m[1]!.toLowerCase() === "off";
  const prRef = off ? null : parsePrRef(m[1]!);
  if (!off && !prRef) throw new EffectError(t("{ref} is not a pull request.", { ref: m[1]! }));
  if (githubId === null) throw new EffectError(t("AutoCraft has no GitHub id for {login} yet. Sign in to the dashboard once.", { login: c.by }));
  return await step(() => requestRepin(c.db, {
    login: c.by, githubId, role: "", canWrite: true, authorized: true, repo: c.item.repo, number: c.item.number, pr: c.item.kind === "pr",
    ref: prRef, branch: m[2] ? parseBranch(m[2]) : null, at: new Date(c.at),
  }));
}

// ---- controls ------------------------------------------------------------------------------------------------------------

/** Keeps an approved PR out of the next merge until it is released. Returns false when it was already held. */
export async function hold(c: Ctx): Promise<boolean> {
  if (c.item.kind !== "pr") throw new EffectError(t("{ref} is not a pull request.", { ref: ref(c.item) }));
  return (await step(() => holdMerges(c.db, [{ repo: c.item.repo, number: c.item.number, by: c.by, details: { via: c.via } }]))).length > 0;
}
export const release = async (c: Ctx): Promise<boolean> => (await step(() => releaseMerges(c.db, [{ repo: c.item.repo, number: c.item.number }], c.by))).length > 0;
export const releaseHeldItem = async (c: Ctx): Promise<void> => { await step(() => releaseHeld(c.db, c.by, [{ repo: c.item.repo, number: c.item.number }])); };
export const resumeBreaker = (db: Db, by: string, key: string): Promise<void> => step(() => resumeStage(db, key, by));
/** The repo's Automatic switch: whether AutoCraft works its items without a person picking them (the per-repo Pipeline switch). */
export const setAutomatic = async (db: Db, by: string, repo: string, on: boolean): Promise<boolean> => (await step(() => setPipelineFlags(db, [{ repo, on }], by))).changed.length > 0;

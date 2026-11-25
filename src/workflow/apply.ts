// The command core: every surface (GitHub, Discord, the agent, the dashboard, the CLI) parses text with parse.ts and hands the
// result here. For each item it checks the repo is tracked and that the person may act (actRefusal in src/github/identity.ts), resolves
// the text against the item's workflow (resolve.ts), checks the run on the existing machinery (effects.ts), writes the workflow
// row, what the machinery works on and the event in one write, and returns the line every surface shows (status.ts).
//
// A list of items runs item by item: one that is refused or fails leaves the others running, and the reply lists it. GitHub takes
// one item per comment. Each person has an hourly number of items per surface, counted from the recorded events so every
// process and replica shares it.
import * as access from "../data/access/index.ts";
import { loadAccess } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadImplementFacts, recordAnswers } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { setCallLevels } from "../data/runners/index.ts";
import { countEventsSince, listWorkflows, loadActions, loadLinks, loadPrWorkflows, loadWorkflowHistory, recordEvents, retryActions, sameWorkflow, saveWorkflows, startWorkflows, type CloseAs, type WorkflowAction, type WorkflowPatch } from "../data/workflow/index.ts";
import { t } from "../i18n/index.ts";
import { chainsOwn } from "../core/evidence.ts";
import { ACTION_WAITS } from "../core/may.ts";
import { parseTripKey } from "../core/push-outcome.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import type { Db } from "../db/index.ts";
import type { Exec } from "../fixup/git.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { claimLevels } from "../remote/level.ts";
import { actRefusal } from "../github/identity.ts";
import { settlesNow } from "../preapproval/permissions.ts";
import * as fx from "./effects.ts";
import { isOpenQuestion } from "./question.ts";
import { isLive, resolve, type Run } from "./resolve.ts";
import { attributionLines, confirmLine, currentStep, listText, recommendationLine, replyLine, stateLine, stepsFor, utcClock, workflowSteps, type Clock } from "./status.ts";
import { asksForApprover, WEIGHT_NORMAL, type CloseReason, type ItemKind, type ItemRef, type ItemWorkflow, type Parsed, type QuestionRef, sameQuestion, type Surface, type WorkflowEventKind } from "./types.ts";
import { takenOver } from "./work.ts";

/** Who sent the command. `canWrite` reads the person's live write permission on a repo; `githubId` is needed by autorepin only. */
export type Actor = { login: string | null; canWrite: (repo: string) => Promise<boolean>; githubId?: number | null };

export type CommandInput = {
  parsed: Parsed;
  /** The item the text was written on (or the items a panel selected); a list in the text takes their place. */
  items: ItemRef[];
  /** The only head the command may act on, for a single PR: the head when the comment was written. */
  head?: string;
  /** Repos the sender may see; any other reads as untracked. */
  visible?: (repo: string) => Promise<boolean>;
  at?: string;
  exec?: Exec;
  clock?: Clock;
  /**
   * When the question the person read on the item (`ref`: repo#number, as they named it) was asked, as their surface showed it, or a time they
   * had read it by; null or undefined when the surface cannot tell.
   */
  asked?: (o: { ref: string; workflow: ItemWorkflow }) => string | null | undefined;
  /** The app's mention name, for replies that tell the sender what to write back. */
  mention?: string;
};

export type ItemOutcome = { repo: string; number: number; outcome: "run" | "ambiguous" | "refused"; line: string; workflowId: number | null; /** The question the line shows: it took the place of the one the person answered. */ question?: { workflowId: number; recAt: string } };
export type CommandResult = { items: ItemOutcome[]; lines: string[] };

/** The actions that close an item as the person, and their states before they end. */
const CLOSE_KINDS = ["close", "comment-close"] as const;
const OPEN_ACTIONS = ["pending", "waiting-token", "waiting-permission"] as const;

/** Items a person may send per hour on each surface; the CLI runs on the box and has none. */
export const COMMAND_LIMITS: Record<Surface, number> = { dashboard: 200, agent: 200, discord: 60, github: 30, cli: Number.POSITIVE_INFINITY };
const HOUR_MS = 3_600_000;

const refText = (repo: string, n: number): string => `${slugOf(repo)}#${n}`;

function refusalLine(r: access.ActRefusal, login: string | null, repo: string): string {
  switch (r) {
    case "no-login": return login ? t("{login} has no AutoCraft login. Sign in to AutoCraft to send commands.", { login }) : t("Sign in to AutoCraft to send commands.");
    case "no-role": return t("Only maintainers and operators send commands to AutoCraft.");
    case "no-write": return t("{login} has no write access to {repo}.", { login: login ?? "", repo: slugOf(repo) });
    case "box-identity": return t("Commands wait until AutoCraft acts on GitHub as the person, through the GitHub App.");
  }
}

/** The tracked repo a command names (`name` or `owner/name`), or null. */
function trackedRepo(tracked: ReadonlySet<string>, written: string): string | null {
  const [owner, name] = written.includes("/") ? written.split("/", 2) as [string, string] : [null, written];
  if (!tracked.has(name)) return null;
  return owner === null || owner.toLowerCase() === ownerOf(name).toLowerCase() ? name : null;
}

type ItemNow = { kind: ItemKind; state: string; head: string | null };
/** Items' live workflows, the live workflow of another item (the issue it implements) that works on each PR, and the closes still to be made. */
type Work = { live: Map<string, ItemWorkflow>; works: Map<string, ItemWorkflow>; closing: Map<string, WorkflowAction[]> };
/** What a command batch reads once for all its items. `many`: a list; a run may change the work on an item later in it, which is read again. */
type Batch = Work & { tracked: Set<string>; items: Map<string, ItemNow>; many: boolean };

async function loadWork(db: Db, refs: { repo: string; number: number }[]): Promise<Work> {
  if (!refs.length) return { live: new Map(), works: new Map(), closing: new Map() };
  const open = { kinds: CLOSE_KINDS, states: OPEN_ACTIONS };
  const [history, works, closes] = await db.together(() => Promise.all([loadWorkflowHistory(db, refs), loadPrWorkflows(db, refs, { others: true }), loadActions(db, { refs, ...open })]));
  const live = new Map<string, ItemWorkflow>(), closing = new Map<string, WorkflowAction[]>(closes), closed = new Map<number, string>();
  for (const [key, all] of history) {
    const running = all.findLast((w) => isLive(w)), last = all.at(-1);
    if (running) live.set(key, running);
    else if (last?.state === "closed" && last.kind === "issue" && !closing.has(key)) closed.set(last.id, key);
  }
  // An issue whose work ended with a close of its implementation PR.
  const ofIssues = closed.size ? [...(await loadActions(db, { workflowIds: [...closed.keys()], ...open })).values()].flat() : [];
  for (const a of ofIssues) closing.set(closed.get(a.workflow_id)!, [a]);
  return { live, works: new Map(works), closing };
}

async function loadBatch(db: Db, written: readonly ItemRef[]): Promise<Batch> {
  const tracked = new Set((await loadTrackedRepos(db)).keys());
  const refs = written.flatMap((x) => { const repo = trackedRepo(tracked, x.repo); return repo ? [{ repo, number: x.number }] : []; });
  const [items, work] = await db.together(() => Promise.all([refs.length ? loadItems(db, refs, "pr") : new Map(), loadWork(db, refs)]));
  return {
    ...work, tracked, many: written.length > 1,
    items: new Map([...items].map(([k, it]) => [k, { kind: it.kind as ItemKind, state: it.state, head: it.head_oid }])),
  };
}

/** Reads the work on one item of the batch again. */
async function refresh(db: Db, batch: Batch, repo: string, number: number): Promise<void> {
  const key = `${repo}#${number}`;
  const now = await loadWork(db, [{ repo, number }]);
  const put = <T>(m: Map<string, T>, v: T | undefined): void => void (v === undefined ? m.delete(key) : m.set(key, v));
  put(batch.live, now.live.get(key));
  put(batch.works, now.works.get(key));
  put(batch.closing, now.closing.get(key));
}

/** Runs parsed text from `actor` on each item, and returns one outcome and line per item. */
export async function runCommand(db: Db, actor: Actor, via: Surface, input: CommandInput): Promise<CommandResult> {
  const at = input.at ?? new Date().toISOString();
  const p = input.parsed;
  const targets = p.kind !== "ambiguous" && p.items?.length ? p.items : input.items;
  const all = (line: string): CommandResult => ({ items: targets.map((x) => ({ repo: x.repo, number: x.number, outcome: "refused", line, workflowId: null })), lines: [line] });
  if (!targets.length) return { items: [], lines: [t("Name an item for the command.")] };
  if (via === "github" && targets.length > 1) return all(t("One item per comment on GitHub. Send a list from the dashboard, Discord or your agent."));
  if (actor.login && await countEventsSince(db, { login: actor.login, via, since: new Date(Date.parse(at) - HOUR_MS).toISOString() }) + targets.length > COMMAND_LIMITS[via]) {
    return all(t("Too many commands from {login} in the last hour. Try again later.", { login: actor.login }));
  }
  const batch = await loadBatch(db, targets);
  const items: ItemOutcome[] = [];
  for (const target of targets) {
    const repo = batch.many && items.some((o) => o.outcome === "run") ? trackedRepo(batch.tracked, target.repo) : null;
    if (repo !== null) await refresh(db, batch, repo, target.number);
    items.push(await runOne(db, actor, via, input, target, at, batch));
  }
  const many = items.length > 1;
  const lines = items.map((o) => (many ? t("{ref}: {line}", { ref: refText(o.repo, o.number), line: o.line }) : o.line));
  const failed = items.filter((o) => o.outcome !== "run");
  if (many && failed.length) lines.push(t("Not run: {refs}.", { refs: listText(failed.map((o) => refText(o.repo, o.number))) }));
  return { items, lines };
}

/** The workflow changed between the read the command was resolved on and its write. */
class Moved extends Error {}
/** How often a command is resolved again on a workflow that changed under it. */
const MOVED_TRIES = 3;

/** A command that means what the item showed when it was written: a yes, parts by their numbers, or an option named on its own. */
const byWhatWasShown = (p: Parsed): boolean => p.kind !== "commands" || p.parts.some((x) => "part" in x && typeof x.part === "number");

/** Runs the command on one item; when the workflow changed meanwhile (the advance pass, another person), on what it is now. */
async function runOne(db: Db, actor: Actor, via: Surface, input: CommandInput, target: ItemRef, at: string, batch: Batch): Promise<ItemOutcome> {
  for (let tries = 1; ; tries++) {
    try {
      return await tryOne(db, actor, via, input, target, at, batch);
    } catch (e) {
      if (!(e instanceof Moved)) throw e;
      const repo = trackedRepo(batch.tracked, target.repo)!;
      const key = `${repo}#${target.number}`;
      const shown = (): string => {
        const w = batch.live.get(key) ?? batch.works.get(key);
        return JSON.stringify([w?.rec ?? null, w?.plan ?? []]);
      };
      const was = shown();
      await refresh(db, batch, repo, target.number);
      const now = batch.live.get(key) ?? batch.works.get(key);
      // A yes answers the recommendation the person read, not one that took its place; a number names a part of the plan they read.
      const other = byWhatWasShown(input.parsed) && shown() !== was;
      if (other || tries === MOVED_TRIES) {
        return { repo, number: target.number, outcome: "refused", line: t("The work on {ref} changed a moment ago. Send the command again.", { ref: refText(repo, target.number) }), workflowId: now?.id ?? null };
      }
    }
  }
}

/** Why a PR that the live workflow of its issue works on starts no work of its own (or the other way round): where the work runs and how it stands. */
function worksElsewhere(ref: string, w: ItemWorkflow, clock: Clock = utcClock): string {
  const on = refText(w.repo, w.number);
  return [
    t("{ref} is part of the work on {on} ({who}): {state}.", { ref, on, who: attributionLines(w, null, clock).join("; "), state: stateLine(w, currentStep(workflowSteps(w, "other")), clock) }),
    recommendationLine(w.rec), t("Send the command on {on}.", { on }),
  ].filter((x) => x !== null).join(" ");
}

const says = (p: Parsed, ...words: string[]): boolean => p.kind === "commands" && p.parts.some((x) => words.includes(x.word));
/** The words that make an item a piece of work of its own: the entries, and the backlog. */
const startsWork = (p: Parsed): boolean => says(p, "review", "fix-up", "implement", "backlog");

async function tryOne(db: Db, actor: Actor, via: Surface, input: CommandInput, target: ItemRef, at: string, batch: Batch): Promise<ItemOutcome> {
  const repo = trackedRepo(batch.tracked, target.repo);
  const out = (outcome: ItemOutcome["outcome"], line: string, workflowId: number | null = null): ItemOutcome =>
    ({ repo: repo ?? target.repo, number: target.number, outcome, line, workflowId });
  if (!repo || (input.visible && !await input.visible(repo))) return out("refused", t("{repo} is not a repository AutoCraft tracks.", { repo: target.repo }));
  const no = await actRefusal(db, actor, repo);
  if (no) return out("refused", refusalLine(no, actor.login, repo));
  const login = actor.login!;
  const ref = refText(repo, target.number);
  const key = `${repo}#${target.number}`;
  const it = batch.items.get(key);
  if (!it) return out("refused", t("{ref} is not an item AutoCraft has read.", { ref }));
  if (it.state !== "OPEN") return out("refused", t("{ref} is not open.", { ref }));
  const kind = it.kind;
  const head = input.head ?? it.head ?? null;
  if (input.head !== undefined && it.head !== input.head) return out("refused", t("{ref} changed after the command was written. Send it again.", { ref }));

  // One workflow works on a PR at a time. The PR of a live implement workflow starts nothing of its own; every other command on it
  // (stop, an answer, the approval, the weight, a close) acts on the issue's workflow, as if it were written there.
  const own = batch.live.get(key) ?? null;
  const issue = kind === "pr" ? batch.works.get(key) ?? null : null;
  const covered = own === null && !says(input.parsed, "autorepin") ? issue : null;
  if (covered && startsWork(input.parsed)) return out("refused", worksElsewhere(ref, covered, input.clock), covered.id);
  const work = covered ?? own;
  // An approval whose maker may no longer act on the repo, or that the item asks to have made again, approves nothing: whoever goes on with the merge approves it anew.
  const lapsed = !!work?.approvedBy && (asksForApprover(work) || (work.approvedBy.toLowerCase() !== login.toLowerCase() && await settlesNow(db, work.approvedBy, repo) === "no"));
  const wf = work && lapsed ? { ...work, approvedBy: null, approvedAt: null, approvedVia: null } : work;
  const said: fx.Target = { repo, number: target.number, kind, head };
  const on: fx.Target = covered ? { repo, number: covered.number, kind: covered.kind, head: null } : said;
  const reply = (line: string): string => (covered ? t("{ref}: {line}", { ref: refText(on.repo, on.number), line }) : line);
  const noted = (line: string): string => (covered ? t("{line} Sent on {ref}.", { line, ref }) : line);
  const closing = batch.closing.get(key)?.at(-1) ?? null;
  // A merge of the sender's that waits for their own sign-in or access: approving it again tries it again.
  const waiting = wf?.approvedBy?.toLowerCase() === login.toLowerCase() ? await waitingMerges(db, wf, login) : [];
  const r = resolve(input.parsed, { kind: on.kind, workflow: wf, closing: closing !== null, mergeWaits: waiting.length > 0 });
  const started = r.kind === "run" && r.run.start === "implement" ? await prWorkflow(db, { repo, number: target.number }) : undefined;
  if (started) return out("refused", worksElsewhere(ref, started, input.clock), started.id);
  const event = (kind: WorkflowEventKind, workflowId: number | null, line: string, item: { repo: string; number: number } = on) =>
    ({ workflowId, repo: item.repo, number: item.number, login, via, kind, parsed: input.parsed, line, at, ...(kind === "answered" ? { seenAt: wf?.recAt ?? null } : {}) });
  if (r.kind === "ambiguous") {
    const line = replyLine(r, input.clock, input.mention);
    await recordEvents(db, [event("ambiguous", wf?.id ?? null, noted(line))]);
    return out("ambiguous", reply(line), wf?.id ?? null);
  }
  // Runs the open question's answer, as against a word that ends the work whatever was asked.
  const accepts = r.kind === "run" && r.run.answers && (r.run.end === null || (r.run.end === "close" && !says(input.parsed, "close")));
  const read = accepts && wf?.recAt ? input.asked?.({ ref: key, workflow: wf }) : null;
  if (read && Date.parse(wf!.recAt!) > Date.parse(read)) {
    const why = t("The question changed after you read it. A new question follows. {question}", { question: recommendationLine(wf!.rec) ?? "" });
    return { ...out("refused", reply(t("Nothing ran on {ref}: {why}", { ref: refText(on.repo, on.number), why })), wf!.id), question: { workflowId: wf!.id, recAt: wf!.recAt! } };
  }
  if (r.kind === "refused") return out("refused", reply(replyLine(r, input.clock, input.mention)), wf?.id ?? null);

  const c: fx.Ctx = { db, by: login, via, at, item: on, ...(input.exec ? { exec: input.exec } : {}) };
  try {
    // A close names the item it was written on; a yes to a recommended close is the issue's, as it would be there.
    const close = r.run.end === "close" && says(input.parsed, "close") ? said : on;
    const closeAs = r.run.close ? await closeAsOf({ ...c, item: close }, r.run.close, batch, input.visible) : null;
    const too = r.run.end !== null ? await endsToo(db, r.run.end, on, wf, own === null ? null : issue) : [];
    const done = await carryOut(c, r.run, isLive(wf) ? wf : null, actor, { closing, closeAs, close, waiting, too, said, accepts });
    const more = too.flatMap((x) => (x.workflow ? [x] : []));
    const line = confirmLine(r.run, login, at, input.clock ?? utcClock, done.waits) + (done.failed.length ? ` ${t("Could not stop: {what}.", { what: done.failed.join("; ") })}` : "")
      + (done.note ? ` ${done.note}` : "")
      + (more.length ? ` ${t("The work on {refs} stopped too.", { refs: listText(more.map((x) => refText(x.item.repo, x.item.number))) })}` : "")
      + (close !== on ? ` ${t("{ref} closes; {on} stays open and its work ends.", { ref, on: refText(on.repo, on.number) })}` : "");
    const id = await db.write(async () => {
      const id = await done.commit();
      await recordEvents(db, [event(eventKind(r.run), id, noted(line)), ...more.map((x) => event("stopped", x.workflow!.id, line, x.item))]);
      return id;
    });
    return out("run", reply(line), id);
  } catch (e) {
    if (!(e instanceof fx.EffectError)) throw e;
    return out("refused", t("Nothing ran on {ref}: {why}", { ref: refText(on.repo, on.number), why: e.message }), wf?.id ?? null);
  }
}

/** What ends with an item's work: `workflow` is the live one on it, if any. */
type Ends = { item: fx.Target; workflow: ItemWorkflow | null };

/**
 * What else ends when the work on `on` (its live workflow `wf`) ends. With an implement workflow, what runs on its PR; a stop halts everything, so
 * it also ends a workflow the PR has of its own, and, written on that PR, the one of its issue (`issue`).
 */
async function endsToo(db: Db, end: "backlog" | "close" | "stop", on: fx.Target, wf: ItemWorkflow | null, issue: ItemWorkflow | null): Promise<Ends[]> {
  if (on.kind === "pr") return end === "stop" && issue ? [{ item: { repo: issue.repo, number: issue.number, kind: issue.kind, head: null }, workflow: issue }] : [];
  const pr = wf ? await implementationPr(db, wf) : null;
  if (!pr) return [];
  const own = (await listWorkflows(db, { live: true, refs: [{ repo: pr.repo, number: pr.number }] }))[0] ?? null;
  return end === "stop" || own === null ? [{ item: pr, workflow: own }] : [];
}

function eventKind(r: Run): WorkflowEventKind {
  if (r.end === "stop") return "stopped";
  if (r.end === "close") return "closed";
  if (r.end === "backlog") return "backlog";
  if (r.autorepin !== null) return "set";
  if (r.start) return "started";
  // An answer to the open recommendation is an answer also when it approves the merge: it accepts what the recommendation showed.
  if (r.answers) return "answered";
  if (r.approve || r.retryMerge) return "approved";
  if (r.weight !== null && !r.again && !r.fix.length && !r.drop.length) return "weighted";
  return "set";
}

/** The close's reason as the action stores it; a duplicate must be another item AutoCraft has read, in a repo the sender sees. */
async function closeAsOf(c: fx.Ctx, reason: CloseReason, batch: Batch, visible?: CommandInput["visible"]): Promise<CloseAs> {
  if (reason.as !== "duplicate") return reason.as;
  const { repo: written, number } = reason.of;
  const repo = written === null ? c.item.repo : trackedRepo(batch.tracked, written);
  if (!repo || (visible && !await visible(repo))) throw new fx.EffectError(t("{repo} is not a repository AutoCraft tracks.", { repo: written ?? c.item.repo }));
  if (repo === c.item.repo && number === c.item.number) throw new fx.EffectError(t("an item can't be a duplicate of itself."));
  if (!(await loadItems(c.db, [{ repo, number }], "ref")).has(`${repo}#${number}`)) throw new fx.EffectError(t("{ref} is not an item AutoCraft has read.", { ref: refText(repo, number) }));
  return `duplicate ${repo}#${number}`;
}

/** `commit` writes the workflow row (started, changed or ended) with the run's own rows and returns its id; it runs in the write that records the event. */
type Done = { commit: () => Promise<number | null>; failed: string[]; note?: string; waits?: "contributor" | "person" };

/** Whether our own pushes alone moved the PR from `from` to `to`. */
const ownSince = async (db: Db, pr: fx.Target, from: string, to: string): Promise<boolean> =>
  from === to || chainsOwn((await loadOwnPushes(db, [{ repo: pr.repo, number: pr.number }])).get(`${pr.repo}#${pr.number}`) ?? [], from, to);

const PUSHED_SINCE = (): string => t("The author pushed commits after the question was asked. A new question follows.");
const CHANGED = (): string => t("The pull request changed after the command was written. Send it again.");

/** Checks the resolved command on the machinery (an end also stops what runs), then returns its write. */
async function carryOut(c: fx.Ctx, r: Run, wf: ItemWorkflow | null, actor: Actor, o: { closing: WorkflowAction | null; closeAs: CloseAs | null; close: fx.Target; waiting: WorkflowAction[]; too: Ends[]; said: fx.Target; accepts: boolean }): Promise<Done> {
  const { db, by, at, via, item } = c;
  const wfId = wf?.id ?? null;
  const unchanged = async (): Promise<number | null> => wfId;
  // An implement workflow's PR, read once however much of the command needs it.
  let read: Promise<fx.Target | null> | undefined;
  const issuePr = (w: ItemWorkflow): Promise<fx.Target | null> => (read ??= implementationPr(db, w));
  // An answer at another head than the question's would accept code nobody was shown.
  let shown: { shown?: string } = {};
  if (o.accepts && wf?.recHead && !r.pick) {
    const pr = item.kind === "pr" ? item : await issuePr(wf);
    if (pr?.head && !await ownSince(db, pr, wf.recHead, pr.head)) throw new fx.EffectError(PUSHED_SINCE());
    if (pr?.head) shown = { shown: wf.recHead };
  }
  if (r.end !== null) {
    if (r.end === "close" && o.close.kind === "pr" && !o.close.head) throw new fx.EffectError(t("AutoCraft has not read the head commit of {ref} yet.", { ref: refText(o.close.repo, o.close.number) }));
    const state = r.end === "stop" ? "stopped" : r.end === "close" ? "closed" : "backlog";
    const end: WorkflowPatch = { state, ...(state === "stopped" ? { stoppedBy: by, stoppedAt: at } : {}), rec: null, blocker: null, blockerParams: null };
    // A stop of a close that is still to be made ends the workflow that close belongs to.
    const stopped = wf === null && r.end === "stop" ? o.closing?.workflow_id ?? null : null;
    const known = wf?.id ?? stopped;
    const failed = await fx.stopAll({ ...c, ...(known !== null ? { workflowId: known } : {}) });
    for (const x of o.too) failed.push(...await fx.stopAll({ ...c, item: x.item, ...(x.workflow ? { workflowId: x.workflow.id } : {}) }));
    const ends = o.too.flatMap((x) => (x.workflow ? [x.workflow.id] : []));
    return {
      failed,
      commit: async () => {
        // An item nobody started gets a row that records the close or the backlog, ended at once.
        const id = known ?? (await startWorkflows(db, [{ repo: item.repo, number: item.number, kind: item.kind, entry: item.kind === "pr" ? "review" : "implement", weight: r.weight ?? WEIGHT_NORMAL, startedBy: by, startedVia: via, baseHead: item.head, at }]))
          .get(`${item.repo}#${item.number}`);
        if (id === undefined) throw new fx.EffectError(t("{ref} was started a moment ago. Send the command again.", { ref: refText(item.repo, item.number) }));
        // A workflow that ended since it was read (another person's stop) keeps its end.
        const live = new Set((await listWorkflows(db, { ids: [...(wf ? [wf.id] : []), ...ends], live: true })).map((x) => x.id));
        if (wf && !live.has(wf.id)) throw new Moved();
        await saveWorkflows(db, [{ id, patch: end, at }, ...ends.filter((x) => live.has(x)).map((x) => ({ id: x, patch: end, at }))]);
        if (r.end === "close") await fx.queueClose(c, id, o.close, o.closeAs);
        return id;
      },
    };
  }
  if (r.autorepin !== null) {
    const githubId = actor.githubId ?? (await loadAccess(db, [by])).get(by.toLowerCase())?.github_id ?? null;
    await fx.autorepin(c, r.autorepin, githubId === null ? null : Number(githubId));
    return { failed: [], commit: unchanged };
  }

  if (r.start) {
    const entry = r.start;
    const weight = r.weight ?? WEIGHT_NORMAL;
    const work = await fx.start(c, entry, r.approve);
    return {
      failed: [],
      commit: async () => {
        const id = (await startWorkflows(db, [{
          repo: item.repo, number: item.number, kind: item.kind, entry, weight, startedBy: by, startedVia: via, baseHead: item.head,
          step: stepsFor(entry, r.approve)[0]!, at, ...(r.approve ? { approvedBy: by, approvedVia: via } : {}),
        }])).get(`${item.repo}#${item.number}`);
        if (id === undefined) throw new fx.EffectError(t("{ref} was started a moment ago. Send the command again.", { ref: refText(item.repo, item.number) }));
        // Work started on the item takes back a close nobody carried out yet.
        if (o.closing) await fx.stopCloses({ ...c, workflowId: o.closing.workflow_id });
        await work(id);
        return id;
      },
    };
  }

  // A started item: weight, an answer, a step again, approval.
  const live = wf!;
  const patch: WorkflowPatch = {};
  if (r.weight !== null && r.weight !== live.weight) patch.weight = r.weight;
  const runs = r.again !== null || r.fix.length > 0 || r.approve || r.answers;
  // An implement workflow's steps after the implementation run on its PR: a review again, fix-ups of the review's parts, the merge leg.
  let on: fx.Ctx = { ...c, ...shown, workflowId: live.id };
  if (live.kind === "issue" && !r.pick && (r.again !== null || r.fix.length > 0 || r.merges)) {
    const pr = await issuePr(live);
    // A command written on the PR is about its head then, and about that PR.
    if (o.said.kind === "pr" && (pr?.number !== o.said.number || (o.said.head !== null && pr.head !== o.said.head))) throw new fx.EffectError(CHANGED());
    if (pr) on = { ...c, ...shown, item: pr, workflowId: live.id };
    else if (r.again !== null || r.fix.length) throw new fx.EffectError(t("{ref} has no open implementation pull request yet.", { ref: refText(item.repo, item.number) }));
  }
  // A new weight also orders the queued calls of the item and of the PR that implements it.
  const weighed = patch.weight === undefined ? [] : [item, ...(live.kind === "issue" ? [await issuePr(live)] : [])].filter((x) => x !== null);
  const work = runs ? await fx.again(on, { again: r.again, plan: live.plan, fix: r.fix, merges: r.merges }) : null;
  if (r.drop.length) patch.plan = live.plan.map((p) => (r.drop.includes(p.n) ? { ...p, state: "dropped" as const } : p));
  // An answered question's options are no plan any more.
  if (r.pick) patch.plan = live.plan.filter((p) => !sameQuestion(p.question, r.pick!.question));
  if (r.approve) Object.assign(patch, { approvedBy: by, approvedAt: at, approvedVia: via, recHead: null });
  if (r.answers) Object.assign(patch, { rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null });
  // The person approved or answered at this head: commits they could see are no longer new (blocker 2 counts from here). An option of an
  // implementation's question is about its work, not about a head.
  if (r.approve || r.answers) {
    if (item.head) Object.assign(patch, { baseHead: item.head, acceptedHead: item.head });
    const pr = live.kind === "issue" && !r.pick ? await issuePr(live) : null;
    if (pr?.head) patch.acceptedHead = pr.head;
  }
  // A PR that merges without a review is reviewed once a person asks for it. The word merge approves the author's commits without that (resolve.ts).
  if (live.entry === "merge" && r.again === "review") patch.reviewAskedAt = (r.answers ? live.recAt : null) ?? at;
  else if (live.entry === "merge" && r.answers && r.merges && live.blocker === "author-commits") patch.reviewAskedAt = null;
  if (runs) patch.state = r.again !== null || r.merges || r.pick || r.goesOn ? "running" : r.answers ? "done" : live.state;
  // The recorded step is the advance pass's; until its next pass, readers work the step out from the new state.
  if (patch.state !== undefined && patch.state !== live.state) patch.step = null;
  return {
    failed: [], ...(work?.note ? { note: work.note } : {}), ...(work?.waits ? { waits: work.waits } : {}),
    commit: async () => {
      const now = (await listWorkflows(db, { ids: [live.id], live: true }))[0];
      if (!now) throw new fx.EffectError(t("The work on {ref} ended a moment ago. Send the command again.", { ref: refText(item.repo, item.number) }));
      if (!sameWorkflow(now, live)) throw new Moved();
      if (r.pick) await answerQuestion(c, r.pick.question, r.pick.option);
      if (r.merges && o.waiting.length) await retryActions(db, { ids: o.waiting.map((a) => a.id) });
      await saveWorkflows(db, [{ id: live.id, patch, at }]);
      if (weighed.length) await setCallLevels(db, [...await claimLevels(db, weighed)].map(([ref, level]) => ({ ref, level })));
      await work?.write(live.id);
      return live.id;
    },
  };
}

/**
 * Records the picked option as the person's answer to the implementation's question; refused when that question is no longer the
 * attempt's open one (answered meanwhile, or a newer attempt or round).
 */
async function answerQuestion(c: fx.Ctx, q: QuestionRef, option: string): Promise<void> {
  const a = (await loadImplementFacts(c.db, [{ repo: c.item.repo, number: c.item.number }])).byIssue.get(`${c.item.repo}#${c.item.number}`);
  if (!isOpenQuestion(a, q)) throw new fx.EffectError(t("The question this recommendation answers is no longer open."));
  await recordAnswers(c.db, [{ id: q.implementation, question: q.round, by: c.by, via: c.via, option }], c.at);
}

/** The workflow's merges as `login` that wait for their sign-in or access, on whatever PR they are. */
async function waitingMerges(db: Db, w: ItemWorkflow, login: string): Promise<WorkflowAction[]> {
  return [...(await loadActions(db, { workflowIds: [w.id], kinds: ["merge"], states: ACTION_WAITS })).values()].flat().filter((a) => a.by.toLowerCase() === login.toLowerCase());
}

/** The PR's own live workflow, when an implement start of the issue would go on with that PR. */
async function prWorkflow(db: Db, issue: { repo: string; number: number }): Promise<ItemWorkflow | undefined> {
  const pr = await openPr(db, issue.repo, takenOver((await loadImplementFacts(db, [issue])).byIssue.get(`${issue.repo}#${issue.number}`)));
  return pr ? (await listWorkflows(db, { live: true, refs: [{ repo: pr.repo, number: pr.number }] }))[0] : undefined;
}

/** The open PR an implement workflow works on, with its head; null while it has none. */
const implementationPr = async (db: Db, w: ItemWorkflow): Promise<fx.Target | null> =>
  openPr(db, w.repo, (await loadLinks(db, { workflowIds: [w.id] }, { ended: true }))[0]?.pr ?? null);

async function openPr(db: Db, repo: string, number: number | null): Promise<fx.Target | null> {
  const it = number === null ? undefined : (await loadItems(db, [{ repo, number }], "pr")).get(`${repo}#${number}`);
  return it?.state === "OPEN" ? { repo, number: it.number, kind: "pr", head: it.head_oid } : null;
}

// ---- controls ------------------------------------------------------------------------------------------------------------

/** A registered control and what it acts on. Task Runner settings belong to the person and have their own page. */
export type ControlInput =
  | { control: "hold-merge" | "release-merge" | "release-outside"; item: ItemRef }
  | { control: "resume-breaker"; key: string }
  | { control: "set-automatic"; repo: string; on: boolean };

/**
 * Runs a control under the act rule of its repo. A breaker without a
 * repo (the outside-surge breaker) is instance-wide, so only an operator resumes it.
 */
export async function runControl(db: Db, actor: Actor, via: Surface, input: ControlInput): Promise<{ ok: boolean; line: string }> {
  const written = input.control === "resume-breaker" ? parseTripKey(input.key)?.repo ?? null : input.control === "set-automatic" ? input.repo : input.item.repo;
  const login = actor.login ?? "";
  if (written === null) {
    const role = actor.login ? (await loadAccess(db, [actor.login])).get(actor.login.toLowerCase())?.role : undefined;
    if (role !== "operator") return { ok: false, line: t("Only an operator resumes an instance-wide breaker.") };
    return await controlStep(() => fx.resumeBreaker(db, login, (input as { key: string }).key), t("Resumed {key} (by {login}).", { key: (input as { key: string }).key, login }));
  }
  const repo = trackedRepo(new Set((await loadTrackedRepos(db)).keys()), written);
  if (!repo) return { ok: false, line: t("{repo} is not a repository AutoCraft tracks.", { repo: written }) };
  const no = await actRefusal(db, actor, repo);
  if (no) return { ok: false, line: refusalLine(no, actor.login, repo) };
  const at = new Date().toISOString();
  switch (input.control) {
    case "resume-breaker":
      return await controlStep(() => fx.resumeBreaker(db, login, input.key), t("Resumed {key} (by {login}).", { key: input.key, login }));
    case "set-automatic":
      return await controlStep(() => fx.setAutomatic(db, login, repo, input.on), input.on
        ? t("Automatic work is on for {repo} (by {login}).", { repo: slugOf(repo), login })
        : t("Automatic work is off for {repo} (by {login}).", { repo: slugOf(repo), login }));
    default: {
      const ref = refText(repo, input.item.number);
      const it = (await loadItems(db, [{ repo, number: input.item.number }], "pr")).get(`${repo}#${input.item.number}`);
      if (!it) return { ok: false, line: t("{ref} is not an item AutoCraft has read.", { ref }) };
      if (input.control === "hold-merge" && it.state !== "OPEN") return { ok: false, line: t("Nothing changed: {why}", { why: t("{ref} is not open.", { ref }) }) };
      const c: fx.Ctx = { db, by: login, via, at, item: { repo, number: input.item.number, kind: it.kind as ItemKind, head: it.head_oid } };
      if (input.control === "hold-merge") return await controlStep(() => fx.hold(c), t("{ref} is held out of the next merge (by {login}).", { ref, login }));
      if (input.control === "release-merge") return await controlStep(() => fx.release(c), t("{ref} can merge again (by {login}).", { ref, login }));
      return await controlStep(() => fx.releaseHeldItem(c), t("{ref} is released from its author's hold (by {login}).", { ref, login }));
    }
  }
}

async function controlStep(fn: () => Promise<unknown>, line: string): Promise<{ ok: boolean; line: string }> {
  try {
    await fn();
    return { ok: true, line };
  } catch (e) {
    if (!(e instanceof fx.EffectError)) throw e;
    return { ok: false, line: t("Nothing changed: {why}", { why: e.message }) };
  }
}

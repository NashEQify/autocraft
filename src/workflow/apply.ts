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
import { countEventsSince, listWorkflows, loadActions, recordEvents, saveWorkflows, startWorkflows, type CloseAs, type WorkflowAction, type WorkflowPatch } from "../data/workflow/index.ts";
import { t } from "../i18n/index.ts";
import { parseTripKey } from "../core/push-outcome.ts";
import type { Db } from "../db/index.ts";
import type { Exec } from "../fixup/git.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { claimLevels } from "../remote/level.ts";
import { actRefusal } from "../github/identity.ts";
import * as fx from "./effects.ts";
import { isOpenQuestion } from "./question.ts";
import { isLive, resolve, type Run } from "./resolve.ts";
import { confirmLine, listText, replyLine, stepsFor, utcClock, type Clock } from "./status.ts";
import { WEIGHT_NORMAL, type CloseReason, type ItemKind, type ItemRef, type ItemWorkflow, type Parsed, type QuestionRef, sameQuestion, type Surface, type WorkflowEventKind } from "./types.ts";

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
  /** The app's mention name, for replies that tell the sender what to write back. */
  mention?: string;
};

export type ItemOutcome = { repo: string; number: number; outcome: "run" | "ambiguous" | "refused"; line: string; workflowId: number | null };
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
/** What a command batch reads once for all its items: the tracked repos, the items and their live workflows. */
/** `again`: items the list names more than once; each later run reads the workflow the earlier one left. */
type Batch = { tracked: Set<string>; items: Map<string, ItemNow>; live: Map<string, ItemWorkflow>; closing: Map<string, WorkflowAction[]>; again: Set<string> };

async function loadBatch(db: Db, written: readonly ItemRef[]): Promise<Batch> {
  const tracked = new Set((await loadTrackedRepos(db)).keys());
  const refs = written.flatMap((x) => { const repo = trackedRepo(tracked, x.repo); return repo ? [{ repo, number: x.number }] : []; });
  const [items, live, closing] = refs.length
    ? await db.together(() => Promise.all([loadItems(db, refs, "pr"), listWorkflows(db, { live: true, refs }), loadActions(db, { refs, kinds: CLOSE_KINDS, states: OPEN_ACTIONS })]))
    : [new Map(), [], new Map()] as const;
  return {
    tracked,
    items: new Map([...items].map(([k, it]) => [k, { kind: it.kind as ItemKind, state: it.state, head: it.head_oid }])),
    live: new Map(live.map((w) => [`${w.repo}#${w.number}`, w])),
    closing: new Map(closing),
    again: new Set(refs.map((x) => `${x.repo}#${x.number}`).filter((k, i, all) => all.indexOf(k) !== i)),
  };
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
  for (const target of targets) items.push(await runOne(db, actor, via, input, target, at, batch));
  const many = items.length > 1;
  const lines = items.map((o) => (many ? t("{ref}: {line}", { ref: refText(o.repo, o.number), line: o.line }) : o.line));
  const failed = items.filter((o) => o.outcome !== "run");
  if (many && failed.length) lines.push(t("Not run: {refs}.", { refs: listText(failed.map((o) => refText(o.repo, o.number))) }));
  return { items, lines };
}

async function runOne(db: Db, actor: Actor, via: Surface, input: CommandInput, target: ItemRef, at: string, batch: Batch): Promise<ItemOutcome> {
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

  // A list may name the item twice: the first run's workflow is the one the second sees.
  const wf = batch.live.get(key) ?? null;
  const closing = batch.closing.get(key)?.at(-1) ?? null;
  const r = resolve(input.parsed, { kind, workflow: wf, closing: closing !== null });
  const event = (kind: WorkflowEventKind, workflowId: number | null, line: string) =>
    ({ workflowId, repo, number: target.number, login, via, kind, parsed: input.parsed, line, at });
  if (r.kind === "ambiguous") {
    const line = replyLine(r, input.clock, input.mention);
    await recordEvents(db, [event("ambiguous", wf?.id ?? null, line)]);
    return out("ambiguous", line, wf?.id ?? null);
  }
  if (r.kind === "refused") return out("refused", replyLine(r, input.clock, input.mention), wf?.id ?? null);

  const c: fx.Ctx = { db, by: login, via, at, item: { repo, number: target.number, kind, head }, ...(input.exec ? { exec: input.exec } : {}) };
  try {
    const closeAs = r.run.close ? await closeAsOf(c, r.run.close, batch, input.visible) : null;
    const done = await carryOut(c, r.run, isLive(wf) ? wf : null, actor, { closing, closeAs });
    const line = confirmLine(r.run, login, at, input.clock ?? utcClock) + (done.failed.length ? ` ${t("Could not stop: {what}.", { what: done.failed.join("; ") })}` : "")
      + (done.note ? ` ${done.note}` : "");
    const id = await db.write(async () => {
      const id = await done.commit();
      await recordEvents(db, [event(eventKind(r.run), id, line)]);
      return id;
    });
    if (batch.again.has(key)) {
      const refs = [{ repo, number: target.number }];
      const [live, acts] = await db.together(() => Promise.all([listWorkflows(db, { live: true, refs }), loadActions(db, { refs, kinds: CLOSE_KINDS, states: OPEN_ACTIONS })]));
      batch.closing.set(key, acts.get(key) ?? []);
      if (live[0]) batch.live.set(key, live[0]); else batch.live.delete(key);
    }
    return out("run", line, id);
  } catch (e) {
    if (!(e instanceof fx.EffectError)) throw e;
    return out("refused", t("Nothing ran on {ref}: {why}", { ref, why: e.message }), wf?.id ?? null);
  }
}

function eventKind(r: Run): WorkflowEventKind {
  if (r.end === "stop") return "stopped";
  if (r.end === "close") return "closed";
  if (r.end === "backlog") return "backlog";
  if (r.autorepin !== null) return "set";
  if (r.start) return "started";
  // An answer to the open recommendation is an answer also when it approves the merge: it accepts what the recommendation showed.
  if (r.answers) return "answered";
  if (r.approve) return "approved";
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
type Done = { commit: () => Promise<number | null>; failed: string[]; note?: string };

/** Checks the resolved command on the machinery (an end also stops what runs), then returns its write. */
async function carryOut(c: fx.Ctx, r: Run, wf: ItemWorkflow | null, actor: Actor, o: { closing: WorkflowAction | null; closeAs: CloseAs | null }): Promise<Done> {
  const { db, by, at, via, item } = c;
  const wfId = wf?.id ?? null;
  const unchanged = async (): Promise<number | null> => wfId;
  if (r.end !== null) {
    if (r.end === "close" && item.kind === "pr" && !item.head) throw new fx.EffectError(t("AutoCraft has not read the head commit of {ref} yet.", { ref: refText(item.repo, item.number) }));
    const state = r.end === "stop" ? "stopped" : r.end === "close" ? "closed" : "backlog";
    const end: WorkflowPatch = { state, ...(state === "stopped" ? { stoppedBy: by, stoppedAt: at } : {}), rec: null, blocker: null, blockerParams: null };
    // A stop of a close that is still to be made ends the workflow that close belongs to.
    const stopped = wf === null && r.end === "stop" ? o.closing?.workflow_id ?? null : null;
    const known = wf?.id ?? stopped;
    const failed = await fx.stopAll({ ...c, ...(known !== null ? { workflowId: known } : {}) });
    return {
      failed,
      commit: async () => {
        // An item nobody started gets a row that records the close or the backlog, ended at once.
        const id = known ?? (await startWorkflows(db, [{ repo: item.repo, number: item.number, kind: item.kind, entry: item.kind === "pr" ? "review" : "implement", weight: r.weight ?? WEIGHT_NORMAL, startedBy: by, startedVia: via, baseHead: item.head, at }]))
          .get(`${item.repo}#${item.number}`);
        if (id === undefined) throw new fx.EffectError(t("{ref} was started a moment ago. Send the command again.", { ref: refText(item.repo, item.number) }));
        await saveWorkflows(db, [{ id, patch: end, at }]);
        if (r.end === "close") await fx.queueClose(c, id, o.closeAs);
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
        if (o.closing) await fx.stopCloses(c);
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
  let on: fx.Ctx = { ...c, workflowId: live.id };
  if (live.kind === "issue" && !r.pick && (r.again !== null || r.fix.length > 0 || r.merges)) {
    const pr = await implementationPr(db, live);
    // An answer to a recommendation made at another head of the PR would run on code nobody was shown.
    if (pr && live.rec && live.recHead && pr.head !== live.recHead) throw new fx.EffectError(t("The pull request changed after the command was written. Send it again."));
    if (pr) on = { ...c, item: pr, workflowId: live.id };
    else if (r.again !== null || r.fix.length) throw new fx.EffectError(t("{ref} has no open implementation pull request yet.", { ref: refText(item.repo, item.number) }));
  }
  // A new weight also orders the queued calls of the item and of the PR that implements it.
  const weighed = patch.weight === undefined ? [] : [item, ...(live.kind === "issue" ? [await implementationPr(db, live)] : [])].filter((x) => x !== null);
  const work = runs ? await fx.again(on, { again: r.again, plan: live.plan, fix: r.fix, merges: r.merges }) : null;
  if (r.drop.length) patch.plan = live.plan.map((p) => (r.drop.includes(p.n) ? { ...p, state: "dropped" as const } : p));
  // An answered question's options are no plan any more.
  if (r.pick) patch.plan = live.plan.filter((p) => !sameQuestion(p.question, r.pick!.question));
  // Approving at this head: commits the person could see are no longer new (blocker 2 counts from here).
  if (r.approve) Object.assign(patch, { approvedBy: by, approvedAt: at, approvedVia: via, ...(item.head ? { baseHead: item.head } : {}) });
  // The person answered at this head: commits they could see are no longer new (blocker 2 counts from here).
  if (r.answers) Object.assign(patch, { rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null, ...(item.head ? { baseHead: item.head } : {}) });
  if (runs) patch.state = r.again !== null || r.merges || r.pick ? "running" : r.answers ? "done" : live.state;
  // The recorded step is the advance pass's; until its next pass, readers work the step out from the new state.
  if (patch.state !== undefined && patch.state !== live.state) patch.step = null;
  return {
    failed: [],
    commit: async () => {
      if (!(await listWorkflows(db, { ids: [live.id], live: true })).length) throw new fx.EffectError(t("The work on {ref} ended a moment ago. Send the command again.", { ref: refText(item.repo, item.number) }));
      if (r.pick) await answerQuestion(c, r.pick.question, r.pick.option);
      await saveWorkflows(db, [{ id: live.id, patch, at }]);
      if (weighed.length) await setCallLevels(db, [...await claimLevels(db, weighed)].map(([ref, level]) => ({ ref, level })));
      await work?.(live.id);
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

/** The open implementation PR of an implement workflow, with its head; null while the issue has none. */
async function implementationPr(db: Db, w: ItemWorkflow): Promise<fx.Target | null> {
  const a = (await loadImplementFacts(db, [{ repo: w.repo, number: w.number }])).byIssue.get(`${w.repo}#${w.number}`);
  const pr = a?.attempt.prNumber ?? a?.prAttempts.find((p) => p.createdAt >= w.startedAt)?.prNumber ?? null;
  if (pr === null) return null;
  const it = (await loadItems(db, [{ repo: w.repo, number: pr }], "pr")).get(`${w.repo}#${pr}`);
  return it?.state === "OPEN" ? { repo: w.repo, number: pr, kind: "pr", head: it.head_oid } : null;
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

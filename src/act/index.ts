// Act stage: the GitHub writes that follow an operator's answer. Two kinds,
// both a short comment and a close:
//   - a scope decision answered `close` (Out of scope), on an issue or PR;
//   - a "Close this PR?" decision, which this step asks for each PR whose
//     latest review says close, once per head commit.
//   - a "Merge this PR?" decision answered `close`: the same comment and close
//     as a "Close this PR?" close.
//   - a duplicate decision answered `close` (Close as duplicate): "Duplicate of
//     #y." (or "..., which is closed.") and a close. "Not a duplicate" and "Keep
//     both" store the pair as distinct and write nothing (src/dupes/decide.ts).
// Other scope answers need no write here: take and small-extra go on to
// review, plugin makes the Label stage add the plugin candidate label (in
// repos approved for labels), need-info is checked by people. They count as
// applied once the pipeline used them (src/decisions-used.ts). Only an
// operator's answer counts (actionable()), and only in repos an operator
// approved for comments. No model calls.
//
//   autocraft-server act --repo R [--limit N] [--apply]
//   autocraft-server comment-approval [--repo R]
import * as kx from "../db/kx.ts";
import { OPERATOR_MODELS } from "../prompts/index.ts";
import { audit } from "../dash/audit.ts";
import { closeItem, commentOn, duplicateClose, type CloseHow, type Note, type Writer } from "../github/write.ts";
import { isQuiet } from "../security/quiet.ts";
import { actionable, ask, factsOf, getDecision, type Actionable, type DecisionRow, type Kind } from "../decisions.ts";
import { HEAD_FACT } from "../merge/queue.ts";
import { fillReviewSummaries, reviewText } from "../review/summary.ts";
import { Client, type Querier } from "../mirror.ts";
import { sizeOf } from "../review/candidates.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { applyDuplicateAnswers } from "../dupes/decide.ts";
import { commentApprovalOf } from "./approval.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guardItem, guardRepo, type GuardedRepo } from "../core/guard.ts";
import { actOnGroups, type GroupIo } from "./dupe-groups.ts";
import { cleanReason, duplicateComment, prCloseComment, scopeCloseComment } from "./templates.ts";
import { plannedItems } from "../core/select-items.ts";
import { jobItem } from "../runner/job-items.ts";
import { orderTargets } from "./order.ts";
import { actRoom } from "../conversations/queue.ts";
import { setAsideSupersededQuestions, withdrawHoldQuestion } from "../merge/withdraw.ts";
import { holdDecisionId, HOLD_OPTIONS } from "../core/rules.ts";
import { planned } from "../core/select.ts";
import { ownerOf } from "../owners.ts";
import { sweepStaleAnswers } from "../answers/sweep.ts";
import { authFailure, isWaiting, laneForDecision, markExecDone, noWriteReason, setExecState, SIGN_IN_REASON, type LaneDeps, type Lane } from "../github/user-lane.ts";
import type { Exec } from "../fixup/git.ts";
import { filterSeq, mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const ACTOR = "act";
const NO_IO: GroupIo = { live: async () => null, comment: async () => "", close: async () => {} };
const KIND = "comment-close";
const DUP_FACT = "duplicate of ";
const REASON_FACT = "review reason: ";

export type ActDeps = { querier: Querier; now: () => Date; /** The user lane's token source and transports; default: the secrets file's app. */ lane?: LaneDeps; /** Replaces the app lane's token minter and client (tests). */ app?: Pick<Writer, "mint" | "appClient">; /** Runs `gh` for the held follow-up issues (tests). */ exec?: Exec };
export const defaultDeps = (): ActDeps => ({ querier: new Client(1000), now: () => new Date() });

export type ActParams = {
  repo: string;
  /** Most items to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` asks, comments or closes. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};

export type ActSummary = {
  repo: string; dryRun: boolean;
  /** Close? decisions asked (or that would be). */
  asked: string[];
  done: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[];
  /** Queued card presses carried out by this run. */
  cards?: number;
  /** Follow-up issues held until the merge that this run filed or dropped (src/conversations/held.ts). */
  held?: number;
  /** The write pacing's message when it held back a held follow-up issue. */
  paced?: string;
  note: string | null;
};

/** Option keys of a "Close this PR?" decision. */
export const CLOSE_OPTIONS = {
  close: { key: "close", label: "Close", hint: "Post a short comment and close the PR." },
  hold: { key: "hold", label: "Hold", hint: "Leave it open for now." },
  keep: { key: "keep", label: "Keep open", hint: "The PR stays; do not ask again at this head commit." },
} as const;

/** One decision per PR head: a push gets a new one. */
export const closeDecisionId = (repo: string, number: number, head: string): string => `${repo}#${number}:close@${head}`;

/**
 * The GitHub write each option causes, by decision kind and option key. The
 * dashboard asks for a second confirmation on these; options not listed write
 * nothing.
 */
const WRITES: Partial<Record<Kind, Record<string, string>>> = {
  scope: { close: "closes it on GitHub" },
  close: { close: "closes the PR on GitHub" },
  hold: { close: "closes the PR on GitHub" },
  duplicate: { close: "closes it on GitHub", accept: "posts the comments shown and closes the duplicates on GitHub" },
  merge: { merge: "merges on GitHub", close: "closes the PR on GitHub" },
};
export const writeEffect = (kind: Kind, optionKey: string): string | null =>
  WRITES[kind]?.[optionKey] ?? (kind === "duplicate" && optionKey.startsWith("keep:") ? WRITES.duplicate!.accept! : null);

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string) => sha.slice(0, 7);

// ---- Close this PR? ------------------------------------------------------------

type ReviewRow = { verdict?: string; repo: string; number: number; head_oid: string; reason: string | null; sure: number | null; lines: number; title: string | null; author: string | null };

const reviewQuery = (db: Db, repo: string, number: number, head: string | null) => db.k.selectFrom("final_reviews as r").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "r.repo").onRef("i.number", "=", "r.number"))
  .select((eb) => ["r.repo", "r.number", "r.head_oid", "r.reason", "r.sure", eb(eb.fn.coalesce("i.additions", eb.lit(0)), "+", eb.fn.coalesce("i.deletions", eb.lit(0))).as("lines"), "i.title", "i.author"])
  .$narrowType<{ repo: string; number: number; head_oid: string }>()
  .where("r.repo", "=", repo).where("r.number", "=", number).where("r.head_oid", "=", head);

/** The final close reviews behind the Close? questions the Plans ask for in this repo. */
async function closeRows(db: Db, repo: string): Promise<ReviewRow[]> {
  return (await mapSeq((await plannedItems(db, "act", { repo })).filter((p) => p.action.params?.ask), async (p) => await db.get(reviewQuery(db, repo, p.facts.number, p.action.head).select("r.verdict").$narrowType<{ verdict: string }>().where("r.verdict", "=", "close")))).filter((r): r is NonNullable<typeof r> => !!r);
}

/** A quiet pull request's question carries no model reason: the reason would name what the fix protects against, and the close comment is public. */
export function closeQuestion(r: ReviewRow, why: string | null = null, quiet = false): Record<string, unknown> & { id: string } {
  const reason = cleanReason(r.reason);
  return {
    id: closeDecisionId(r.repo, r.number, r.head_oid), kind: "close", repo: r.repo, number: r.number,
    question: "Close this PR?",
    context: `The Opus review says close${r.sure === 0 ? " (Opus was unsure)" : ""}.`,
    facts: [
      ...(quiet ? [] : [`${REASON_FACT}${(r.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`]),
      `author: ${r.author ?? "unknown"}, size ${sizeOf(r.lines)}`,
      `${HEAD_FACT}${r.head_oid}`,
    ],
    options: Object.values(CLOSE_OPTIONS).map((o) => ({ ...o })),
    // A recommendation always comes with the review's reason for it.
    ...(why ? { recommended: "close", recommended_reason: why } : {}),
    // The reason the closing comment gives; the operator sees it in the facts.
    ...(quiet ? {} : { public_text: reason }),
    asked_by: ACTOR,
  };
}

// ---- Hold: what next? ------------------------------------------------------------

/** The question for a PR whose latest review says hold, asked once per head. Review again and a fix-up first are cores of the prepared answer (src/decide/choices.ts). */
export function holdQuestion(r: ReviewRow, quiet = false, ci: string | null = null): Record<string, unknown> & { id: string } {
  const reason = cleanReason(r.reason);
  return {
    id: holdDecisionId(r.repo, r.number, r.head_oid), kind: "hold", repo: r.repo, number: r.number,
    question: ci ? "CI fails and nothing can fix it. What next?" : "The review put this PR on hold. What next?",
    context: ci ? `${ci}. The review says ${r.verdict}, but the PR cannot merge while CI fails, so a Merge answer would change nothing.`
      : `The Opus review says hold${r.sure === 0 ? " (Opus was unsure)" : ""}: it neither takes the PR as it is nor closes it, and nothing happens until a person decides.`,
    facts: [
      ...(quiet ? [] : [`${REASON_FACT}${(r.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`]),
      `author: ${r.author ?? "unknown"}, size ${sizeOf(r.lines)}`,
      `${HEAD_FACT}${r.head_oid}`,
    ],
    options: Object.values(HOLD_OPTIONS).map((o) => ({ ...o })),
    ...(quiet ? {} : { public_text: reason }),
    asked_by: ACTOR,
  };
}

/**
 * Asks the Hold questions the Plans call for and sets aside open ones whose head is no longer held. Writes decisions only.
 * Returns the ids asked.
 */
export async function askHoldDecisions(db: Db, at: string, repo?: string): Promise<string[]> {
  const todo = (await planned(db, "ask-merge", repo ? { repo } : {})).filter((p) => p.action.params?.hold === true);
  const qs: (Record<string, unknown> & { id: string })[] = [];
  for (const p of todo) {
    if (p.action.params?.withdraw) { await withdrawHoldQuestion(db, p.facts.repo, p.facts.number, String(p.action.params?.decisionHead ?? p.action.head ?? ""), at, "the review at that head no longer says hold"); continue; }
    const r = await db.get(reviewQuery(db, p.facts.repo, p.facts.number, p.action.head));
    if (r) qs.push(holdQuestion(r, await isQuiet(db, r.repo, r.number), typeof p.action.params?.ci === "string" ? p.action.params.ci : null));
  }
  if (qs.length) { await ask(db, qs.map((q) => ({ ...q, asked_at: at }))); await setAsideSupersededQuestions(db, at, repo); }
  else await setAsideSupersededQuestions(db, at, repo);
  await fillReviewSummaries(db, at, repo);
  return qs.map((q) => q.id);
}

export async function askCloseDecisions(db: Db, repo: string, at: string): Promise<string[]> {
  const qs = await mapSeq((await closeRows(db, repo)), async (r) => closeQuestion(r, (await reviewText(db, r.repo, r.number, r.head_oid))?.why ?? null, await isQuiet(db, r.repo, r.number)));
  if (qs.length) { await ask(db, qs.map((q) => ({ ...q, asked_at: at }))); await setAsideSupersededQuestions(db, at, repo); }
  await fillReviewSummaries(db, at, repo);
  return qs.map((q) => q.id);
}

// ---- what to act on ------------------------------------------------------------

type Target = { decisionId: string; kind: "scope" | "close" | "duplicate" | "merge" | "hold"; repo: string; number: number };

type ActionRow = { attempts: number; id: number; decision_id: string; repo: string; number: number; kind: string; state: string; comment_url: string | null; reason: string | null; created_at: string };
const rowOf = async (db: Db, t: Target): Promise<ActionRow | undefined> =>
  await db.get(db.k.selectFrom("actions").select(kx.cols("actions")).where("decision_id", "=", t.decisionId).where("repo", "=", t.repo).where("number", "=", t.number).where("kind", "=", KIND));

/** `asked_by` of the decisions a security scan asks. An operator's close answer to one applies in any repo approved for commenting, in the pipeline or not. */
export const SECURITY_ASKER = "security-scan";

/** A target that fails this many times (not an authorization failure) is stopped: Act skips it with the reason and a person retries it from the Needs you page, or undoes or answers again. */
export const ACT_MAX_ATTEMPTS = 3;

/** Answered-close targets in the repo that the Plans send here: no final (done or skipped) action row yet. */
/** Item-level targets only: a duplicate group's members are carried out by actOnGroups, which the same act actions schedule. */
async function pending(db: Db, repo: string, refs?: string[]): Promise<Target[]> {
  // A decision that waits for its operator's token or access is not work until it is retried or answered again.
  return (await filterSeq((await plannedItems(db, "act", { repo, refs })), async (p) => !p.action.params?.ask && !p.action.params?.group && !await isWaiting(db, p.action.params?.decisionId as string)))
    .map((p): Target => ({ decisionId: p.action.params!.decisionId as string, kind: p.action.params!.bucket as Target["kind"], repo, number: p.facts.number }));
}

/** The decision still carries the answer the target was planned for: not undone, applied, disputed or answered differently. */
async function answerStands(db: Db, id: string, answer: string | null): Promise<boolean> {
  const d = await getDecision(db, id);
  return !!d && d.answer === answer && !d.applied_at && d.exec_state !== "disputed";
}

/** The repo's targets in the order Act works: item priority level (security raised), then the time of the answer. */
const pendingInOrder = async (db: Db, repo: string, refs?: string[]): Promise<Target[]> => await orderTargets(db, await pending(db, repo, refs));

// ---- GitHub ----------------------------------------------------------------------

export type Live = { id: string; type: "Issue" | "PullRequest"; state: string; head: string | null };

export const READ = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $n) {
      __typename
      ... on Issue { id state }
      ... on PullRequest { id state headRefOid }
    }
  }
}`;

export async function readLive(q: Querier, repo: string, n: number): Promise<Live | null> {
  const d = await q.query(READ, { owner: ownerOf(repo), name: repo, n }) as { repository?: { issueOrPullRequest?: { __typename: string; id: string; state: string; headRefOid?: string } | null } };
  const x = d.repository?.issueOrPullRequest;
  if (!x) return null;
  return { id: x.id, type: x.__typename === "PullRequest" ? "PullRequest" : "Issue", state: x.state, head: x.headRefOid ?? null };
}

// ---- the step ----------------------------------------------------------------

function headFact(d: DecisionRow): string | null {
  const f = factsOf(d).find((x) => x.startsWith(HEAD_FACT));
  return f ? f.slice(HEAD_FACT.length).trim() : null;
}
const factValue = (d: DecisionRow, prefix: string): string | null => {
  const f = factsOf(d).find((x) => x.startsWith(prefix));
  return f ? f.slice(prefix.length).trim() : null;
};

/** The note for a comment posted on an operator's answer: the model that recommended the action or wrote the decision's text, when one did. */
export function decisionNote(d: DecisionRow): Note {
  if (d.asked_by === SECURITY_ASKER) return { by: "operator", model: OPERATOR_MODELS.security };
  const model = d.recommended_by ?? d.summary_by;
  return model ? { by: "operator", model } : { by: "fixed-operator" };
}

function commentFor(d: DecisionRow, t: Target, quiet = false): string {
  if (t.kind === "scope") return scopeCloseComment(d.public_text);
  if (quiet) return prCloseComment({ repo: t.repo, reason: null, duplicateOf: null });
  return prCloseComment({ repo: t.repo, reason: d.public_text ?? factValue(d, REASON_FACT), duplicateOf: factValue(d, DUP_FACT) });
}

/** The exact comment the act step posts for a decision, for the dashboard. Null when none is fixed in advance. */
export function commentPreview(d: DecisionRow): string | null {
  // A group decision shows the stored texts of each option instead (src/dupes/texts.ts).
  if (d.kind === "duplicate" && d.id.includes(":dupegroup:")) return null;
  if (d.kind === "scope" || d.kind === "close" || d.kind === "merge" || d.kind === "hold") return commentFor(d, { decisionId: d.id, kind: d.kind, repo: d.repo ?? "", number: d.number ?? 0 });
  if (d.kind === "duplicate") {
    const orig = factValue(d, DUP_FACT);
    return orig && d.repo ? duplicateComment({ repo: d.repo, original: orig, closed: false }) : null;
  }
  return null;
}

export async function runAct(db: Db, params: ActParams, log: (line: string) => void = console.log, deps?: ActDeps): Promise<ActSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const w: Writer = { db, login: ACTOR, ...deps?.app };
  const summary: ActSummary = { repo, dryRun, asked: [], done: [], skipped: [], failed: [], note: null };
  // Answers that need no GitHub write are applied whether or not commenting is approved.
  // The group steps compare text hashes with the ones stored at the comparison: a hash cleared by an edit outside sync is filled first, so the edit is seen.
  // Queued card presses run first, from the same shared daily count: they were pressed before this run, and each is held to the presser's current access.
  let cardWrites = 0;
  if (!dryRun) {
    await fillEmbedHashes(db); await applyDuplicateAnswers(db, at()); await sweepStaleAnswers(db, at());
    const { drainQueuedCards } = await import("../conversations/act.ts");
    const drained = await drainQueuedCards(db, { now: deps?.now, querier: deps?.querier, lane: deps?.lane }, params.limit === undefined ? {} : { writes: params.limit });
    cardWrites = drained.writes;
    summary.cards = drained.ran;
    if (drained.ran) log(`act: ${drained.ran} queued card press${drained.ran === 1 ? "" : "es"} carried out`);
    // Issues the cards held until the PR merged: filed once it merged, dropped once it closed or its merge path ended. Before the approval check: each guards the repo it opens in.
    const { fileHeldFollowups } = await import("../conversations/held.ts");
    const held = await fileHeldFollowups(db, repo, { now: deps?.now, exec: deps?.exec }, params.limit === undefined ? {} : { writes: Math.max(0, params.limit - cardWrites) });
    cardWrites += held.writes;
    summary.held = held.filed + held.dropped;
    summary.failed.push(...held.failed);
    if (held.paced) summary.paced = held.paced;
    if (held.filed || held.dropped) log(`act: ${held.filed} held follow-up issue${held.filed === 1 ? "" : "s"} filed, ${held.dropped} dropped`);
    if (held.unknown) log(`act: a held follow-up issue was being created when the answer was lost; it may exist, check GitHub`);
  }
  if (!await commentApprovalOf(db, repo)) {
    summary.note = `commenting in ${repo} is not approved`;
    log(`act ${repo}: ${summary.note}; nothing done`);
    return summary;
  }
  let todo = await pendingInOrder(db, repo);
  if (params.limit !== undefined) todo = todo.slice(0, Math.max(0, params.limit - cardWrites));
  if (dryRun) {
    summary.asked = (await closeRows(db, repo)).map((r) => closeDecisionId(r.repo, r.number, r.head_oid));
    for (const id of summary.asked) log(`  would ask Close? ${id}`);
    for (const t of todo) log(`  would comment and close ${refOf(t)} (${t.decisionId})`);
    await actOnGroups(db, { repo, io: NO_IO, at, log, left: () => Infinity, handled: () => {}, dryRun: true });
    log(`act ${repo}: dry run, nothing called or written`);
    summary.done = todo.map(refOf);
    return summary;
  }
  const d = deps ?? defaultDeps();
  summary.asked = await askCloseDecisions(db, repo, at());
  if (summary.asked.length) log(`  asked ${summary.asked.length} Close? decision${summary.asked.length === 1 ? "" : "s"}`);
  // Newly asked ones are unanswered, so the work list is the one taken above.

  const save = async (t: Target, state: "done" | "skipped" | "failed" | "stopped", reason: string | null, url: string | null, attempts?: number) => {
    const prev = await rowOf(db, t);
    if (prev) await db.run(db.k.updateTable("actions").set((eb) => ({ state, reason, comment_url: eb.fn.coalesce(eb.val(url), "comment_url"), created_at: at(), attempts: eb.fn.coalesce(eb.val(attempts ?? null), "attempts") })).where("id", "=", prev.id));
    else await db.run(db.k.insertInto("actions").values({ decision_id: t.decisionId, repo: t.repo, number: t.number, kind: KIND, state, comment_url: url, reason, created_at: at(), attempts: attempts ?? 0 }));
  };
  // A decision is applied once none of its targets is left to do.
  const settle = async (t: Target) => {
    const a = (await actionable(db)).find((x) => x.id === t.decisionId);
    if (a && !(await pending(db, repo, a.items.filter((i) => i.repo === repo).map(refOf))).some((p) => p.decisionId === t.decisionId) && !targetsOfElsewhere(a, repo))
      await db.run(db.k.updateTable("main.decisions").set({ applied_at: at() }).where("id", "=", t.decisionId).where("applied_at", "is", null));
  };
  const skip = async (t: Target, reason: string) => {
    await save(t, "skipped", reason, null);
    await audit(db, ACTOR, "act-skip", refOf(t), { decision: t.decisionId, reason });
    summary.skipped.push({ ref: refOf(t), reason });
    await jobItem(db, t.repo, t.number, `skipped: ${reason}`, log);
    await settle(t);
  };

  let handled = 0;
  for (const t of todo) {
    // The daily count is shared with card presses; one target is one count.
    if (!await actRoom(db, 1, (deps?.now() ?? new Date()).getTime())) { summary.note = "the daily limit is reached"; break; }
    const dec = (await getDecision(db, t.decisionId))!;
    const prev = await rowOf(db, t);
    // Under the app's identity the close is made as the operator who answered, with their token (the comment before it is the app's); it waits when there is none.
    const lr = await laneForDecision(db, d.lane, t.decisionId, [t.repo]);
    if (lr && !("lane" in lr)) {
      if ("transient" in lr) await jobItem(db, t.repo, t.number, `not closed yet: ${lr.transient}`, log);
      else { await setExecState(db, t.decisionId, lr.state, lr.reason); await jobItem(db, t.repo, t.number, `waiting: ${lr.reason}`, log); }
      continue;
    }
    // Counted once the target has a lane: a waiting or transient one is not work done, so the planner can settle.
    handled++;
    params.onHandled?.(handled);
    if (lr) await setExecState(db, t.decisionId, "pending");
    const q = lr ? lr.lane.querier : d.querier;
    try {
      const live = await readLive(q, t.repo, t.number);
      if (!live) { await skip(t, "GitHub returned no such item"); continue; }
      if (live.state !== "OPEN") { await skip(t, `already ${live.state.toLowerCase()} on GitHub`); continue; }
      if (t.kind === "close" || t.kind === "merge" || t.kind === "hold") {
        const h = headFact(dec);
        if (live.type !== "PullRequest" || !h || live.head !== h) { await skip(t, `head moved since the decision (${h ? short(h) : "no head recorded"} → ${live.head ? short(live.head) : "none"})`); continue; }
      }
      const g = await guardItem(db, { repo: t.repo, number: t.number }, { kind: "act", bucket: t.kind, decisionId: t.decisionId }, params.by ?? CLI_BY);
      if ("refused" in g) { await jobItem(db, t.repo, t.number, `not closed: ${g.refused}`, log); continue; }
      // Read again after every await above: an undo or a dispute that landed meanwhile stops the write.
      if (!await answerStands(db, t.decisionId, dec.answer)) { await jobItem(db, t.repo, t.number, "not closed: the answer was taken back or disputed", log); continue; }
      let url = prev?.comment_url ?? null;
      // A duplicate's close reason needs the kept issue, read before the comment is posted and again here on a retry.
      let how: CloseHow | undefined = t.kind === "scope" ? "NOT_PLANNED" : undefined;
      if (t.kind === "duplicate" && url !== null) {
        const orig = /^([\w.-]+)#(\d+)$/.exec(factValue(dec, DUP_FACT) ?? "");
        const o = orig && orig[1] === t.repo ? await readLive(q, t.repo, Number(orig[2])) : null;
        how = o && orig ? duplicateClose({ id: o.id, pr: o.type === "PullRequest" }, `${orig[1]}#${orig[2]}`) : "NOT_PLANNED";
      }
      if (url === null) {
        let body: string;
        if (t.kind === "duplicate") {
          const orig = /^([\w.-]+)#(\d+)$/.exec(factValue(dec, DUP_FACT) ?? "");
          if (!orig || orig[1] !== t.repo || Number(orig[2]) === t.number) { await skip(t, "the decision names no other item of this repo as the original"); continue; }
          const o = await readLive(q, t.repo, Number(orig[2]));
          if (!o) { await skip(t, "GitHub returned no such original"); continue; }
          how = duplicateClose({ id: o.id, pr: o.type === "PullRequest" }, `${orig[1]}#${orig[2]}`);
          body = duplicateComment({ repo: t.repo, original: `${orig[1]}#${orig[2]}`, closed: o.state !== "OPEN" });
        } else body = commentFor(dec, t, (t.kind === "close" || t.kind === "hold") && await isQuiet(db, t.repo, t.number));
        url = await commentOn(w, g, q, "act-comment", { repo: t.repo, number: t.number, id: live.id }, decisionNote(dec), body, { decision: t.decisionId });
        // Saved before the close so a retry after a failed close does not comment twice.
        await save(t, "failed", "comment posted; close not done yet", url);
      }
      // The comment was awaited above; an undo is refused once it is posted, but a dispute or an answer changed before it is not.
      if (!await answerStands(db, t.decisionId, dec.answer)) { await jobItem(db, t.repo, t.number, "not closed: the answer was taken back or disputed", log); continue; }
      await closeItem(w, g, q, { repo: t.repo, number: t.number, id: live.id, pr: live.type === "PullRequest" }, { decision: t.decisionId, head: live.head }, how);
      await save(t, "done", null, url);
      await db.run(db.k.insertInto("main.stages").values({ repo: t.repo, number: t.number, stage: "closed", at: at(), actor: ACTOR, note: `closed after ${t.kind} decision ${t.decisionId}` }));
      summary.done.push(refOf(t));
      await jobItem(db, t.repo, t.number, "commented and closed", log);
      await settle(t);
    } catch (e) {
      const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
      const denied = lr ? authFailure(e) : null;
      if (denied === "transient") { await jobItem(db, t.repo, t.number, `not closed yet: ${why}`, log); continue; }
      if (denied) {
        // The user's token may not do this write: wait for access instead of failing, and write nothing as anyone else.
        await setExecState(db, t.decisionId, denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(t.repo));
        await jobItem(db, t.repo, t.number, `waiting: ${why}`, log);
        continue;
      }
      // An error of GitHub itself (a server error, timeout, network failure, rate limit) says nothing about this target: the run stops, no try is counted,
      // and the job ends as failed so the registered failure backoff applies.
      if (githubWide(e)) {
        summary.failed.push({ ref: refOf(t), reason: why });
        await jobItem(db, t.repo, t.number, `GitHub is failing, stopping: ${why}`, log);
        break;
      }
      const row = await rowOf(db, t);
      // The comment of a retry that already posted it is not repeated. After ACT_MAX_ATTEMPTS failed tries the target is stopped and a person is asked; the other targets go on.
      // The job ends as failed (see the step), so the registered failure backoff spaces the tries.
      const attempts = (row?.attempts ?? 0) + 1;
      const stop = attempts >= ACT_MAX_ATTEMPTS;
      const shown = stop ? `stopped after ${attempts} failed tries: ${why}` : why;
      if (lr || stop) await setExecState(db, t.decisionId, "failed", shown);
      await save(t, stop ? "stopped" : "failed", shown, row?.comment_url ?? null, attempts);
      if (stop) await audit(db, ACTOR, "act-stopped", refOf(t), { decision: t.decisionId, reason: why, attempts });
      summary.failed.push({ ref: refOf(t), reason: shown });
      await jobItem(db, t.repo, t.number, `failed: ${shown}`, log);
    }
  }
  // Duplicate groups: the stored comments and closes, within what is left of the limit.
  const groupGrant = summary.failed.length ? null : await guardRepo(db, repo, "comment", params.by ?? CLI_BY);
  if (groupGrant && "refused" in groupGrant) log(`  duplicate groups: not applied: ${groupGrant.refused}`);
  else if (groupGrant) {
    // Each group decision's closes are made as the operator who answered it; `begin` picks that operator's lane.
    let lane: Lane | null = null;
    const q = (): Querier => lane?.querier ?? d.querier;
    const asAnswerer = async (decision: string): Promise<GuardedRepo> => {
      const g = await guardRepo(db, repo, "comment", params.by ?? CLI_BY, decision);
      if ("refused" in g) throw new Error(g.refused);
      return g;
    };
    const io: GroupIo = {
      async begin(decision) {
        lane = null;
        const lr = await laneForDecision(db, d.lane, decision, [repo]);
        if (!lr) return null;
        if ("lane" in lr) { lane = lr.lane; await setExecState(db, decision, "pending"); return null; }
        if ("transient" in lr) return lr.transient;
        await setExecState(db, decision, lr.state, lr.reason);
        return lr.reason;
      },
      async failed(decision, why, err) {
        const denied = lane ? authFailure(err) : null;
        if (denied === "transient") return true;
        if (denied) { await setExecState(db, decision, denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(repo)); return true; }
        if (lane) await setExecState(db, decision, "failed", why);
        return false;
      },
      live: (n) => readLive(q(), repo, n),
      comment: async (live, body, at) => commentOn(w, await asAnswerer(at.decision), q(), "act-comment", { repo, number: at.number, id: live.id }, decisionNote((await getDecision(db, at.decision))!), body, { decision: at.decision }),
      close: async (live, at, kept) => closeItem(w, await asAnswerer(at.decision), q(), { repo, number: at.number, id: live.id, pr: live.type === "PullRequest" }, { decision: at.decision, head: live.head }, kept ? duplicateClose({ id: kept.id, pr: kept.type === "PullRequest" }, `${repo}#${kept.number}`) : "NOT_PLANNED"),
    };
    const g = await actOnGroups(db, {
      repo, io, at, log, dryRun: false,
      left: () => (params.limit === undefined ? Infinity : Math.max(0, params.limit - cardWrites - handled)),
      handled: () => { handled++; params.onHandled?.(handled); },
    });
    summary.done.push(...g.done);
    summary.skipped.push(...g.skipped);
    summary.failed.push(...g.failed);
  }
  await markExecDone(db);
  log(`act ${repo}: ${summary.done.length} closed, ${summary.skipped.length} skipped, ${summary.failed.length} failed, ${summary.asked.length} asked`);
  return summary;
}

/** An error that points at GitHub or the network, not at the target: a 5xx status, a timeout, a dropped connection or a rate limit. */
export function githubWide(e: unknown): boolean {
  const status = Number((e as { status?: unknown })?.status ?? 0);
  if (status >= 500 || status === 429) return true;
  return /\b(HTTP|status)\s*:?\s*5\d\d\b|timed? ?out|ETIMEDOUT|ECONN\w*|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|rate.?limit|abuse detection|bad gateway|service unavailable/i.test(String((e as Error)?.message ?? e));
}

/** True when the decision has close targets in another repo (a batch across repos), which this run does not settle. */
function targetsOfElsewhere(a: Actionable, repo: string): boolean {
  return a.items.some((i) => i.repo !== repo);
}

// ---- CLI -----------------------------------------------------------------------

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
  }
  if (!repo) throw new Error("missing --repo");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  act: {
    summary: "act --repo R [--limit N] [--apply]: comment and close items an operator answered close, ask Close? for reviewed PRs (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runAct(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "comment-approval": {
    summary: "comment-approval [--repo R]: which repos an operator approved for comments and closes",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const db = await openDb();
      const repos = i >= 0 ? [args[i + 1]!] : (await db.all(db.k.selectFrom("tracked_repos").select("name").orderBy("name"))).map((r) => r.name);
      for (const r of repos) {
        const a = await commentApprovalOf(db, r);
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};


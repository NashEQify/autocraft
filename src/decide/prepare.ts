// The prepare step: one judgement-model call per open decision, so every question a person has to answer comes with
// a summary, a pick and drafted answers. The call reads what stopped the pipeline (the output of the call that asked),
// the item and, for a pull request, its diff, with read-only tools on a checkout when there is one.
// A single-item decision gets an Opus turn in the item's conversation and its choices (a pick, drafted params and extras per
// core) stored as the decision's current version; a group decision gets a summary and a pick only. Our code accepts only a
// pick that is one of the decision's cores or options.
import { NoTakerError, poolRoom } from "../agents/call.ts";
import { runModelStep, type ClaudeStep } from "../agents/step.ts";
import { referenceProblems, defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { dropTexts } from "../replylint.ts";
import { referenceDir } from "../reference.ts";
import { SUMMARY_MIN, summaryInput } from "../classify/parse.ts";
import { pool } from "../classify/run.ts";
import { itemsOf, optionsOf, factsOf, type DecisionRow, type Kind } from "../decisions.ts";
import { openDecision, type NewCard } from "../conversations/cards.ts";
import { choicesTexts, parseChoices, type ParsedChoices } from "./choices-parse.ts";
import { coreSummaries } from "./choices.ts";
import { parseCoreKey, type CoreKey } from "./choices-types.ts";
import { ensureConversation, insertTurn, opusBlock, refreshItem, turnsOf, type DiffSource } from "../conversations/store.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { codeDiff } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { applicableSteps } from "../conversations/cards.ts";
import { pilotExpr } from "../pilot.ts";
import { notOwnIntegrationExpr } from "../dupes/held.ts";
import { judgementModel } from "./judgement.ts";
import { loadSummaryItems } from "./index.ts";
import { lockLiveExpr } from "../answers/hold.ts";
import { discussionKeyExpr, openSubjectExpr, prepareDue, prepareStateExpr, utcDayStart, type PrepareColumns } from "./prepared.ts";
import { PREPARE_DIFF_LIMIT, PREPARE_MEMBERS, PREPARE_STOPPED_LIMIT, PREPARE_SUMMARY_MAX, PREPARE_TURNS_LIMIT, type PrepareInput } from "./prepare-types.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const PREPARE_PROMPT = CLAUDE_PROMPTS["decide.prepare"];

/**
 * The reply as our code reads it: the summary and the checked choices block. `choices` is null for a decision that is not its
 * item's newest open one only when the model sent no block (those take the pick alone). `pickLost` is the pick the checks removed; it asks for the repeat.
 */
export type Prepared = {
  summary: string;
  choices: ParsedChoices | null;
  /** The question to the author, a proposed comment card. */
  ask: NewCard | null;
  notes: string[];
  pickLost: CoreKey | null;
  /** The reply text before the block. */
  text: string;
  /** The option key the pick names when it is an option core (the decision's recommendation), else null. */
  pick: string | null;
  reason: string;
};

type Subject = { repo: string; n: number; d: DecisionRow; /** The decision the conversation binds its choices to. */ single: boolean };

/**
 * Reads a prepare reply. The summary is the text before the block (SUMMARY_MIN to PREPARE_SUMMARY_MAX characters). A single
 * decision needs a usable choices block: its drafts replace the decision's choices whole. Any other decision takes the pick alone
 * (`o:<option key>` or null) and may come without a block. Null: no valid summary or block, so the call is repeated.
 */
export async function parsePrepareReply(db: Db, x: Subject, text: string, drop: ReadonlySet<string> = new Set()): Promise<Prepared | null> {
  const r = await parseChoices(db, x.repo, x.n, x.d, text, drop, { fresh: true, pickOnly: !x.single });
  if (!r) return null;
  const summary = r.text.replace(/\s+/g, " ").trim();
  if (summary.length < SUMMARY_MIN || summary.length > PREPARE_SUMMARY_MAX) return null;
  if (x.single && !r.choices) return null;
  const parsed = r.choices;
  const pickCore = parsed?.pick.core ? parseCoreKey(parsed.pick.core) : null;
  const pick = pickCore?.type === "option" ? pickCore.option : null;
  return { summary, choices: parsed, ask: x.single ? r.ask : null, notes: r.notes, pickLost: r.pickLost, text: r.text, pick, reason: parsed?.pick.core ? parsed.pick.reason ?? "" : "" };
}

type PrepareCtx = { db: Db; subject: Subject; dir: string | undefined; semantic: SemanticDeps | undefined };

/** The prepare call: the reply parser and the reference lint of the drafted texts (as the conversation step has). */
export const PREPARE: ClaudeStep<PrepareInput, Prepared, PrepareCtx> = {
  provider: "claude", id: "decide.prepare",
  toPrompt: (x) => [x], size: () => 1,
  lint: { fields: ["cores[].reason", "cores[].extras[].text", "cores[].extras[].title", "cores[].extras[].body", "add[].extras[].text", "add[].extras[].title", "add[].extras[].body", "ask.text"], make: (_x, c) => async (text, stage) => (c.subject.single && await parsePrepareReply(c.db, c.subject, text) ? referenceProblems(choicesTexts(text), c.dir, c.semantic, { stage }) : null) },
  // A single decision whose choices were dropped, or whose pick was dropped, is asked once more with the drop notes; the repeat's value replaces the first.
  parse: async (text, x, ctx, c) => {
    const r = await parsePrepareReply(c.db, c.subject, text, dropTexts(ctx.problems));
    if (r === null) return null;
    const empty = !r.choices || (!Object.keys(r.choices.cores).length && !r.choices.add.length);
    if (c.subject.single && ctx.attempt === 0 && !ctx.last && (r.pickLost || (empty && r.notes.length))) {
      return { value: r, rest: { ...x, previous: [...r.notes, ...(r.pickLost ? [`your pick "${r.pickLost}" is not a choice that passed the checks; pick one of the cores that did, or null`] : [])] } };
    }
    return { value: r };
  },
};

// ---- what is due ---------------------------------------------------------------

type DueRow = PrepareColumns & { id: string; repo: string; asked_at: string; number: number | null; item_kind: string | null; head_oid: string | null };

/** The head a decision is prepared for: a pull request's head commit, else null. */
const headOf = (r: { item_kind: string | null; head_oid: string | null }): string | null => (r.item_kind === "pr" ? r.head_oid : null);

/** A decision gains one level band for each day it has been open (at most all 4), so P2 decisions are not starved by a steady flow of P0 ones. Aging orders the prepares; nothing waits on a timer. */
/** The item a decision's prepare call names (none for a batch). */
export const decisionRefs = (d: { repo: string | null; number: number | null } | undefined): { repo: string; number: number }[] => (d?.repo && d.number !== null ? [{ repo: d.repo, number: d.number }] : []);

export const PREPARE_AGING_MS = 24 * 3600_000;

/**
 * Ids of the open decisions whose prepare is due (no prepare for the current state, tries left, backoff over), those an operator asked to prepare again first,
 * then repos in turn (each repo's first, then each repo's second, and so on), and within a round by the item's priority level raised by the age of the decision
 * (P0 first), then oldest first. A decision whose press is running or queued is locked and not prepared. The item's Plan says whether the decide step has work; this reads the decisions themselves.
 */
export async function prepareIds(db: Db, repos?: string[], nowMs: number = Date.now()): Promise<string[]> {
  const rows = (await db.all(db.k.selectFrom("decisions as d")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
    .leftJoin("item_rank as rk", (j) => j.onRef("rk.repo", "=", "d.repo").onRef("rk.number", "=", "d.number"))
    .select((eb) => ["d.id", "d.repo", "d.asked_at", "d.number", "d.prepare_requested_at", "d.prepared_at", "d.prepared_head", "d.prepare_failed_head", "d.recommend_failures", "d.recommend_failed_at", "i.kind as item_kind", "i.head_oid", "d.kind", "d.prepared_discussion",
      ...prepareStateExpr(db, eb, "d", utcDayStart(nowMs)),
      eb.fn.coalesce(eb.cast<number>(eb("rk.score", "/", 10000), "bigint"), eb.lit(2)).as("band")])
    .$narrowType<{ repo: string; prepares_today: number }>()
    .where((eb) => eb.and([
      eb("d.answer", "is", null), eb("d.kind", "<>", "backlog"), eb("d.repo", "is not", null), eb("d.number", "is not", null),
      openSubjectExpr(db, eb, "d", "i"), pilotExpr(db, eb, "i"), notOwnIntegrationExpr(db, eb, "i"), eb.not(lockLiveExpr(db, eb, "d")),
    ]))
    .orderBy((eb) => eb("d.prepare_requested_at", "is", null)).orderBy("d.prepare_requested_at", (o) => o.asc().nullsFirst()).orderBy("d.asked_at").orderBy("d.id"))).map((r) => ({ ...r, review_queued: Number(r.review_queued) }));
  const due = rows.filter((r) => !repos?.length || repos.includes(r.repo)).filter((r) => prepareDue(r, headOf(r), nowMs));
  const level = (r: { band: number; asked_at: string }): number => r.band + Math.min(4, Math.floor(Math.max(0, nowMs - Date.parse(r.asked_at)) / PREPARE_AGING_MS) || 0);
  // Within a repo the best (aged level, then oldest) comes first, so its round numbers follow that order.
  due.sort((x, y) => level(y) - level(x) || (x.asked_at < y.asked_at ? -1 : x.asked_at > y.asked_at ? 1 : 0) || (x.id < y.id ? -1 : 1));
  const round = new Map<string, number>();
  const turn = new Map(due.map((r) => [r.id, r.prepare_requested_at ? -1 : (round.set(r.repo, (round.get(r.repo) ?? -1) + 1), round.get(r.repo)!)]));
  return due.sort((x, y) => turn.get(x.id)! - turn.get(y.id)! || level(y) - level(x) || (x.asked_at < y.asked_at ? -1 : x.asked_at > y.asked_at ? 1 : 0) || (x.id < y.id ? -1 : 1)).map((r) => r.id);
}

// ---- what stopped the pipeline -----------------------------------------------

const cut = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const arr = (s: string | null): unknown[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };

/**
 * The output of the call that asked the question, as stored: the question's context line; for a pull request the newest Opus review
 * (verdict, reason, fixes, risks), at the current head first; the classifiers' latest labels and reasons; the duplicate comparison that
 * lists the item; for a group decision its members and roles. Maintainers' comments and opinions on the dashboard are never read here.
 */
export async function stoppedBy(db: Db, d: DecisionRow, head: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (d.context) out.context = cut(d.context, 1000);
  if (d.number === null || !d.repo) return out;
  const review = await db.get(db.k.selectFrom("opus_reviews").select(["head_oid", "verdict", "sure", "reason", "fixes", "risks"]).$narrowType<{ verdict: string }>()
    .where("repo", "=", d.repo).where("number", "=", d.number).where("verdict", "is not", null)
    .orderBy((eb) => eb("head_oid", "=", head ?? ""), "desc").orderBy("at", "desc").limit(1));
  if (review) out.review = { at_head: review.head_oid === head, verdict: review.verdict, sure: review.sure === null ? null : review.sure === 1, reason: cut(review.reason, 1500), fixes: arr(review.fixes).slice(0, 10), risks: arr(review.risks).slice(0, 10).map((r) => cut(String(r), 400)) };
  const cls = await db.all(db.k.selectFrom("classifications").select(["classifier", "at", "type_label", "want", "reference", "flags", "reason", "dup_of"])
    .where("repo", "=", d.repo).where("number", "=", d.number).orderBy("at", "desc"));
  const seen = new Set<string>();
  const classifications = cls.filter((c) => !seen.has(c.classifier) && seen.add(c.classifier)).map((c) => ({ classifier: c.classifier, type_label: c.type_label, want: c.want, reference_claim: cut(c.reference, 300) || null, flags: arr(c.flags), reason: cut(c.reason, 400), duplicate_of: c.dup_of }));
  if (classifications.length) out.classifications = classifications;
  const cmp = await db.all(db.k.selectFrom("dupe_comparisons").select(["kind", "members", "source", "reason", "result"]).where("repo", "=", d.repo)
    .where((eb) => eb.exists(eb.selectFrom(kx.jsonEach(db, "dupe_comparisons.members", "m", "bigint")).select(eb.lit(1).as("one")).where("m.value", "=", d.number!)))
    .orderBy("at", "desc").limit(2));
  if (cmp.length) out.duplicate_comparisons = cmp.map((c) => ({ kind: c.kind, members: arr(c.members), by: c.source, reason: cut(c.reason, 600), result: cut(c.result, 1500) }));
  if (d.id.includes(":dupegroup:")) {
    const members = await db.all(db.k.selectFrom("dupe_group_items").select(["number", "kind", "role", "target", "detail"]).where("decision_id", "=", d.id).orderBy("number"));
    if (members.length) out.group_members = members.map((m) => ({ number: m.number, kind: m.kind, role: m.role, target: m.target, detail: cut(m.detail, 400) || null }));
  }
  return out;
}

/** The operator messages of the item's conversation (the operator's own words and the posts they shared), newest last, cut from the front. */
async function operatorTurns(db: Db, repo: string, n: number): Promise<string> {
  const all = (await turnsOf(db, repo, n)).filter((t) => t.kind === "operator").map((t) => t.block).join("");
  return all.length > PREPARE_TURNS_LIMIT ? all.slice(all.length - PREPARE_TURNS_LIMIT) : all;
}

// ---- the step ----------------------------------------------------------------

export type PrepareParams = {
  /** The judgement model; default: the operator's setting. */
  model?: string;
  /** Host directory with a read-only checkout, or null to ask without tools: a pull request's head commit, else the repo's default branch. */
  checkout: (repo: string, number: number, head: string | null) => Promise<string | null>;
  /** PR diffs (also for the conversation's item block). */
  diff: DiffSource;
  usageRun: string;
  onSent?: () => void;
  cancelled?: () => Promise<boolean>;
  log: (line: string) => void;
  /** The semantic reference check of drafted comments; absent: the real one. */
  semantic?: SemanticDeps;
};

export type PrepareResult = { /** Decisions prepared and stored. */ stored: number; failed: number };

type ItemRow = { kind: string; state: string; mergeable: string | null; head_oid: string | null; additions: number | null; deletions: number | null; changed_files: number | null };

const now = () => new Date().toISOString();

/** The PR's CI and mergeable state as the mirror holds them now; checks count only when fetched for the current head (as in core/facts). */
function liveState(it: ItemRow, c: { head_oid: string | null; overall: string | null; mergeable: string | null } | undefined): { ci: string | null; mergeable: string } {
  const atHead = !!c && c.head_oid === it.head_oid;
  return { ci: atHead ? c!.overall ?? null : null, mergeable: (atHead ? c!.mergeable : it.mergeable) ?? "UNKNOWN" };
}

/** One call per decision id, concurrently as the Claude room allows. */
export async function prepare(db: Db, ids: string[], p: PrepareParams): Promise<PrepareResult> {
  const model = p.model ?? await judgementModel(db);
  const checkouts = new Map<string, Promise<string | null>>();
  const select = (id: string) => db.get(db.k.selectFrom("decisions").select(kx.cols("decisions")).$narrowType<{ kind: Kind }>().where("id", "=", id).where("answer", "is", null));
  const itemOf = (repo: string, n: number) => db.get(db.k.selectFrom("items").select(["kind", "state", "mergeable", "head_oid", "additions", "deletions", "changed_files"]).where("repo", "=", repo).where("number", "=", n));
  const checksOf = (repo: string, n: number) => db.get(db.k.selectFrom("pr_checks").select(["head_oid", "overall", "mergeable"]).where("repo", "=", repo).where("number", "=", n));
  const failed = (head: string | null, at: string, id: string) => db.run(db.k.updateTable("main.decisions").set((eb) => ({
    recommend_failures: eb.case().when("prepare_failed_head", "is not distinct from", head).then(eb(eb.fn.coalesce("recommend_failures", eb.lit(0)), "+", 1)).else(1).end(),
    recommend_failed_at: at, prepare_failed_head: head,
  })).where("id", "=", id));
  const store = (v: { pick: string | null; reason: string | null; by: string; summary: string; at: string; head: string | null; readKey: string; id: string; question: string; options: string }) => db.run(db.k.updateTable("main.decisions").set({
    recommended: v.pick, recommended_reason: v.reason, recommended_by: v.by, summary: v.summary, summary_by: v.by, summary_at: v.at,
    prepared_at: v.at, prepared_head: v.head, prepared_discussion: v.readKey, recommend_failures: null, recommend_failed_at: null, prepare_failed_head: null, prepare_requested_at: null,
  }).where("id", "=", v.id).where("answer", "is", null).where("question", "=", v.question).where("options", "=", v.options));
  const res: PrepareResult = { stored: 0, failed: 0 };
  const rowOf = new Map((await db.all(db.k.selectFrom("decisions").select(["id", "repo", "number"]).where(kx.inList(db, "id", ids)))).map((r) => [r.id, r]));
  await pool(ids.map((id, k) => async () => {
    if (await p.cancelled?.()) return;
    const d = await select(id);
    if (!d || !d.repo || d.number === null) return;
    const repo = d.repo, n = d.number;
    const it = await itemOf(repo, n);
    if (!it) return;
    const isPr = it.kind === "pr";
    const head = isPr ? it.head_oid : null;
    const group = d.id.includes(":dupegroup:");
    // Only the decision the conversation binds its cards to (the item's newest open one) gets a turn with cards; the item's other decisions get a summary and a pick, like groups.
    const single = !group && (await openDecision(db, repo, n))?.id === d.id;
    const options = optionsOf(d);
    const [item] = await loadSummaryItems(db, [{ repo, number: n }]);
    if (!item) return;
    const members = group ? await loadSummaryItems(db, (await db.all(db.k.selectFrom("dupe_group_items").select("number").where("decision_id", "=", d.id).orderBy("number").limit(PREPARE_MEMBERS))).map((m) => ({ repo, number: m.number }))) : [];
    const start = now();
    p.onSent?.();
    let prDiff: string | null = null;
    if (isPr && head) {
      const raw = await p.diff(repo, n, head).catch(() => null);
      if (raw) {
        let cd = codeDiff(raw);
        if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(raw, true);
        prDiff = cd.text.length <= PREPARE_DIFF_LIMIT ? cd.text : null;
      }
    }
    const ckey = `${repo}#${isPr ? n : 0}@${head ?? ""}`;
    if (!checkouts.has(ckey)) checkouts.set(ckey, p.checkout(repo, n, head).catch(() => null));
    const checkout = await checkouts.get(ckey)!;
    // The conversation (item block, updates) is brought up to date before the call: the drafts are stamped with what the call was told.
    if (single) {
      await ensureConversation(db, repo, n, "opus", { diff: p.diff }).catch((e) => p.log(`decide: no conversation for ${id}: ${(e as Error).message}`));
      await refreshItem(db, repo, n, { diff: p.diff }).catch(() => false);
    }
    const input: PrepareInput = {
      ref: `${repo}#${n}`, item: { ...summaryInput(item), steps: await applicableSteps(db, repo, n) }, question: d.question, facts: factsOf(d),
      options: options.map((o) => ({ key: o.key, label: o.label, hint: o.hint ?? "" })),
      cores: single ? await coreSummaries(db, d) : [],
      stopped: await stoppedBy(db, d, head),
      ...(!single && { group: true }), ...(group && { members: members.map(summaryInput) }),
      ...(isPr && { pr: { head, lines: { additions: it.additions, deletions: it.deletions, files: it.changed_files }, diff: prDiff, live: liveState(it, await checksOf(repo, n)) } }),
    };
    const turns = group ? "" : await operatorTurns(db, repo, n);
    if (turns) input.operator_turns = turns;
    if (checkout) input.repo_dir = REPO_PATH;
    const dir = referenceDir(repo);
    const semantic = p.semantic ?? defaultSemanticDeps(db, `${repo}#${n}`);
    // What the call reads of the discussion, kept with the prepare; the call counts against the decision's daily cap unless an operator asked for it.
    const readKey = (await db.get(db.k.selectFrom("decisions as d").select((eb) => discussionKeyExpr(db, eb, "d").as("k")).where("d.id", "=", d.id)))?.k ?? "";
    const tried = (await db.get(db.k.insertInto("main.decision_prepares").values({ decision_id: d.id, at: now(), manual: d.prepare_requested_at ? 1 : 0 }).returning(kx.rowid("main.decision_prepares").as("rowid"))))!.rowid;
    let r;
    try {
      r = await runModelStep(db, PREPARE, input, {
        model, checkout: checkout ?? undefined, reference: checkout ? dir : undefined,
        ctx: { db, subject: { repo, n, d, single }, dir, semantic },
        usage: { run: p.usageRun, agent: `prepare-${String(k).padStart(3, "0")}`, stage: "decide", model, items: () => 1 },
        onReply: (reply) => { if (reply.fixTurn) p.log(`decide: ${id}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
        cancelled: p.cancelled,
      });
    } catch (e) {
      // A call no Task Runner took was not a try: it uses none of the decision's daily cap.
      if (e instanceof NoTakerError) await db.run(db.k.deleteFrom("main.decision_prepares").where(kx.rowid("main.decision_prepares"), "=", tried));
      throw e;
    }
    if (!r.ok) {
      if (await p.cancelled?.()) return;
      await failed(head, now(), d.id);
      res.failed++;
      p.log(`decide: no valid prepare for ${d.id}; retried in an hour, at most 3 tries`);
      return;
    }
    const got = r.value;
    const by = r.model ?? model;
    // The PR moved on while the call ran: the next pass prepares it for the new head. A group's kept item may be closed; prepareIds decides whether the group is still open.
    const after = await itemOf(repo, n);
    if (!after || (!group && after.state !== "OPEN") || (isPr && (d.kind === "merge" || d.kind === "hold") && after.head_oid !== head)) {
      // Counted as a try at the head it was asked for: a new head is prepared at once, anything else waits like a failure instead of repeating every pass.
      await failed(head, now(), d.id);
      p.log(`decide: ${d.id}: head moved on during the call; prepared again next pass`);
      return;
    }
    // The decision was answered or asked again while the call ran: nothing is stored, the next pass prepares what is still open.
    if (!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", d.id).where("answer", "is", null).where("question", "=", d.question).where("options", "=", d.options))) return;
    const at = now();
    try {
      if (single) {
        const cards = got.ask ? [got.ask] : [];
        await insertTurn(db, repo, n, { kind: "opus", login: "opus", body: got.text, block: opusBlock(got.text, cards, got.choices), notes: got.notes, cards, ...(got.choices && { choices: { decision: d, parsed: got.choices, source: "prepare" as const, by } }) }, { diff: p.diff });
      }
      await store({ pick: got.pick, reason: got.pick ? got.reason || null : null, by, summary: got.summary, at, head, readKey, id: d.id, question: d.question, options: d.options });
      res.stored++;
    } catch (e) {
      p.log(`decide: could not store the prepare of ${d.id}: ${(e as Error).message}`);
      try { await failed(head, now(), d.id); } catch { /* the next pass tries again */ }
      res.failed++;
    }
  }), poolRoom(db, (i) => { const repo = rowOf.get(ids[i]!)?.repo; return repo ? [repo] : undefined; }, (i) => decisionRefs(rowOf.get(ids[i]!)), { promptId: "decide.prepare" }), { first: true });
  return res;
}

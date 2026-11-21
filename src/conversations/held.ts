// Follow-up issues held until the merge. A card that merges the PR (a Merge answer, or a fix-up that merges: holdsIssues) does not open
// its issue at the press: it stores it here, and the Act step files it once the PR merged, whoever merged it. A PR closed without merging,
// or a merge path that ended (the Merge answer taken back, set aside or changed; the pre-approved merge cancelled, failed or handed back as
// a question), drops it. The Act step reads these rows when the planner sees the PR's state or the merge path change: no timer runs.
//
// Filing writes the `filing` row before the call. A create whose answer was lost leaves that row behind: the issue may exist, so it is never
// filed again and the item page says the outcome is unknown. Only a refusal from GitHub (no issue can exist) returns the row to `held`.
import { guardRepo } from "../core/guard.ts";
import { getDecision, optionsOf } from "../decisions.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { createIssue, IssueError, PACE_MAX_WAIT_MS, type Note, type Writer } from "../github/write.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { isQuiet } from "../security/quiet.ts";
import { settlesNow } from "../settlers.ts";
import { actRoom } from "./queue.ts";
import { conversationOf, insertTurn, systemBlock } from "./store.ts";
import { filterSeq } from "../async-seq.ts";
import type { NotNull } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type HeldState = "held" | "filing" | "filed" | "dropped" | "failed";
export type HeldRow = {
  id: number; card_id: number; choice_id: string | null; decision_id: string | null; answer_seq: number | null; preapproval_id: number | null;
  repo: string; number: number; issue_repo: string; title: string; body: string; by: string; at: string;
  state: HeldState; issue_number: number | null; url: string | null; reason: string | null; attempts: number; updated_at: string;
};

/** Refusals from GitHub before the row stops being tried; each failed try ends the Act job as failed, so the registered failure backoff spaces them. */
export const HELD_MAX_ATTEMPTS = 3;

/** Held issues come from conversation cards, which always run on the conversation prompt's first model (as src/conversations/act.ts posts them). */
const NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };
const ref = (repo: string, n: number) => `${repo}#${n}`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").trim().slice(0, 300);

export async function holdFollowup(db: Db, h: Pick<HeldRow, "card_id" | "choice_id" | "decision_id" | "answer_seq" | "preapproval_id" | "repo" | "number" | "issue_repo" | "title" | "body" | "by" | "at">): Promise<number> {
  return (await db.get(db.k.insertInto("main.held_followups")
    .values({ card_id: h.card_id, choice_id: h.choice_id, decision_id: h.decision_id, answer_seq: h.answer_seq, preapproval_id: h.preapproval_id, repo: h.repo, number: h.number, issue_repo: h.issue_repo, title: h.title, body: h.body, by: h.by, at: h.at, state: "held", updated_at: h.at })
    .returning("id")))!.id;
}

/** The item's held follow-ups, oldest first. */
export const heldOf = async (db: Db, repo: string, n: number): Promise<HeldRow[]> =>
  await db.all(db.k.selectFrom("main.held_followups").select(kx.cols("main.held_followups")).$narrowType<{ state: HeldState }>()
    .where("repo", "=", repo).where("number", "=", n).orderBy("id"));

/** Answer, undo and reopen audit rows of the decision: the card stores the count once it answered, and any later one ends its merge path. */
export const answerSeqOf = async (db: Db, decision: string): Promise<number> =>
  (await db.get(db.k.selectFrom("main.audit").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("target", "=", decision).where("action", "in", ["answer", "undo", "reopen"])))!.n;

type Ended = { why: string; at: string };

/**
 * Whether the merge path this row was held on has ended, why and when. The row is bound to the path its press made: the pre-approved merge
 * it started, or its Merge answer as the decision's answer history stood then, so a new answer or a new pre-approval never revives it.
 */
async function pathEnded(db: Db, h: HeldRow, nowIso: string): Promise<Ended | null> {
  if (h.preapproval_id !== null) {
    const p = await db.get(db.k.selectFrom("main.preapprovals").select(["state", "updated_at"]).where("id", "=", h.preapproval_id));
    if (!p) return { why: "the pre-approved merge is gone", at: nowIso };
    if (p.state === "asked") return { why: "the pre-approved merge was handed back as a question", at: p.updated_at };
    if (p.state === "cancelled" || p.state === "failed") return { why: `the pre-approved merge was ${p.state}`, at: p.updated_at };
    return null;
  }
  if (h.decision_id === null) return null;
  const d = await getDecision(db, h.decision_id);
  if (!d) {
    const pattern = `${h.decision_id.replace(/[\\%_]/g, "\\$&")}~replaced-%`;
    const aside = await db.get(db.k.selectFrom("main.decisions").select(["answer_note", "applied_at"])
      .where((eb) => kx.like(db, "id", eb.val(pattern), "\\")).orderBy("id", "desc").limit(1));
    return aside ? { why: `the Merge answer was set aside${aside.answer_note ? `: ${aside.answer_note}` : ""}`, at: aside.applied_at ?? nowIso } : { why: "the Merge question is gone", at: nowIso };
  }
  const later = h.answer_seq === null ? undefined
    : await db.get(db.k.selectFrom("main.audit").select(["action", "at"]).where("target", "=", h.decision_id).where("action", "in", ["answer", "undo", "reopen"])
      .orderBy(kx.rowid("main.audit")).limit(1).offset(h.answer_seq));
  if (later) return { why: later.action === "answer" ? "the Merge question was answered again" : later.action === "undo" ? "the Merge answer was taken back" : "the Merge question was reopened", at: later.at };
  if (d.answer === "merge") return null;
  const why = d.answer === null ? "the Merge answer was taken back" : `the question was answered "${optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer}"`;
  return { why, at: d.answered_at ?? nowIso };
}

/**
 * What to do with a held row now: file it, drop it (with the reason), or keep holding (null). A merged PR files unless its path ended before
 * the merge: a pre-approval the merge itself cancelled ("merged before the fix-up finished") does not count.
 */
export async function heldVerdict(db: Db, h: HeldRow, nowIso: string = new Date().toISOString()): Promise<{ file: true } | { drop: string } | null> {
  const it = await db.get(db.k.selectFrom("main.items").select(["state", "merged_at"]).where("repo", "=", h.repo).where("number", "=", h.number));
  if (!it) return null;
  if (it.state === "CLOSED") return { drop: "the PR was closed without merging" };
  const ended = await pathEnded(db, h, nowIso);
  if (it.state !== "MERGED") return ended ? { drop: ended.why } : null;
  const mergedAt = it.merged_at ?? nowIso;
  return ended && Date.parse(ended.at) < Date.parse(mergedAt) ? { drop: ended.why } : { file: true };
}

/** A row left in `filing` past this was not being filed any more (a create takes seconds; the write pacing waits at most PACE_MAX_WAIT_MS). */
export const HELD_STUCK_MS = Math.max(10 * 60_000, 4 * PACE_MAX_WAIT_MS);

/**
 * What the audit row of a row left in `filing` tells: "filed" (with the issue) when the create finished with a URL, "held" when no write
 * was ever recorded for it (nothing was sent), null when the outcome stays unknown.
 */
export async function filingOutcome(db: Db, h: HeldRow, ms: number = Date.now()): Promise<{ state: "filed"; number: number; url: string } | { state: "held" } | null> {
  if (h.state !== "filing" || Date.parse(h.updated_at) > ms - HELD_STUCK_MS) return null;
  const a = await db.get(db.k.selectFrom("main.audit").select("details").$narrowType<{ details: NotNull }>()
    .where("action", "=", "act-open-issue")
    .where((eb) => eb(kx.jsonNum(db, eb.case().when(kx.jsonValid(db, "details")).then(eb.ref("details")).end(), "$.held"), "=", h.id))
    .where("at", ">=", h.updated_at).orderBy(kx.rowid("main.audit"), "desc").limit(1));
  if (!a) return { state: "held" };
  const d = JSON.parse(a.details) as { state?: string; url?: string };
  const m = d.state === "done" ? /\/issues\/(\d+)/.exec(d.url ?? "") : null;
  return m ? { state: "filed", number: Number(m[1]), url: d.url! } : null;
}

/** The held rows of the PRs of `repo` that the Act step has to file or drop now. */
export async function dueHeld(db: Db, repo?: string): Promise<HeldRow[]> {
  const rows = await db.all(db.k.selectFrom("main.held_followups").select(kx.cols("main.held_followups")).$narrowType<{ state: HeldState }>()
    .where("state", "in", ["held", "filing"]).$if(!!repo, (q) => q.where("repo", "=", repo!)).orderBy("id"));
  return await filterSeq(rows, async (h) => (h.state === "filing" ? await filingOutcome(db, h) !== null : await heldVerdict(db, h) !== null));
}

/**
 * The repos whose Act job has held rows to file or drop now; `fits`: false when every one of them is to be filed and the daily count has
 * no room (the planner then wakes when room returns). Also the signature of that input for the planner.
 */
export async function heldDue(db: Db, ms: number = Date.now()): Promise<{ repos: Map<string, boolean>; sig: string }> {
  const room = await actRoom(db, 1, ms);
  const repos = new Map<string, boolean>();
  for (const h of await dueHeld(db)) {
    const v = h.state === "filing" ? null : await heldVerdict(db, h);
    repos.set(h.repo, (repos.get(h.repo) ?? false) || room || h.state === "filing" || (v !== null && "drop" in v));
  }
  return { repos, sig: repos.size ? `held:${[...repos].map(([r, f]) => `${r}=${f ? 1 : 0}`).join(",")}` : "" };
}

/** When rows in `filing` become old enough for filingOutcome to settle them: the planner wakes then. */
export async function filingWakes(db: Db, ms: number = Date.now()): Promise<number[]> {
  return (await db.all(db.k.selectFrom("main.held_followups").select("updated_at").where("state", "=", "filing")))
    .map((r) => Date.parse(r.updated_at) + HELD_STUCK_MS).filter((t) => t > ms);
}

/** The PR's thread line (when it has a conversation): what became of the held issue. */
async function say(db: Db, h: HeldRow, text: string): Promise<void> {
  if (await conversationOf(db, h.repo, h.number)) await insertTurn(db, h.repo, h.number, { kind: "system", login: "system", body: text, block: systemBlock(text) });
}

async function drop(db: Db, h: HeldRow, reason: string, at: string): Promise<boolean> {
  const r = await db.run(db.k.updateTable("main.held_followups").set({ state: "dropped", reason, updated_at: at }).where("id", "=", h.id).where("state", "=", "held"));
  if (r.changes !== 1) return false;
  await say(db, h, `The issue "${h.title}" held for after the merge is dropped: ${reason}.`);
  return true;
}

export type HeldDeps = { exec?: Exec; now?: () => Date };
/** `paced`: the write pacing's message when it held a create back (the job fails with it, as other paced jobs do). */
export type HeldSummary = { filed: number; dropped: number; failed: { ref: string; reason: string }[]; unknown: number; writes: number; paced?: string };

/**
 * Files or drops the due held follow-ups of the PRs of `repo`, oldest first. Each issue is one GitHub write of the Act step's shared daily
 * count (it goes out as a card write of the card that held it); the run stops at the first that finds no room, or past `writes` (what the
 * Act job still allows). A presser who no longer settles on the issue's repo, or a PR that turned quiet, drops the row; a missing approval
 * keeps it held with the reason. A create with an unknown outcome, or one the write pacing held back, ends the run. A row a stopped process left
 * in `filing` is settled from its audit row (filingOutcome). held_followups is not planner input, so these row writes never re-queue the job.
 */
export async function fileHeldFollowups(db: Db, repo: string, deps: HeldDeps = {}, o: { writes?: number } = {}): Promise<HeldSummary> {
  const s: HeldSummary = { filed: 0, dropped: 0, failed: [], unknown: 0, writes: 0 };
  const now = () => (deps.now?.() ?? new Date());
  for (const h of await dueHeld(db, repo)) {
    const at = now().toISOString();
    if (h.state === "filing") {
      // Left behind by a stopped process: its audit row says whether the create finished, or never went out.
      const f = await filingOutcome(db, h, now().getTime());
      if (f?.state === "filed") { await db.run(db.k.updateTable("main.held_followups").set({ state: "filed", issue_number: f.number, url: f.url, reason: null, updated_at: at }).where("id", "=", h.id).where("state", "=", "filing")); s.filed++; }
      else if (f?.state === "held") await db.run(db.k.updateTable("main.held_followups").set((eb) => ({ state: "held", attempts: eb.case().when("attempts", ">", eb.lit(0)).then(eb("attempts", "-", eb.lit(1))).else(eb.lit(0)).end(), updated_at: at })).where("id", "=", h.id).where("state", "=", "filing"));
      continue;
    }
    const v = await heldVerdict(db, h, at);
    if (!v) continue;
    if ("drop" in v) { if (await drop(db, h, v.drop, at)) s.dropped++; continue; }
    if (await isQuiet(db, h.repo, h.number)) { if (await drop(db, h, "the pull request is quiet until its fix is published", at)) s.dropped++; continue; }
    if (!await settlesNow(db, h.by, [h.issue_repo])) { if (await drop(db, h, `${h.by} no longer has write access to ${h.issue_repo}`, at)) s.dropped++; continue; }
    const g = await guardRepo(db, h.issue_repo, "comment", { operator: h.by }, undefined, h.by);
    if ("refused" in g) {
      await db.run(db.k.updateTable("main.held_followups").set({ reason: g.refused }).where("id", "=", h.id).where("state", "=", "held"));
      continue;
    }
    if ((o.writes !== undefined && s.writes >= o.writes) || !await actRoom(db, 1, now().getTime())) break;
    const attempts = h.attempts + 1;
    if ((await db.run(db.k.updateTable("main.held_followups").set({ state: "filing", attempts, updated_at: at }).where("id", "=", h.id).where("state", "=", "held"))).changes !== 1) continue;
    s.writes++;
    const w: Writer = { db, login: h.by };
    let made: { number: number; url: string };
    try {
      made = await createIssue(w, g, deps.exec ?? defaultExec, { repo: h.issue_repo, target: ref(h.repo, h.number), title: h.title, body: h.body, action: "act-open-issue" }, NOTE, { source: "conversation", card: h.card_id, held: h.id });
    } catch (e) {
      const reason = oneLine(e);
      // The network or GitHub is likely failing: the rest waits for the next run.
      if (!(e instanceof IssueError) || !e.clear) { s.unknown++; break; }
      // The write pacing sent nothing: no try is counted; the job fails with the pacing message, which the failure backoff ignores, so the next pass runs it again.
      if (e.paced) {
        await db.run(db.k.updateTable("main.held_followups").set({ state: "held", attempts: h.attempts }).where("id", "=", h.id).where("state", "=", "filing"));
        s.paced = reason;
        break;
      }
      const end = attempts >= HELD_MAX_ATTEMPTS;
      await db.run(db.k.updateTable("main.held_followups").set({ state: end ? "failed" : "held", reason, updated_at: now().toISOString() }).where("id", "=", h.id).where("state", "=", "filing"));
      if (end) await say(db, h, `The issue "${h.title}" held for after the merge could not be opened: ${reason}.`);
      s.failed.push({ ref: ref(h.repo, h.number), reason });
      continue;
    }
    await db.run(db.k.updateTable("main.held_followups").set({ state: "filed", issue_number: made.number, url: made.url, reason: null, updated_at: now().toISOString() }).where("id", "=", h.id));
    await say(db, h, `The PR merged: opened ${ref(h.issue_repo, made.number)}, the issue "${h.title}" held for after the merge.`);
    s.filed++;
  }
  return s;
}

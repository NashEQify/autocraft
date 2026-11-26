// The work on the items a thread (or a command reply) follows, posted where the command was answered (src/discord/threads.ts).
//
// What is posted: for each followed item, its status line whenever it changes (the first line of the item's GitHub status comment,
// src/prstatus: "Running: review", "Running: fix-up: 1 and 2", "Stopped at a blocker: …", "Held by …", "Merged"), and its result when
// it comes back to a person: the numbered parts and the recommendation line, the same words as the status comment, with a link button
// to that comment (to the item where none is known). The status lines of one target that changed together go in one message. A result
// that changes while it stays open (a part dropped, a new recommendation text at the same time) edits its message.
//
// Long results: a result that does not fit one message gets a Haiku summary of its parts (discord.result.haiku, on an Interactive
// slot); the recommendation line stays word for word. Without a summary the parts are cut to fit, with how many more are on GitHub.
//
// Private repos and quiet PRs (visibility.ts discordDetail): status lines and links only, never parts, recommendations or review text.
//
// When: like Alerts.start (alerts.ts), a poll of the change markers of the `workflows` topic; a change runs one pass. Nothing here
// writes a planner topic (`discord_follow_posts` feeds none). What was posted is kept per (target, item) in `discord_follow_posts`, so
// a restart posts nothing twice. A thread that is gone, or where the bot may no longer post, stops being followed.
import { createHash } from "node:crypto";
import { runModelStep, type ClaudeStep } from "../agents/step.ts";
import { exclusive } from "../async-seq.ts";
import * as dc from "../data/discord/index.ts";
import type { FollowPost } from "../data/discord/index.ts";
import { loadStatusCommentIds, loadWorkflowHistory } from "../data/workflow/index.ts";
import { loadStatusExtras } from "../data/views/prStatus.ts";
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import { partLine, statusLine, workflowLines, type StatusFacts } from "../prstatus/index.ts";
import { commentStatuses } from "../public/status.ts";
import { recommendationLine } from "../workflow/status.ts";
import { ASKING_STATES, shownWorkflow, type ItemRef, type ItemWorkflow, type WorkflowState } from "../workflow/types.ts";
import { legWaits } from "../workflow/waits.ts";
import type { DiscordKeys } from "./keys.ts";
import { DISCORD_TAKE_WAIT_MS } from "./limits.ts";
import { RestError, type DiscordRest } from "./rest.ts";
import { parseResult, type ResultAsk, type ResultLine } from "./result-ask.ts";
import { allFollows, sendToFollow, type Follow } from "./threads.ts";
import { discordDetail, type DiscordDetail } from "./visibility.ts";

/** Discord allows 2000 characters per message; a result is kept under this. */
export const RESULT_MAX = 1900;
const POLL_MS = 2000;
const TOPICS = ["workflows"];
/** Link buttons in one action row. */
const ROW_BUTTONS = 5;

/** What the thread shows of one item. `result`: the parts and recommendation, null while nothing waits for a person or where only status may show. */
export type ItemView = {
  ref: ItemRef; key: string; url: string; status: string;
  result: { key: string; parts: { n: number; title: string; state: "planned" | "dropped" | "fixed"; major?: boolean }[]; rec: string | null } | null;
};

export type ResultDeps = {
  db: Db; keys: DiscordKeys; rest: Pick<DiscordRest, "createMessage" | "editMessage">; log: (line: string) => void;
  /** The Haiku summary of a long result's parts; null when there is none. Tests replace it. */
  summarize?: (db: Db, a: ResultAsk) => Promise<ResultLine[] | null>;
  now?: () => number;
};

const SUMMARY_STEP: ClaudeStep<ResultAsk, ResultLine[]> = {
  provider: "claude", id: "discord.result.haiku",
  toPrompt: (a) => [a],
  parse: async (text, a) => {
    const v = parseResult(text, a);
    return v === null ? null : { value: v };
  },
};

export const modelSummary = async (db: Db, a: ResultAsk): Promise<ResultLine[] | null> => {
  const r = await runModelStep(db, SUMMARY_STEP, a, { maxWaitMs: DISCORD_TAKE_WAIT_MS });
  return r.ok ? r.value : null;
};

const shortKey = (i: ItemRef): string => `${i.repo.split("/").pop()!}#${i.number}`;
const hash = (s: string): string => createHash("sha256").update(s).digest("base64url").slice(0, 22);
/** Text from GitHub or a model in a message: no mention or link syntax, one line. */
const plain = (s: string): string => s.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
const bold = (s: string): string => s.replace(/^\*\*(.*)\*\*$/, "$1");

/** What each followed item shows now, by `repo#number`; an item without a public status row is absent. */
export async function itemViews(db: Db, refs: readonly ItemRef[]): Promise<Map<string, ItemView>> {
  const out = new Map<string, ItemView>();
  if (!refs.length) return out;
  const keys = refs.map(shortKey);
  const [history, statuses, detail, commentIds] = await db.together(() => Promise.all([
    loadWorkflowHistory(db, [...refs]), commentStatuses(db, refs), discordDetail(db, refs), loadStatusCommentIds(db, keys),
  ]));
  const wfs = new Map<string, ItemWorkflow>();
  for (const k of keys) { const w = shownWorkflow(history.get(k) ?? []); if (w) wfs.set(k, w); }
  const [extras, waits] = await Promise.all([loadStatusExtras(db, refs, [...wfs.values()].map((w) => w.id)), legWaits(db, [...wfs.values()])]);
  for (const ref of refs) {
    const key = shortKey(ref);
    const status = statuses.get(key);
    if (!status) continue;
    const wf = wfs.get(key);
    const pr = (status.queue ? extras.batches.get(`open:${key}`) : status.step === "Merged" ? extras.batches.get(`merged:${key}`) : undefined)?.pr;
    const a = wf ? extras.answered.get(wf.id) : undefined;
    const facts: StatusFacts = {
      status, ...(pr ? { batch: { pr } } : {}),
      ...(wf ? { workflow: { wf, answered: a ? { by: a.login, at: a.at } : null, quiet: extras.quiet.has(key), wait: waits.get(wf.id) ?? null } } : {}),
    };
    const line = facts.workflow ? bold(workflowLines({ ...facts, workflow: facts.workflow })[0]!) : statusLine(facts);
    const id = commentIds.get(key);
    const full: DiscordDetail = detail.get(key) ?? "status";
    const asking = !!wf && (ASKING_STATES as readonly WorkflowState[]).includes(wf.state) && status.step !== "Merged" && status.step !== "Closed";
    out.set(key, {
      ref, key, url: id ? `${status.url}#issuecomment-${id}` : status.url, status: line,
      result: asking && full === "full" ? {
        key: `${wf!.id}|${wf!.recAt ?? ""}|${wf!.state}`,
        parts: wf!.plan.map((p) => ({ n: p.n, title: plain(p.title), state: p.state, ...(p.major ? { major: true } : {}) })),
        rec: recommendationLine(wf!.rec),
      } : null,
    });
  }
  return out;
}

const button = (label: string, url: string): unknown => ({ type: 2, style: 5, label: label.slice(0, 80), url });
const rows = (buttons: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (let i = 0; i < buttons.length && out.length < 5; i += ROW_BUTTONS) out.push({ type: 1, components: buttons.slice(i, i + ROW_BUTTONS) });
  return out;
};

/** The result's text as GitHub's status comment shows it: the status line, the parts, the recommendation line. */
export const fullResult = (v: ItemView): string => {
  const r = v.result!;
  return [`**${v.key}** ${v.status}`, ...(r.parts.length ? [[t("Parts:"), ...r.parts.map(partLine)].join("\n")] : []), ...(r.rec ? [r.rec] : [])].join("\n\n");
};

/** The result cut to fit: as many parts as fit before the recommendation line, which is kept whole. */
export function cutResult(v: ItemView, max = RESULT_MAX): string {
  const r = v.result!;
  const head = `**${v.key}** ${v.status}`;
  const rec = r.rec ? r.rec.slice(0, Math.max(0, max - head.length - 200)) : null;
  let room = max - head.length - (rec ? rec.length + 2 : 0) - 60;
  const lines: string[] = [];
  for (const p of r.parts) {
    const l = partLine(p);
    if (l.length + 1 > room) break;
    lines.push(l);
    room -= l.length + 1;
  }
  const more = r.parts.length - lines.length;
  if (more) lines.push(t("- …and {n} more on GitHub", { n: more }));
  return [head, ...(r.parts.length ? [[t("Parts:"), ...lines].join("\n")] : []), ...(rec ? [rec] : [])].join("\n\n").slice(0, max);
}

/** The result with Haiku's summary of its parts; the recommendation line word for word. */
export function summaryResult(v: ItemView, lines: readonly ResultLine[], max = RESULT_MAX): string {
  const r = v.result!;
  const text = [
    `**${v.key}** ${v.status}`,
    [t("Main findings, in short:"), ...lines.map((l) => `- **${l.parts.join(", ")}** ${plain(l.text)}`)].join("\n"),
    ...(r.rec ? [r.rec] : []),
    t("The full result is on GitHub."),
  ].join("\n\n");
  return text.length <= max ? text : cutResult(v, max);
}

export class ThreadResults {
  #d: ResultDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = "";

  constructor(d: ResultDeps) {
    this.#d = d;
  }

  /** Polls the change markers of the workflow topic; a change runs one pass. Runs a first pass at once. */
  start(signal: AbortSignal): void {
    void this.sync();
    const poll = exclusive(async () => {
      try {
        const seqs = await this.#d.db.seqs();
        const sig = TOPICS.map((k) => seqs[k] ?? 0).join(",");
        if (sig !== this.#last) { this.#last = sig; void this.sync(); }
      } catch (e) {
        this.#d.log(`discord: thread results poll failed: ${(e as Error).message}`);
      }
    });
    const timer = setInterval(() => void poll.skip(), POLL_MS);
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /** One pass. Passes never overlap; a request during a pass runs another after it, and its promise resolves when that one has finished. */
  sync(): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          try { await this.#pass(); } catch (e) { this.#d.log(`discord: thread results pass failed: ${(e as Error).message}`); }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  async #pass(): Promise<void> {
    const { db, keys } = this.#d;
    const [follows, posts] = await Promise.all([allFollows(db, keys), dc.loadFollowPosts(db)]);
    const followed = new Set(follows.flatMap((f) => f.items.map((i) => dc.followPostKey({ targetHash: f.targetHash, repo: i.repo, number: i.number }))));
    if ([...posts.keys()].some((k) => !followed.has(k))) await dc.pruneFollowPosts(db);
    if (!follows.length) return;
    const refs = [...new Map(follows.flatMap((f) => f.items).map((i) => [shortKey(i), i])).values()];
    const views = await itemViews(db, refs);
    for (const f of follows) {
      try {
        await this.#target(f, views, posts);
      } catch (e) {
        // Gone (404) or no longer allowed (403): the target stops following. Anything else is tried again on the next change.
        if (e instanceof RestError && (e.status === 404 || e.status === 403)) {
          this.#d.log(`discord: thread results: target ${f.targetHash.slice(0, 8)} is gone or closed to the bot (${e.status}); it stops following`);
          await dc.removeFollows(db, [f.targetHash]);
        } else {
          this.#d.log(`discord: thread results not posted: ${(e as Error).message}`);
        }
      }
    }
  }

  /** One message of the target's changed status lines, then one message per new result; each post is recorded as soon as it is sent. */
  async #target(f: Follow, views: Map<string, ItemView>, posts: Map<string, FollowPost>): Promise<void> {
    const { db, keys, rest } = this.#d;
    const at = new Date((this.#d.now ?? Date.now)()).toISOString();
    const changed: { v: ItemView; post: FollowPost }[] = [];
    for (const item of f.items) {
      const v = views.get(shortKey(item));
      if (!v) continue;
      const base = { targetHash: f.targetHash, repo: item.repo, number: item.number };
      const prev = posts.get(dc.followPostKey(base));
      const statusHash = hash(v.status);
      if (v.result) {
        // Hashed before any summary, so an unchanged result makes no model call.
        const resultHash = hash(`${fullResult(v)}\0${v.url}`);
        if (prev?.resultKey === v.result.key && prev.resultHash === resultHash) continue;
        const body = { content: await this.#resultText(v), components: rows([button(t("Full result on GitHub"), v.url)]) };
        if (prev?.resultKey === v.result.key) {
          const msg = prev.sealed ? keys.open(prev.sealed, sealAad(base))?.messageId : undefined;
          if (msg) {
            await rest.editMessage(f.target.channelId, msg, body);
            await dc.saveFollowPosts(db, [{ ...prev, statusHash, resultHash, at }]);
            continue;
          }
        }
        const sent = await sendToFollow(rest, f.target, body);
        const sealed = keys.seal({ guildId: f.target.guildId, channelId: f.target.channelId, messageId: sent.id, at }, sealAad(base));
        await dc.saveFollowPosts(db, [{ ...base, statusHash, resultKey: v.result.key, resultHash, sealed, at }]);
        continue;
      }
      if (prev?.statusHash === statusHash) continue;
      changed.push({ v, post: { ...base, statusHash, resultKey: prev?.resultKey ?? "", resultHash: prev?.resultHash ?? "", sealed: prev?.sealed ?? "", at } });
    }
    if (!changed.length) return;
    const content = changed.map(({ v }) => `**${v.key}** ${v.status}`).join("\n").slice(0, RESULT_MAX);
    await sendToFollow(rest, f.target, { content, components: rows(changed.slice(0, 25).map(({ v }) => button(v.key, v.url))) });
    await dc.saveFollowPosts(db, changed.map((c) => c.post));
  }

  /** The full result when it fits, else Haiku's summary, else the result cut to fit. */
  async #resultText(v: ItemView): Promise<string> {
    const full = fullResult(v);
    if (full.length <= RESULT_MAX) return full;
    const r = v.result!;
    let lines: ResultLine[] | null = null;
    try {
      lines = await (this.#d.summarize ?? modelSummary)(this.#d.db, { ref: v.key, recommendation: r.rec, parts: r.parts });
    } catch (e) {
      this.#d.log(`discord: result summary failed: ${(e as Error).message.slice(0, 200)}`);
    }
    return lines ? summaryResult(v, lines) : cutResult(v);
  }
}

const sealAad = (p: { targetHash: string; repo: string; number: number }): string => `result:${p.targetHash}:${p.repo}#${p.number}`;

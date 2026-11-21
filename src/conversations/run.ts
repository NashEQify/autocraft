// The Conversation step: answers each operator message that waits for Opus with one sandboxed `claude -p` call
// (the item's repository and the workspace, read-only) and stores the reply with its action cards.
import { jobItem } from "../runner/job-items.ts";
import { referenceDir } from "../reference.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { poolRoom, takersFirst } from "../agents/call.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { CONVERSATION } from "../agents/steps.ts";
import { PROGRESS_KEEP, coalesce } from "../classify/progress.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { sweepRunningCards } from "./act.ts";
import { decisionStamp, openDecision } from "./cards.ts";
import { claimPending, failTurn, pendingConversations, promptParts, refreshItem, setTurnProgress, storeReply, type DiffSource } from "./store.ts";
import type { Db } from "../db/index.ts";

export const CONVERSATION_PROMPT = CLAUDE_PROMPTS["conversation.turn"];

export type ConversationParams = {
  /** Most messages to answer in this run. */
  limit?: number;
  model?: string;
  /** Read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  diff?: DiffSource;
  usageRun: string;
  onHandled?: (n: number) => void;
  cancelled?: () => Promise<boolean>;
  log: (line: string) => void;
  /** The Jev and Haiku calls of the semantic reference check; absent: the real ones. */
  semantic?: SemanticDeps;
};

const now = () => new Date().toISOString();

/** Answers the waiting messages, oldest first. Returns how many got a reply. */
export async function answerPending(db: Db, p: ConversationParams): Promise<number> {
  const model = p.model ?? CONVERSATION_PROMPT.models[0]!;
  let todo = await pendingConversations(db);
  if (p.limit !== undefined) todo = (await takersFirst(db, todo, (c) => [c.repo], (c) => [c], CONVERSATION_PROMPT.id)).slice(0, Math.max(0, p.limit));
  const checkouts = new Map<string, Promise<string | null>>();
  let answered = 0, handled = 0;
  await pool(todo.map((c, k) => async () => {
    if (await p.cancelled?.()) return;
    const { repo, number: n } = c;
    const start = now();
    // The item may have changed since the message was written; the update goes in front of the message.
    await refreshItem(db, repo, n, { diff: p.diff });
    // One run holds the message; another run or a second start skips it.
    const held = await claimPending(db, repo, n);
    if (!held) return;
    const { turn: wait, claim } = held;
    p.onHandled?.(++handled);
    const parts = await promptParts(db, repo, n, wait);
    if (!parts) { await failTurn(db, repo, n, claim, "the conversation has no item block; send the message again"); return; }
    if (!checkouts.has(repo)) checkouts.set(repo, p.checkout(repo).catch(() => null));
    const checkout = await checkouts.get(repo)!;
    let recent: string[] = [];
    const shown = coalesce(async (lines: string[]) => await setTurnProgress(db, repo, n, claim, lines));
    const onProgress = async (line: string) => {
      if (recent.at(-1) === line) return;
      recent = [...recent, line].slice(-PROGRESS_KEEP);
      await shown.push(recent);
    };
    const bound = await openDecision(db, repo, n), stampThen = bound ? await decisionStamp(db, bound) : null;
    const dir = referenceDir(repo);
    const semantic = dir ? p.semantic ?? defaultSemanticDeps(db, `${repo}#${n}`) : undefined;
    const r = await runModelStep(db, CONVERSATION, { ref: `${repo}#${n}`, item: parts.item, turns: parts.turns, ...(checkout && { repo_dir: REPO_PATH }) }, {
      model, checkout: checkout ?? undefined, reference: checkout ? dir : undefined, onProgress, ctx: { db, repo, n, dir, semantic },
      usage: { run: p.usageRun, agent: `conversation-${String(k).padStart(3, "0")}`, stage: "conversation", items: () => 1 },
      onReply: (reply) => { if (reply.fixTurn) p.log(`conversation: ${repo}#${n}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
    });
    await shown.flush();
    const parsed = r.ok ? r.value : null;
    if (parsed) {
      if (await storeReply(db, repo, n, claim, parsed.text, parsed.cards, parsed.notes, undefined, parts.seen, parsed.choices && parsed.decision ? { decision: parsed.decision, parsed: parsed.choices, source: "conversation", by: model, stampThen } : undefined) !== null) { answered++; await jobItem(db, repo, n, "answered a message", p.log); }
    } else {
      await failTurn(db, repo, n, claim, "Opus gave no usable reply; send the message again");
      await jobItem(db, repo, n, "no usable reply to a message", p.log);
    }
  }), poolRoom(db, (i) => [todo[i]!.repo], (i) => [todo[i]!], { promptId: CONVERSATION_PROMPT.id }), { first: true });
  return answered;
}

/** PR diffs from the diff cache or GitHub; null when unavailable. */
export const githubDiff = (db: Db): DiffSource => async (repo, n, head) => {
  const { cachedDiff, ghDiff } = await import("../review/diff.ts");
  const r = await cachedDiff(db, repo, n, head, ghDiff);
  return r.ok ? r.text : null;
};

/** The step's body: the item's default checkout (the workspace comes with the prompt) and diffs. Returns the answered count and the usage run id. */
export async function runConversations(db: Db, p: { limit: number; onHandled?: (n: number) => void; cancelled?: () => Promise<boolean> }, log: (line: string) => void = console.log): Promise<{ answered: number; waiting: number; usageRun: string }> {
  await sweepRunningCards(db);
  const usageRun = `conversation-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const waiting = (await pendingConversations(db)).length;
  const answered = await answerPending(db, {
    ...p, usageRun, log, diff: githubDiff(db),
    checkout: (repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo)),
  });
  log(`conversation: ${answered} of ${waiting} messages answered`);
  return { answered, waiting, usageRun };
}

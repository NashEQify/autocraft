// Referee: Sonnet decides disagreements between Jev and Haiku under the written rules.
import { jobItem } from "../runner/job-items.ts";
import { itemRepos, poolRoom, repoBatches } from "../agents/call.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { type Item } from "./parse.ts";
import { type Pair, ref } from "./report.ts";
import { loadItems, pool, replaceClassification } from "./run.ts";
import { runModelStep } from "../agents/step.ts";
import { REFEREE_SONNET } from "../agents/steps.ts";
import { rng, spread } from "./sample.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export function pickDisagreements(pairs: Pair[], count: number, seed: number): Pair[] {
  const dis = pairs.filter((p) => p.jev.type_label !== p.haiku.type_label);
  return spread(dis, (p) => `${p.r.kind}|${p.jev.type_label}`, count, rng(seed));
}

const REFEREE = CLAUDE_PROMPTS["referee.sonnet"];

export async function runReferee(db: Db, runId: string, picked: Pair[], perCall = REFEREE.limits.perCall): Promise<void> {
  await refereeItems(db, runId, await loadItems(db, picked.map((p) => p.r)), { perCall, pipeline: false });
}

type RefereeOpts = {
  perCall?: number;
  /** Pipeline results carry probs {"sure": bool}, which settled.ts reads; evaluation rows carry none and never settle an item. */
  pipeline: boolean;
  /** The model asked, when not the prompt's own (Sonnet). An Opus answer is the last word: its row is marked final, so an unsure one still settles the label and flags a scope decision. */
  model?: string;
  /** Items sent to the model so far. */
  onSent?: (n: number) => void;
  cancelled?: () => Promise<boolean>;
};

/** Sends the items to the Sonnet referee and stores one 'sonnet' row per answer in `runId`. Returns the number of answers. */
export async function refereeItems(db: Db, runId: string, items: Item[], opts: RefereeOpts): Promise<number> {
  const perCall = opts.perCall ?? REFEREE.limits.perCall;
  const chunks = await repoBatches(db, items, perCall, (i) => i.repo, (i) => [i]);
  const have = (repo: string, number: number, at: string) => db.get(db.k.selectFrom("classifications").select((eb) => eb.lit(1).as("one"))
    .where("repo", "=", repo).where("number", "=", number).where("classifier", "=", "sonnet").where("run_id", "=", runId).where("at", ">=", at));
  // Evaluation runs resume: any earlier answer in the run counts. Pipeline runs ask again, since a new answer replaces the old one.
  let total = 0, sent = 0;
  await pool(chunks.map((chunk, n) => async () => {
    if (await opts.cancelled?.()) return;
    const start = new Date().toISOString();
    let got = 0;
    // The first call asks only the items without an answer yet; a retry asks the ones still missing from the reply.
    const first = await filterSeq(chunk, async (i) => !await have(i.repo, i.number, opts.pipeline ? start : ""));
    if (first.length) {
      const r = await runModelStep(db, REFEREE_SONNET, first, {
        usage: { run: runId, agent: opts.pipeline ? `${opts.model ?? "sonnet"}-${Date.now().toString(36)}-${n}` : `sonnet-${n}`, stage: "referee", ...(opts.model && { model: opts.model }) },
        ...(opts.model && { model: opts.model }),
        onAttempt: (todo) => opts.onSent?.((sent += todo.length)),
      });
      if (r.ok) for (const verdicts of r.values) for (const v of verdicts) {
        const [repo, num] = v.ref.split("#");
        await replaceClassification(db, [repo!, Number(num), "sonnet", runId, new Date().toISOString(), v.type_label, "[]", v.why, opts.pipeline ? JSON.stringify({ sure: v.sure === true, ...(opts.model && { final: true }) }) : null]);
        got++;
        await jobItem(db, repo!, Number(num), `refereed${opts.model ? ` by ${opts.model}` : ""} as ${v.type_label}${v.sure === true ? "" : " (unsure)"}`);
      }
      // A reply arrived and left an item out (or was invalid): count the failure on Sonnet's row (rewritten, so the settled table sees it); the planner backs off, and the third failure ends the referee's turn.
      // No reply at all (no Claude account free, a failed call) and a cancelled job are not the item's failure.
      const replied = r.ok || r.error !== "no answer";
      if (opts.model && opts.pipeline && replied && !await opts.cancelled?.()) {
        const answered = new Set(r.ok ? r.values.flat().map((v) => v.ref) : []);
        for (const i of first) {
          if (answered.has(`${i.repo}#${i.number}`)) continue;
          const row = await db.get(db.k.selectFrom("classifications").select(["type_label", "reason", "probs", "at"])
            .where("repo", "=", i.repo).where("number", "=", i.number).where("classifier", "=", "sonnet").where("run_id", "=", runId));
          if (!row) continue;
          let p: Record<string, unknown> = {};
          try { p = (JSON.parse(row.probs ?? "{}") as Record<string, unknown>) ?? {}; } catch { /* keep empty */ }
          p.opusFailures = (typeof p.opusFailures === "number" ? p.opusFailures : 0) + 1;
          p.opusFailedAt = new Date().toISOString();
          await replaceClassification(db, [i.repo, i.number, "sonnet", runId, row.at, row.type_label, "[]", row.reason, JSON.stringify(p)]);
        }
      }
    }
    total += got;
  }), poolRoom(db, (i) => itemRepos(chunks[i]!), (i) => chunks[i]!, { promptId: REFEREE.id }), { first: true });
  return total;
}

/** Marks a varied subset (by kind and by whom Sonnet sided with) for the owner to check by hand. */
export async function markSpotCheck(db: Db, runId: string, pairs: Pair[], count: number, seed: number): Promise<void> {
  const verdicts = new Map(
    (await db.all(db.k.selectFrom("classifications").select(["repo", "number", "type_label"]).where("classifier", "=", "sonnet").where("run_id", "=", runId)))
      .map((r) => [ref(r), r.type_label ?? ""]),
  );
  const refereed = pairs.filter((p) => verdicts.has(ref(p.r)));
  const side = (p: Pair) => { const v = verdicts.get(ref(p.r)); return v === p.jev.type_label ? "jev" : v === p.haiku.type_label ? "haiku" : "neither"; };
  await db.run(db.k.updateTable("main.classifications").set({ flags: "[]" }).where("classifier", "=", "sonnet").where("run_id", "=", runId));
  for (const p of spread(refereed, (p) => `${p.r.kind}|${side(p)}`, count, rng(seed + 1))) {
    await db.run(db.k.updateTable("main.classifications").set({ flags: '["spot-check"]' }).where("classifier", "=", "sonnet").where("run_id", "=", runId).where("repo", "=", p.r.repo).where("number", "=", p.r.number));
  }
}

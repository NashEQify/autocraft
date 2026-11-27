// The hourly self-evaluation (step `eval`): the detectors over the records, the causes they update, one Opus investigation
// per new or grown cause on a Task Runner with a read-only checkout of the eval repo, then the filing on that repo.
// Nothing here implements a fix: the issues wait for a maintainer's command like any other issue.
import { createHash } from "node:crypto";
import { isHalt, poolRoom } from "../agents/call.ts";
import { runModelStep } from "../agents/step.ts";
import { EVAL_INVESTIGATE } from "../agents/steps.ts";
import { pool } from "../classify/run.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import type { By } from "../core/gates.ts";
import type { Db } from "../db/index.ts";
import { loadEvalCauses, loadEvalFacts, saveEvalCauses, type EvalCause } from "../data/eval/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { mergeGroup, wantsInvestigation } from "./causes.ts";
import { DETECTOR_RULES, detect, HOUR, type Detector, type HealthCheck } from "./detect.ts";
import { evalRepo } from "./schedule.ts";
import { runEvalFiling, type FileDeps, type FileSummary } from "./file.ts";
import { EVAL_INPUT_EVIDENCE, type EvalFinding, type EvalInput } from "./prompt.ts";

const PROMPT = CLAUDE_PROMPTS["eval.investigate"];

export type EvalParams = { repo: string; by: By; onHandled?: (n: number) => void; stopping?: () => Promise<boolean> };
export type EvalDeps = {
  now: () => number;
  checks: (db: Db, nowMs: number) => Promise<HealthCheck[]>;
  runnerFreshMs: number;
  /** A read-only checkout of the repo's default branch head, or null. */
  checkout: (db: Db, repo: string) => Promise<string | null>;
  /** The investigation call; absent: the real model call. */
  ask?: (input: EvalInput) => Promise<{ value: EvalFinding; model: string } | null>;
  file?: FileDeps;
};
export type EvalSummary = { runId: string; groups: number; added: number; investigated: number; defects: number; waiting: number; filing: FileSummary | null; note: string | null };

export async function defaultEvalDeps(): Promise<EvalDeps> {
  const { STATUS_FRESH_MS } = await import("../remote/helpers.ts");
  return {
    now: Date.now, runnerFreshMs: STATUS_FRESH_MS,
    checks: async (db, nowMs) => {
      const { computeChecks } = await import("../health-checks.ts");
      return (await computeChecks(db, nowMs, true)).map((c) => ({ id: c.group ?? c.id, state: c.state, brief: c.text, since: c.since }));
    },
    checkout: async (db, repo) => {
      const branch = (await loadRepos(db, { names: [repo], all: true })).get(repo)?.default_branch ?? "main";
      const { mainHeadOf } = await import("../github/fork.ts");
      const sha = await mainHeadOf(repo, branch);
      return sha ? checkoutForCommit(repo, branch, sha, console.log) : null;
    },
  };
}

/** Private repository names replaced by stable aliases (`private-repo-1`), so neither the prompt nor the reply carries them. */
function masker(repos: Map<string, { visibility: string | null }>): { repo: (r: string) => string; text: (t: string) => string } {
  const priv = [...repos].filter(([, r]) => r.visibility !== "public").map(([n]) => n).sort();
  const alias = new Map(priv.map((n, i) => [n, `private-repo-${i + 1}`]));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = priv.length ? new RegExp(`(?<![A-Za-z0-9._-])(?:[A-Za-z0-9-]+/)?(${[...priv].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
  return { repo: (r) => alias.get(r) ?? r, text: (t) => (re ? t.replace(re, (_m, n: string) => alias.get(n) ?? n) : t) };
}

function inputOf(c: EvalCause, mask: ReturnType<typeof masker>, repoDir: string | undefined): EvalInput {
  const earlier = c.verdict === "defect" || c.verdict === "not-defect" ? { verdict: c.verdict, cause: String((c.finding as { cause?: unknown } | null)?.cause ?? "") } : null;
  return {
    key: c.key, detector: c.detector, rule: DETECTOR_RULES[c.detector as Detector] ?? "", summary: c.summary, first_seen: c.firstSeen, last_seen: c.lastSeen, seen: c.seen,
    evidence: c.evidence.slice(0, EVAL_INPUT_EVIDENCE).map((e) => ({ id: mask.text(e.id), at: e.at, note: mask.text(e.note), ...(e.ref && { ref: `${mask.repo(e.ref.repo)}#${e.ref.number}` }) })),
    earlier, ...(repoDir && { repo_dir: repoDir }),
  };
}

/** One evaluation: detect, store, investigate what is new or grew, file. */
export async function runEval(db: Db, p: EvalParams, log: (l: string) => void = console.log, deps?: EvalDeps): Promise<EvalSummary> {
  const d = deps ?? await defaultEvalDeps();
  const nowMs = d.now(), nowIso = new Date(nowMs).toISOString();
  const runId = `eval-${nowIso.replace(/[-:]/g, "").slice(0, 15)}`;
  const s: EvalSummary = { runId, groups: 0, added: 0, investigated: 0, defects: 0, waiting: 0, filing: null, note: null };
  if (await evalRepo(db) !== p.repo) { s.note = `${p.repo} is not the eval repo`; log(`eval: ${s.note}; nothing done`); return s; }

  const [facts, checks] = await Promise.all([
    loadEvalFacts(db, { sinceMs: nowMs - 24 * HOUR, mergedSinceMs: nowMs - 7 * 24 * HOUR }),
    d.checks(db, nowMs).catch((e: unknown) => { log(`eval: health checks not read: ${String((e as Error).message ?? e).slice(0, 200)}`); return [] as HealthCheck[]; }),
  ]);
  const groups = detect({ facts, checks, nowMs, runnerFreshMs: d.runnerFreshMs });
  s.groups = groups.length;
  const stored = await loadEvalCauses(db, groups.map((g) => g.key));
  const merged = groups.map((g) => { const m = mergeGroup(stored.get(g.key), g, nowIso); s.added += m.added; return m.cause; });
  await saveEvalCauses(db, merged);
  for (const c of merged) log(`  ${c.key}: ${c.evidence.length} kept, ${c.seen} seen, ${c.state}${c.issueNumber ? ` (issue ${c.issueNumber})` : ""}`);

  const due = merged.filter((c) => wantsInvestigation(c, nowMs));
  if (due.length) {
    const dir = d.ask ? undefined : await d.checkout(db, p.repo);
    if (!d.ask && !dir) {
      s.waiting = due.length;
      log(`eval: no checkout of ${p.repo}; ${due.length} investigations wait for the next run`);
    } else {
      const mask = masker(await loadRepos(db, { all: true }));
      let handled = 0;
      await pool(due.map((c) => async () => {
        if (await p.stopping?.()) { s.waiting++; return; }
        const input = inputOf(c, mask, dir ? REPO_PATH : undefined);
        let got: { value: EvalFinding; model: string } | null;
        try {
          if (d.ask) got = await d.ask(input);
          else {
            const r = await runModelStep(db, EVAL_INVESTIGATE, input, {
              model: PROMPT.models[0]!, checkout: dir!,
              usage: { run: runId, agent: `eval-${createHash("sha1").update(c.key).digest("hex").slice(0, 10)}`, stage: "eval", items: (ok) => (ok ? 1 : 0) },
              onReply: (reply) => { if (reply.fixTurn) log(`  ${c.key}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
            });
            got = r.ok ? { value: r.value, model: r.model || PROMPT.models[0]! } : null;
          }
        } catch (e) {
          if (!isHalt(e)) throw e;
          s.waiting++;
          log(`  ${c.key}: no Task Runner took the investigation; it waits for the next run`);
          return;
        }
        p.onHandled?.(++handled);
        s.investigated++;
        const was = (await loadEvalCauses(db, [c.key])).get(c.key) ?? c;
        const next: EvalCause = got
          ? { ...was, investigatedAt: nowIso, investigatedSeen: c.seen, verdict: got.value.real_defect ? "defect" : "not-defect", finding: got.value, model: got.model, runId, state: was.state === "new" ? "investigated" : was.state }
          : { ...was, investigatedAt: nowIso, verdict: "failed", runId, state: was.state === "new" ? "investigated" : was.state };
        if (got?.value.real_defect) s.defects++;
        await saveEvalCauses(db, [next]);
        log(`  ${c.key}: ${got ? (got.value.real_defect ? `real defect (${got.value.severity})` : "not a defect") : "no valid investigation"}`);
      }), d.ask ? due.length : poolRoom(db, () => [p.repo], () => []), { skipped: () => { s.waiting++; } });
    }
  }

  s.filing = await runEvalFiling(db, { repo: p.repo, by: p.by }, log, d.file);
  log(`eval ${p.repo}: ${s.groups} candidate groups, ${s.added} new pieces of evidence, ${s.investigated} investigated (${s.defects} defects), ${s.waiting} waiting`);
  return s;
}

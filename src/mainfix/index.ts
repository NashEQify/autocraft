// Red default branch: for a repo with the "Fix red main" approval whose current head is red, each failed gate check is
// read (the CI fix reader) and sorted by Haiku, without tools:
//   flaky  a timeout, a network error, a cancelled job or a lost runner: the failed jobs are rerun once per head. Red again
//          at the same head counts as code.
//   infra  a refused request from a service, a missing secret, a quota or an outage: nothing here can fix it. One issue per
//          (repo, check, red head) is opened under the repo's approval, with the check, the run link and a scrubbed log excerpt.
//   code   a compile, test, lint or format failure: recorded as needs-fix for the fix PR step (`onCodeVerdict`).
// The log is untrusted text: it only reaches a model that has no tools, and what is stored or posted is scrubbed.
//
//   autocraft-server main-fix --repo R [--apply]
//   autocraft-server main-fix-approval [--repo R]
import { leaseItem } from "../runner/leases.ts";
import { loadMainFixes, loadMainFixDue, saveMainFixes, type MainFixRow } from "../data/changes/index.ts";
import { loadTrackedRepos, loadStepApprovals } from "../data/control/index.ts";
import { loadMainCiAt } from "../data/mirror/index.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guardRepo } from "../core/guard.ts";
import { exec, fixupDir, type Exec } from "../fixup/git.ts";
import { createIssue, ghRerunMainFailed, IssueError, type Writer } from "../github/write.ts";
import { askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { readFailure } from "../cifix/logs.ts";
import { optionalChecks } from "../optional-checks.ts";
import type { CiFailure } from "../cifix/types.ts";
import { mainCiRepos } from "../mainci/index.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cleanLine } from "../review/post-template.ts";
import { scrub } from "../runner/scrub.ts";
import { mainFixApprovalOf } from "./approval.ts";
import { lintReadyIn, openFixPrs, type FixPrDeps } from "./pr.ts";
import { REASON_WORDS, VERDICTS, type MainFixInput, type MainFixVerdict } from "./types.ts";
import { slugOf } from "../owners.ts";
import { wholeReplyJson } from "../core/reply-json.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

export { mainFixApprovalOf, setMainFixApproval } from "./approval.ts";
export { autocraftText } from "./status.ts";

export const ACTOR = "main-fix";
const PROMPT = CLAUDE_PROMPTS["mainfix.classify"];
const PATCH = CLAUDE_PROMPTS["cifix.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
/** The model named in the note of an issue opened for an infrastructure failure: it wrote the reason. */
const NOTE_MODEL = "haiku";
/** After a rerun the head may stay red this long without a new reading before the rerun counts as failed. */
const RERUN_WAIT_MS = 10 * 60_000;
const EXCERPT_CHARS = 1500;

export type Verdict = { check: string; verdict: MainFixVerdict; reason: string };
export type MainFixDeps = {
  gh: Gh;
  exec: Exec;
  /** Sorts the failed checks of one head; null when the model gave no usable answer. */
  classify: (db: Db, input: MainFixInput) => Promise<Verdict[] | null>;
  now: () => Date;
  /** What the fix PR step needs; without it no fix PR is made. */
  fix?: FixPrDeps;
};

export type FixRow = MainFixRow;

/** `asked` is always 0: infrastructure failures open their issue without a question. */
export type MainFixSummary = { repo: string; classified: number; reran: number; asked: number; needsFix: number; issues: number; prs: number; note: string | null };

const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const words = (s: string): string => s.replace(/\s+/g, " ").trim().split(" ").slice(0, REASON_WORDS).join(" ");
/** URLs and mentions out of text that goes into a public issue or a decision. */
const plain = (s: string): string => scrub(s).replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"')]*/gi, "<url>").replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1");

export function defaultDeps(): MainFixDeps {
  return {
    gh: ghExec, exec, now: () => new Date(),
    fix: {
      root: fixupDir(),
      ask: async (db, input, checkout, tool) => (await askClaude("cifix.patch", PATCH.models[0]!, input, db, { checkout, check: tool }))?.text ?? null,
      check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
      checkout: (repo, branch, sha) => checkoutForCommit(repo, branch, sha, console.log),
    },
    classify: async (db, input) => {
      const model = PROMPT.models[0]!;
      const start = new Date().toISOString();
      const reply = await askClaude("mainfix.classify", model, [input], db);
      const usage = reply?.usage ?? ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as Usage);
      await saveUsage(db, `main-fix-${start.replace(/[-:]/g, "").slice(0, 15)}`, "main-fix", "main-fix", model, reply ? 1 : 0, usage, start, new Date().toISOString());
      return reply ? parseVerdicts(reply.text, input.checks.map((c) => c.check)) : null;
    },
  };
}

/** The checks of a reply; a check the reply leaves out or sorts into no known kind is code. Null when the reply holds no JSON object with a checks array. */
export function parseVerdicts(text: string, checks: string[]): Verdict[] | null {
  const parsed = wholeReplyJson(text) as { checks?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.checks)) return null;
  const given = new Map<string, { verdict?: unknown; reason?: unknown }>();
  for (const c of parsed.checks as { check?: unknown; verdict?: unknown; reason?: unknown }[]) if (c && typeof c.check === "string") given.set(c.check, c);
  return checks.map((check) => {
    const g = given.get(check);
    const verdict = VERDICTS.find((v) => v === g?.verdict);
    return { check, verdict: verdict ?? "code", reason: words(plain(typeof g?.reason === "string" ? g.reason : "")) || (verdict ? "" : "no clear verdict") };
  });
}

// ---- rows ---------------------------------------------------------------------

const rowsAt = async (db: Db, repo: string, head: string): Promise<FixRow[]> => await loadMainFixes(db, { heads: [{ repo, headSha: head }] });

async function save(db: Db, row: FixRow, at: string): Promise<void> {
  await saveMainFixes(db, [row], at);
}

const setState = async (db: Db, r: FixRow, state: string, reason: string | null, at: string, extra: Partial<FixRow> = {}): Promise<FixRow> => {
  const next = { ...r, ...extra, state, reason };
  await save(db, next, at);
  return next;
};

/**
 * Where a code verdict goes. The row records `needs-fix`; the fix PR step takes its rows from here (state needs-fix, verdict code).
 */
export async function onCodeVerdict(db: Db, row: FixRow, why: string, at: string): Promise<FixRow> {
  return await setState(db, { ...row, verdict: "code" }, "needs-fix", oneLine(why), at);
}

// ---- the red head ---------------------------------------------------------------

type Current = { headSha: string; branch: string; state: string; culprit: string; culpritPr: number | null; redSince: string; stateChangedAt: string };

async function currentOf(db: Db, repo: string): Promise<Current | null> {
  const r = (await mainCiRepos(db)).find((x) => x.repo === repo);
  if (!r) return null;
  const changed = (await loadMainCiAt(db, [{ repo, sha: r.headSha }])).get(`${repo}@${r.headSha}`);
  const stateChangedAt = changed?.state_changed_at ?? "";
  return { headSha: r.headSha, branch: r.branch, state: r.state, culprit: r.culprit?.sha ?? r.headSha, culpritPr: r.culprit?.pr ?? null, redSince: r.redSince ?? stateChangedAt, stateChangedAt };
}

/** Whether a run of the step has something to do for the repo. */
export async function mainFixDue(db: Db, repo: string): Promise<boolean> {
  if (!await mainFixApprovalOf(db, repo)) return false;
  const cur = await currentOf(db, repo);
  if (!cur) return false;
  const running = cur.state === "running";
  const due = (await loadMainFixDue(db, [{ repo, headSha: cur.headSha, running }])).get(`${repo}@${cur.headSha}`)!;
  // A stored patch is collected once its lint task ended, or closed when its head is no longer the current one.
  if (!running && await lintReadyIn(db, due.lintingHeads, cur.headSha)) return true;
  if (cur.state === "red") return due.rows.length === 0 || due.rows.some((r) => r.state === "rerun-requested" || r.state === "needs-fix");
  // A row left at needs-fix by an older head is closed by the next run.
  return due.rows.some((r) => r.state === "rerun-requested") || due.staleNeedsFix;
}

const issueTitle = (check: string): string => `Main CI fails: ${cleanLine(check, 100)}`;

/** The issue's text. Fixed layout; the check name, reason and log excerpt are scrubbed, without URLs or mentions. */
export function issueBody(r: Pick<FixRow, "repo" | "headSha" | "check" | "reason" | "runId" | "excerpt">): string {
  const run = r.runId ? `\nRun: https://github.com/${slugOf(r.repo)}/actions/runs/${r.runId}` : "";
  const log = (r.excerpt ?? "").replace(/```/g, "'''").trim();
  return `The CI of the default branch fails at ${r.headSha.slice(0, 8)}.\n\nFailing check: \`${cleanLine(r.check, 100).replace(/`/g, "'")}\`${run}\n\nThe log reads as a failure outside the code (a refused request, a missing secret, a quota or an outage)${r.reason ? `: ${r.reason}` : "."}${log ? `\n\nLog excerpt:\n\n\`\`\`\n${log}\n\`\`\`` : ""}`;
}

const excerptOf = (c: CiFailure["checks"][number]): string => {
  const text = plain(c.steps.map((s) => s.tail).join("\n")).split("\n").filter((l) => l.trim()).join("\n");
  return text.length > EXCERPT_CHARS ? text.slice(-EXCERPT_CHARS) : text;
};

const inputOf = (repo: string, f: CiFailure): MainFixInput => ({
  ref: `${repo}@${f.head.slice(0, 8)}`,
  checks: f.checks.map((c) => ({ check: c.name, conclusion: c.conclusion, steps: c.steps.map((s) => ({ job: s.job, step: s.step, log: scrub(s.tail) })) })),
});

async function classifyHead(db: Db, repo: string, cur: Current, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, by: By = CLI_BY): Promise<boolean> {
  const at = deps.now().toISOString();
  const reading = await readFailure(deps.gh, repo, cur.headSha, await optionalChecks(db, repo));
  const base = { repo, headSha: cur.headSha, runId: null, runUrl: null, excerpt: null, issueNumber: null, prNumber: null, prUrl: null, patch: null, files: null, lintTask: null, lintRound: null, lintState: null, session: null, createdAt: at } as const;
  if (reading.kind === "skip") {
    await save(db, { ...base, check: "(none)", verdict: "code", state: "nothing-to-do", reason: oneLine(reading.why), updatedAt: at }, at);
    log(`  ${repo}: nothing to do: ${reading.why}`);
    return false;
  }
  const failure = reading.failure;
  const verdicts = await deps.classify(db, inputOf(repo, failure));
  if (!verdicts) { log(`  ${repo}: no usable classification; tried again at the next run`); return false; }
  s.classified++;
  const rerunRuns = new Map<number, FixRow[]>();
  for (const c of failure.checks) {
    const v = verdicts.find((x) => x.check === c.name) ?? { check: c.name, verdict: "code" as const, reason: "no verdict" };
    const row: FixRow = {
      ...base, check: c.name, verdict: v.verdict, state: "nothing-to-do", reason: v.reason || null, runId: c.runId,
      runUrl: c.runId ? `https://github.com/${slugOf(repo)}/actions/runs/${c.runId}` : null, excerpt: excerptOf(c) || null, updatedAt: at,
    };
    if (v.verdict === "code") { await onCodeVerdict(db, row, v.reason || "a build, lint or test step failed", at); s.needsFix++; continue; }
    if (v.verdict === "infra") { await openInfraIssue(db, row, deps, log, s, by, at); continue; }
    // flaky
    if (row.runId === null) { await setState(db, row, "nothing-to-do", "no Actions run to rerun", at); continue; }
    // Recorded before the calls: one rerun per head, even if the process dies in the middle of them.
    const saved = await setState(db, row, "rerun-requested", row.reason, at);
    (rerunRuns.get(row.runId) ?? rerunRuns.set(row.runId, []).get(row.runId)!).push(saved);
  }
  const w: Writer = { db, login: ACTOR };
  for (const [runId, rows] of rerunRuns) {
    const g = await guardRepo(db, repo, "main-fix", by);
    const res = "refused" in g ? { code: 1, stdout: "", stderr: g.refused } : await ghRerunMainFailed(w, g, deps.exec, { repo, head: cur.headSha, runId }, { checks: rows.map((r) => r.check) });
    if (res.code !== 0) for (const r of rows) await setState(db, r, "nothing-to-do", `GitHub refused the rerun: ${oneLine(res.stderr || res.stdout, 120)}`, deps.now().toISOString());
    else { s.reran++; log(`  ${repo}: reran the failed jobs of run ${runId}`); }
  }
  return true;
}

/** One issue for an infrastructure failure; a refused or failed write ends in `issue-failed` (an outcome GitHub never confirmed may have left an issue, so it is not retried). */
async function openInfraIssue(db: Db, row: FixRow, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, by: By, at: string): Promise<void> {
  try {
    const g = await guardRepo(db, row.repo, "main-fix", by);
    if ("refused" in g) { await setState(db, row, "issue-failed", oneLine(g.refused, 100), at); log(`  ${row.repo}: issue for ${row.check} not opened: ${g.refused}`); return; }
    const made = await createIssue({ db, login: ACTOR }, g, deps.exec, { repo: row.repo, target: `${row.repo}:${row.headSha.slice(0, 8)}`, title: issueTitle(row.check), body: issueBody(row) }, { by: "model", kind: "issue", model: NOTE_MODEL });
    await setState(db, row, "issue-opened", row.reason, at, { issueNumber: made.number });
    s.issues++;
    log(`  ${row.repo}: opened ${made.url}`);
  } catch (e) {
    const why = oneLine(String((e as Error).message ?? e));
    await setState(db, row, "issue-failed", `issue not opened${e instanceof IssueError && e.clear ? "" : " (outcome unknown)"}: ${why}`.slice(0, 200), at);
    log(`  ${row.repo}: issue for ${row.check} not opened: ${why}`);
  }
}

/** Rows waiting on a rerun: green is a pass; red again after a new reading, or after the wait, is a code failure. */
async function settleReruns(db: Db, repo: string, cur: Current, deps: MainFixDeps, s: MainFixSummary): Promise<void> {
  const at = deps.now().toISOString();
  for (const r of (await rowsAt(db, repo, cur.headSha)).filter((x) => x.state === "rerun-requested")) {
    if (cur.state === "green" || cur.state === "optional") { await setState(db, r, "rerun-passed", r.reason, at); continue; }
    if (cur.state !== "red") continue;
    const changedSince = cur.stateChangedAt > r.updatedAt;
    if (changedSince || deps.now().getTime() - Date.parse(r.updatedAt) > RERUN_WAIT_MS) { await onCodeVerdict(db, r, "red again after a rerun", at); s.needsFix++; }
  }
}

/** One repo: nothing without the approval; then answers, rerun results and, for a red head with no rows, the reading and sorting. */
export async function runMainFix(db: Db, params: { repo: string; onHandled?: (n: number) => void; stopping?: () => Promise<boolean>; by?: By }, log: (line: string) => void = console.log, deps: MainFixDeps = defaultDeps()): Promise<MainFixSummary> {
  const { repo } = params;
  const s: MainFixSummary = { repo, classified: 0, reran: 0, asked: 0, needsFix: 0, issues: 0, prs: 0, note: null };
  if (!await mainFixApprovalOf(db, repo)) {
    s.note = `fixing a red main in ${repo} is not approved`;
    log(`main-fix ${repo}: ${s.note}; nothing done`);
    return s;
  }
  let handled = 0;
  const bump = (): void => params.onHandled?.(++handled);
  const cur = await currentOf(db, repo);
  if (!cur) return s;
  await settleReruns(db, repo, cur, deps, s);
  if (cur.state === "red" && (await rowsAt(db, repo, cur.headSha)).length === 0 && !await params.stopping?.()) {
    const release = await leaseItem(db, `head:${repo}@${cur.headSha}`, log);
    // Another job may have classified the head before the lease was taken.
    if (release) {
      try {
        if ((await rowsAt(db, repo, cur.headSha)).length === 0) {
          bump();
          await classifyHead(db, repo, cur, deps, log, s, params.by ?? CLI_BY);
        }
      } finally { await release(); }
    }
  }
  if (deps.fix) {
    const asHead = (c: Current | null) => (c ? { headSha: c.headSha, branch: c.branch, state: c.state, redSince: c.redSince, culprit: c.culprit, culpritPr: c.culpritPr } : null);
    const r = await openFixPrs({ db, repo, gh: deps.gh, exec: deps.exec, fix: deps.fix, now: deps.now, log, by: params.by, ...(params.stopping && { stopping: params.stopping }), setState: async (r, state, reason, at, extra) => await setState(db, r, state, reason, at, extra), current: async () => asHead(await currentOf(db, repo)) }, bump);
    s.prs = r.opened;
  }
  log(`main-fix ${repo}: classified ${s.classified}, reran ${s.reran}, needs fix ${s.needsFix}, issues ${s.issues}, fix PRs ${s.prs}`);
  return s;
}

export const commands = {
  "main-fix": {
    summary: "main-fix --repo R [--apply]: sort the failed checks of a red default branch and rerun, ask or record; without --apply, lists the stored rows. Needs the repo's Fix red main approval",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      if (i < 0 || !args[i + 1]) throw new Error("usage: main-fix --repo R [--apply]");
      const repo = args[i + 1]!;
      const db = await openDb();
      if (args.includes("--apply")) { await runMainFix(db, { repo }); return; }
      const states = ["needs-fix", "linting", "pr-opened", "fix-failed", "rerun-requested", "rerun-passed", "issue-opened", "issue-failed", "declined", "nothing-to-do"];
      for (const r of (await loadMainFixes(db, { repo, states })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 50))
        console.log(`${r.headSha.slice(0, 8)}\t${r.check}\t${r.verdict}\t${r.state}\t${r.reason ?? ""}`);
    },
  },
  "main-fix-approval": {
    summary: "main-fix-approval [--repo R]: which repos the operator approved for acting on a red default branch",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const db = await openDb();
      const repos = i >= 0 ? [args[i + 1]!] : [...(await loadTrackedRepos(db)).keys()].sort();
      const approvals = await loadStepApprovals(db, repos, ["mainfix"]);
      for (const r of repos) {
        const a = approvals.get(r)?.mainfix;
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};

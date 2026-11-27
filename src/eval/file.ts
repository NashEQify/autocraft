// Filing the self-evaluation's causes on the eval repo: one issue per cause the investigation found a real defect, a comment
// with the new evidence at most once a day while it is open, a new issue when a cause comes back after its issue was closed
// as completed, and nothing more once it was closed as not planned or a duplicate. Writes only through src/github/write.ts.
//
// A cause is `filing` before the create and `filed` after it. A create that sent nothing puts it back; one whose outcome is
// unknown stays `filing` until its audit row settles it (settleStuck).
import { HELD_STUCK_MS } from "../conversations/held.ts";
import type { By } from "../core/gates.ts";
import { guardRepo, type GuardedRepo } from "../core/guard.ts";
import { exec as realExec, type Exec } from "../fixup/git.ts";
import { createIssue, ensureLabel, ghComment, IssueError, unclearWrite, type Writer } from "../github/write.ts";
import type { Db } from "../db/index.ts";
import { listAudit } from "../data/control/index.ts";
import { claimEvalFiling, loadEvalCauses, saveEvalCauses, type EvalCause } from "../data/eval/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { REINVESTIGATE_MS } from "./causes.ts";
import { findingOf } from "./prompt.ts";
import { EVAL_LABEL, evalComment, evalIssueBody, evalIssueTitle } from "./template.ts";

export const ACTOR = "eval";
/** Failed creates of one cause before it is left for an operator. */
export const FILE_MAX_ATTEMPTS = 3;

export type FileDeps = { exec: Exec; now: () => Date };
export type FileSummary = { filed: number[]; commented: number[]; declined: number; failed: string[]; unknown: string[]; note: string | null; later?: string };

export const defaultFileDeps = (): FileDeps => ({ exec: realExec, now: () => new Date() });
const target = (repo: string): string => `${repo}:eval`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
const previousOf = (note: string | null): number | null => { const m = /^previous:(\d+)$/.exec(note ?? ""); return m ? Number(m[1]) : null; };

/** Settles causes a stopped process left in `filing` from their audit rows: filed, back to be filed, or left with a note while unknown. */
async function settleStuck(db: Db, repo: string, causes: EvalCause[], now: Date, log: (l: string) => void): Promise<EvalCause[]> {
  const stuck = causes.filter((c) => c.state === "filing");
  if (!stuck.length) return [];
  const rows = await listAudit(db, { actions: ["eval-issue"], targets: [target(repo)], since: new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString(), order: "desc" });
  const out: EvalCause[] = [];
  for (const c of stuck) {
    const mine = rows.filter((a) => a.details?.cause === c.key);
    const done = mine.find((a) => a.details?.state === "done" && /\/issues\/\d+$/.test(String(a.details.url ?? "")));
    if (done) {
      out.push({ ...c, state: "filed", issueNumber: Number(/\/issues\/(\d+)$/.exec(String(done.details!.url))![1]), filedAt: done.at, reportedSeen: c.seen, note: null });
      log(`  ${c.key}: was filed as issue ${out[out.length - 1]!.issueNumber}`);
    } else if (!mine.some((a) => unclearWrite(a.details)) && (mine.length || now.getTime() - Date.parse(c.filedAt ?? c.lastSeen) >= HELD_STUCK_MS)) {
      out.push({ ...c, state: "investigated", filedAt: null });
      log(`  ${c.key}: a stopped filing sent nothing`);
    } else if (c.note !== "outcome unknown; check GitHub") out.push({ ...c, note: "outcome unknown; check GitHub" });
  }
  return out;
}

/** Files, comments and declines on the eval repo `repo` for every stored cause that is due. */
export async function runEvalFiling(db: Db, o: { repo: string; by: By }, log: (l: string) => void = console.log, deps: FileDeps = defaultFileDeps()): Promise<FileSummary> {
  const s: FileSummary = { filed: [], commented: [], declined: 0, failed: [], unknown: [], note: null };
  const g = await guardRepo(db, o.repo, null, o.by);
  if ("refused" in g) { s.note = g.refused; log(`eval filing: ${s.note}; nothing posted`); return s; }
  const now = deps.now(), nowIso = now.toISOString();
  let causes = [...(await loadEvalCauses(db)).values()];
  const settled = await settleStuck(db, o.repo, causes, now, log);
  if (settled.length) { await saveEvalCauses(db, settled); causes = [...(await loadEvalCauses(db)).values()]; }
  const repos = await loadRepos(db, { all: true });
  const isPublic = (r: string): boolean => repos.get(r)?.visibility === "public";
  const w: Writer = { db, login: ACTOR };

  // Issues filed before: closed ones end or reopen the cause, open ones get the new evidence once a day.
  const filed = causes.filter((c) => c.state === "filed" && c.issueNumber !== null);
  const issues = await loadItems(db, filed.map((c) => ({ repo: o.repo, number: c.issueNumber! })), "full");
  for (const c of filed) {
    const it = issues.get(`${o.repo}#${c.issueNumber}`);
    if (it && it.state !== "OPEN") {
      if (it.state_reason === "NOT_PLANNED" || it.state_reason === "DUPLICATE") {
        await saveEvalCauses(db, [{ ...c, state: "declined" }]);
        s.declined++;
      } else if (it.closed_at && c.evidence.some((e) => e.at > it.closed_at!)) {
        await saveEvalCauses(db, [{ ...c, state: "investigated", issueNumber: null, filedAt: null, commentedAt: null, reportedSeen: 0, attempts: 0, note: `previous:${c.issueNumber}` }]);
      }
      continue;
    }
    const last = c.commentedAt ?? c.filedAt;
    if (c.seen <= c.reportedSeen || (last && now.getTime() - Date.parse(last) < REINVESTIGATE_MS)) continue;
    try {
      const r = await ghComment(w, g, deps.exec, "eval-comment", { repo: o.repo, number: c.issueNumber!, pr: false }, { by: "fixed" }, evalComment(c, isPublic), { cause: c.key });
      if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
      await saveEvalCauses(db, [{ ...c, commentedAt: nowIso, reportedSeen: c.seen }]);
      s.commented.push(c.issueNumber!);
      log(`  ${c.key}: new evidence added to issue ${c.issueNumber}`);
    } catch (e) {
      s.failed.push(c.key);
      log(`  ${c.key}: comment on issue ${c.issueNumber} failed: ${oneLine(e)}`);
    }
  }

  // New issues.
  const due = (await loadEvalCauses(db)).values();
  let labelled = false;
  for (const c of due) {
    if (c.state !== "investigated" || c.verdict !== "defect" || c.issueNumber !== null || c.attempts >= FILE_MAX_ATTEMPTS) continue;
    const f = findingOf(c.finding);
    if (!f) continue;
    const r = await fileOne(db, w, g, deps, o.repo, c, f, isPublic, nowIso, labelled, log);
    labelled ||= r.labelled;
    if (r.kind === "filed") s.filed.push(r.issue);
    else if (r.kind === "failed") s.failed.push(c.key);
    else if (r.kind === "unknown") { s.unknown.push(c.key); break; }
    else if (r.kind === "later") { s.later = r.reason; break; }
  }
  log(`eval filing on ${o.repo}: ${s.filed.length} filed, ${s.commented.length} comments, ${s.declined} declined, ${s.failed.length} failed, ${s.unknown.length} unknown`);
  return s;
}

type One = { labelled: boolean } & ({ kind: "filed"; issue: number } | { kind: "skipped" } | { kind: "failed" | "unknown" | "later"; reason: string });

async function fileOne(db: Db, w: Writer, g: GuardedRepo, deps: FileDeps, repo: string, c: EvalCause, f: NonNullable<ReturnType<typeof findingOf>>, isPublic: (r: string) => boolean, nowIso: string, labelled: boolean, log: (l: string) => void): Promise<One> {
  if (!labelled) {
    try { await ensureLabel(w, g, deps.exec, { repo, ...EVAL_LABEL }); } catch (e) { log(`  label ${EVAL_LABEL.name}: ${oneLine(e)}`); return { labelled: false, kind: "later", reason: `label ${EVAL_LABEL.name} could not be made: ${oneLine(e)}` }; }
  }
  const attempts = c.attempts + 1;
  if (!await claimEvalFiling(db, c.key, "investigated", attempts, nowIso)) return { labelled: true, kind: "skipped" };
  let made: { number: number; url: string };
  try {
    made = await createIssue(w, g, deps.exec, { repo, target: target(repo), title: evalIssueTitle(f), body: evalIssueBody(c, f, isPublic, previousOf(c.note)), action: "eval-issue", labels: [EVAL_LABEL.name] },
      { by: "model", kind: "issue", model: c.model }, { cause: c.key, severity: f.severity });
  } catch (e) {
    const reason = oneLine(e);
    if (e instanceof IssueError && (e.later || e.unsettled)) {
      await saveEvalCauses(db, [{ ...c, state: "investigated", filedAt: null }]);
      return { labelled: true, kind: "later", reason };
    }
    if (!(e instanceof IssueError) || !e.clear) { log(`  ${c.key}: outcome unknown, check GitHub: ${reason}`); return { labelled: true, kind: "unknown", reason }; }
    await saveEvalCauses(db, [{ ...c, state: "investigated", filedAt: null, attempts, note: reason }]);
    log(`  ${c.key}: not filed: ${reason}`);
    return { labelled: true, kind: "failed", reason };
  }
  await saveEvalCauses(db, [{ ...c, state: "filed", attempts, issueNumber: made.number, filedAt: nowIso, reportedSeen: c.seen, commentedAt: null, note: null }]);
  log(`  ${c.key}: filed ${made.url}`);
  return { labelled: true, kind: "filed", issue: made.number };
}

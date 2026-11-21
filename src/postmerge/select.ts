// Which merged PRs still need a post-merge review and which defects still need an issue, from the local tables only.
import { quietFixPrs } from "../security/quiet.ts";
import { pilotSqlFor } from "../pilot.ts";
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { Finding } from "./parse.ts";
import { RETRY_AFTER_MS } from "../core/rules.ts";
import { flatMapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

/** A review that failed with a `retry:` error is tried again after this long. */
export { RETRY_AFTER_MS };
export const SINCE_KEY = "postmerge_since";

/** `batch`: the PR landed through a merged integration batch. */
export type MergedPr = { repo: string; number: number; head_oid: string; merged_at: string; method: string | null; batch: number };

/** Re-reviews of a PR whose review ended in a `retry:` error stop after this many tries. */
export const MAX_RETRIES = 3;

const BATCH = `EXISTS (SELECT 1 FROM merge_batch_prs bp JOIN merge_batches mb ON mb.id = bp.batch_id WHERE mb.repo = m.repo AND bp.number = m.number AND mb.state = 'merged') AS batch`;

/** PRs whose Plan holds a `postmerge` action: a pipeline merge landed since the `postmerge_since` setting and no usable review is stored (a `retry:` error counts as missing an hour after it failed; the third is stored as held). Oldest merge first. */
export async function selectPostmerge(db: Db, repo: string, now = Date.now(), run?: string | null, plans?: PlanSet): Promise<MergedPr[]> {
  return (await flatMapSeq((await planned(db, "postmerge", { repo, now, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) })), async (p) => await mergedPr(db, repo, p.facts.number) ?? []))
    .sort((a, b) => (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : 0) || a.number - b.number);
}

/** The merged PR `repo#number`, whatever its review state, or null when the pipeline did not merge it. */
export async function mergedPr(db: Db, repo: string, number: number): Promise<MergedPr | null> {
  return (await db.prepare(`SELECT m.repo, m.number,
      (SELECT x.head_oid FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS head_oid,
      MIN(m.at) AS merged_at,
      (SELECT x.method FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS method,
      ${BATCH}
    FROM merges m WHERE m.repo = ? AND m.number = ? AND m.outcome = 'merged' GROUP BY m.repo, m.number`).get(repo, number) as MergedPr | undefined) ?? null;
}

export type StoredReview = { repo: string; number: number; merge_sha: string; at: string; model: string | null; error: string | null; findings: Finding[] };

export function parseStored(json: string | null): Finding[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch { return []; }
}

export async function reviewOf(db: Db, repo: string, number: number): Promise<StoredReview | null> {
  const r = await db.prepare("SELECT repo, number, merge_sha, at, model, error, findings FROM postmerge_reviews WHERE repo = ? AND number = ?").get(repo, number) as
    { repo: string; number: number; merge_sha: string; at: string; model: string | null; error: string | null; findings: string | null } | undefined;
  return r ? { ...r, findings: parseStored(r.findings) } : null;
}

export type FollowupState = "filing" | "filed" | "failed" | "skipped-duplicate" | "skipped-limit" | "skipped-minor" | "skipped-stale" | "skipped-text";
export type Followup = { repo: string; number: number; review_at: string; finding: number; title: string; issue_number: number | null; url: string | null; state: FollowupState; at: string; duplicate_of: number | null; attempts: number; note: string | null };

export async function followupsOf(db: Db, repo: string, number: number): Promise<Followup[]> {
  return await db.prepare("SELECT repo, number, review_at, finding, title, issue_number, url, state, at, duplicate_of, attempts, note FROM postmerge_followups WHERE repo = ? AND number = ? ORDER BY review_at, finding").all(repo, number) as Followup[];
}

/** A failed filing is tried again this long after its attempt (1 h after the first, 6 h after the second); three attempts at most. */
export const FAILED_BACKOFF_MS = [3600_000, 6 * 3600_000];
export const MAX_ATTEMPTS = 3;

export function retryDue(f: Pick<Followup, "state" | "attempts" | "at">, now = Date.now()): boolean {
  if (f.state !== "failed") return false;
  const wait = FAILED_BACKOFF_MS[f.attempts - 1];
  return wait !== undefined && f.attempts < MAX_ATTEMPTS && now - Date.parse(f.at) >= wait;
}

/** The PR is the Fix PR of a follow-up issue this stage filed. */
export async function fixesFollowup(db: Db, repo: string, number: number): Promise<boolean> {
  return await db.prepare(`SELECT 1 FROM fix_attempts fa JOIN postmerge_followups pf ON pf.repo = fa.repo AND pf.issue_number = fa.number
    WHERE fa.repo = ? AND fa.pr_url LIKE '%/pull/' || ?`).get(repo, String(number)) !== undefined;
}

/**
 * Why the defects of the review `reviewAt` are never filed automatically: a follow-up of an earlier review of the PR
 * exists (filed, or filing with an unknown outcome), or the PR itself fixes a follow-up issue. The operator files one
 * with `postmerge file`.
 */
export async function heldReason(db: Db, repo: string, number: number, reviewAt: string): Promise<"earlier" | "fix" | null> {
  return await heldBy(await followupsOf(db, repo, number), async () => await fixesFollowup(db, repo, number), reviewAt);
}

async function heldBy(followups: Followup[], fixes: () => Promise<boolean>, reviewAt: string): Promise<"earlier" | "fix" | null> {
  if (followups.some((x) => (x.state === "filed" || x.state === "filing") && x.review_at !== reviewAt)) return "earlier";
  return await fixes() ? "fix" : null;
}

export type PendingDefect = { repo: string; number: number; review_at: string; finding: number; f: Finding; model: string | null; attempts: number };

/**
 * Defects of the latest review of each PR that the filing step may still try, oldest review first: no row yet, a
 * skipped-limit row, or a failed row whose backoff has passed. A review held by `heldReason`, and the review of a quiet pull request, has none.
 */
export async function pendingDefects(db: Db, repo?: string, now = Date.now()): Promise<PendingDefect[]> {
  const only = repo !== undefined ? [repo] : [];
  const rows = await db.prepare(`SELECT r.repo, r.number, r.at, r.model, r.findings FROM postmerge_reviews r
    WHERE ${repo !== undefined ? "r.repo = ? AND " : ""}r.error IS NULL AND ${pilotSqlFor("r.repo", "r.number")} ORDER BY r.at, r.number`).all(...only) as { repo: string; number: number; at: string; model: string | null; findings: string | null }[];
  const out: PendingDefect[] = [];
  const quiet = await quietFixPrs(db, repo);
  // The follow-ups of each PR and the Fix PR links of follow-up issues, read once (followupsOf and fixesFollowup per PR).
  const followups = new Map<string, Followup[]>();
  for (const f of await db.prepare(`SELECT repo, number, review_at, finding, title, issue_number, url, state, at, duplicate_of, attempts, note FROM postmerge_followups
    ${repo !== undefined ? "WHERE repo = ? " : ""}ORDER BY review_at, finding`).all(...only) as Followup[]) (followups.get(`${f.repo}#${f.number}`) ?? followups.set(`${f.repo}#${f.number}`, []).get(`${f.repo}#${f.number}`)!).push(f);
  const fixUrls = await db.prepare(`SELECT fa.repo, fa.pr_url FROM fix_attempts fa JOIN postmerge_followups pf ON pf.repo = fa.repo AND pf.issue_number = fa.number
    WHERE ${repo !== undefined ? "fa.repo = ? AND " : ""}fa.pr_url IS NOT NULL`).all(...only) as { repo: string; pr_url: string }[];
  // As `pr_url LIKE '%/pull/<number>'`: LIKE ignores ASCII case.
  const fixes = (r: string, n: number): boolean => fixUrls.some((u) => u.repo === r && u.pr_url.toLowerCase().endsWith(`/pull/${n}`));
  for (const r of rows) {
    // A security fix gets no public text until its advisory is published: its findings stay on the dashboard.
    if (quiet.has(`${r.repo}#${r.number}`)) continue;
    const prFollowups = followups.get(`${r.repo}#${r.number}`) ?? [];
    if (await heldBy(prFollowups, async () => fixes(r.repo, r.number), r.at)) continue;
    const have = prFollowups.filter((x) => x.review_at === r.at);
    parseStored(r.findings).forEach((f, i) => {
      if (f.severity !== "defect" || f.duplicate_of !== null) return;
      const row = have.find((x) => x.finding === i);
      if (row && row.state !== "skipped-limit" && !retryDue(row, now)) return;
      out.push({ repo: r.repo, number: r.number, review_at: r.at, finding: i, f, model: r.model, attempts: row?.attempts ?? 0 });
    });
  }
  return out;
}

const words = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));

/** Titles that name mostly the same words, after lower-casing and dropping punctuation and short words. */
export function similarTitles(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const common = [...x].filter((w) => y.has(w)).length;
  return common / (x.size + y.size - common) >= 0.5;
}

/** The same file, lines within 20 and similar titles: the defect of one cause found in overlapping PRs. */
export const sameDefect = (a: Finding, b: Finding): boolean =>
  a.file !== null && a.file === b.file && a.line !== null && b.line !== null && Math.abs(a.line - b.line) <= 20 && similarTitles(a.title, b.title);

/** Defects this stage filed (or is filing) in the last 30 days, with the finding's file and line from the review they came from. */
export async function recentFiled(db: Db, repo: string, now = Date.now()): Promise<{ number: number; f: Finding }[]> {
  const since = new Date(now - 30 * 86400_000).toISOString();
  const rows = await db.prepare("SELECT number, review_at, finding FROM postmerge_followups WHERE repo = ? AND state IN ('filed', 'filing') AND at >= ?").all(repo, since) as { number: number; review_at: string; finding: number }[];
  return await flatMapSeq(rows, async (x) => {
    const r = await reviewOf(db, repo, x.number);
    const f = r && r.at === x.review_at ? r.findings[x.finding] : undefined;
    return f ? [{ number: x.number, f }] : [];
  });
}

/**
 * Keeps the first of each group of same defects (list order) and names, for each other, the PR number of the one kept.
 * `seed` are defects filed earlier: a pending one that repeats one of them is a duplicate too.
 */
export function dedupeDefects(list: PendingDefect[], seed: { number: number; f: Finding }[] = []): { keep: PendingDefect[]; dupes: { d: PendingDefect; of: number }[] } {
  const keep: PendingDefect[] = [], dupes: { d: PendingDefect; of: number }[] = [];
  for (const d of list) {
    const k = seed.find((x) => sameDefect(x.f, d.f)) ?? keep.find((x) => sameDefect(x.f, d.f));
    if (k) dupes.push({ d, of: k.number }); else keep.push(d);
  }
  return { keep, dupes };
}

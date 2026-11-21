// Facts: everything the review-to-merge rules read about open PRs, loaded in one pass for a whole database or a slice of it.
// Each concept has one definition here. Where a step selector and the merge queue used different
// definitions, the queue's wins; the differences are listed in the report of this change, not here.
import { refIn, refPairs } from "./ref-filter.ts";
import { pipelineWrites } from "./rules.ts";
import { quietFixPrs } from "../security/quiet.ts";
export { quietFixPrs };
import { commentApprovalOf } from "../act/approval.ts";
import { actionable } from "../decisions.ts";
import { ownLogins } from "../github/identity.ts";
import { notOwnIntegrationSql, groupHeldSql, backlogHeldSql } from "../dupes/held.ts";
import { conflictAskRetryAtOf, conflictBucketOf, type ConflictRow } from "../fixup/conflict-state.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { authorWritesOf } from "../fixup/author-permission.ts";
import { longLivedAll, pushable, sameRepo, type LongLived } from "../fixup/pushable.ts";
import { FAST_FLOOR, fastScoreSql } from "../fasttrack.ts";
import { latestRun, refereeClosed, settledSet } from "../classify/settled.ts";
import { redMainRepos, MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import { batchStates, membersOf } from "../merge/batch-store.ts";
import { changesRequestedWhy, FORMAL_STATES, gatesOf, GATE_FAILURES, failureNote, type ReviewFact } from "../merge/changes-requested.ts";
import { ciApprovalOf } from "../merge/ci-approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { mergeHolds } from "../merge/holds.ts";
import { reposWithNoCi } from "../merge/no-ci.ts";
import { effectiveCi } from "../optional-checks.ts";
import { inPilot, pilotSql, pipelineRepos } from "../pilot.ts";
import { holdMap } from "../outside.ts";
import { attemptsIn, parseFixes } from "../fixup/candidates.ts";
import { operatorTries, operatorTriesLeft, operatorWork, queuedOperatorFix } from "../preapproval/state.ts";
import { getTask, TERMINAL } from "../build/tasks.ts";
import { SINCE_KEY } from "../postmerge/select.ts";
import { verifyOverride } from "../merge/verify-override.ts";
import { unknownOf } from "../merge/mergeable.ts";
import { BASE_NAME, OPEN_GROUP_SQL, PIPELINE_LOGIN_KEY, UNSURE_AT_SQL, mergeDecisionId, holdDecisionId } from "./rules.ts";
import { getRule, STATS_SQL, tierOf, tierKey, tiersOf, type AuthorRef, type Tier } from "../whitelist.ts";
import { findingsOf, premergeFixUsedIn, premergeRows } from "../premerge/store.ts";
import { headOf } from "../review/candidates.ts";
import { parsePublic } from "../review/opus-parse.ts";
import { rereadPaceAt } from "../review/diff.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { EXTRAS_PENDING_REASON } from "./sensitive.ts";
import { CARRIED, carriedReview } from "../review/carry.ts";
import { postSourcesOf } from "../review/post-source.ts";
import { staleReviews } from "../review/discussion.ts";
import { nextUtcMidnight, reviewHolds } from "../review/gate.ts";
import { scopeAnswers, unsettledScope } from "../review/candidates.ts";
import { NOT_RUST_REASON, PRIVATE_REASON, cachedRust } from "../verify/candidates.ts";
import { CIFIX_PUSH_STATES, CIFIX_TRY_STATES, MAX_FAILURES, labelWithScopeAnswer, sizeOf, unsentAsk } from "./rules.ts";
import type { AssignFacts, PassFacts, PrFacts, PrTier } from "./plan.ts";
import { settledBySql } from "../settlers.ts";
import { activeTrips, brokeHeads } from "../push-outcomes.ts";
import { setting } from "../settings-read.ts";
import { everySeq, someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export type { PrFacts } from "./plan.ts";

export type LoadOptions = {
  repo?: string;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The GitHub App's slug, when it is not to be read from the registered app (null: none). */
  appSlug?: string | null;
  /** The classification run for labels (default: latestRun). */
  run?: string | null;
};

type Row = {
  repo: string; number: number; author: string | null; author_id: number | null; author_type: string | null; state: "OPEN" | "MERGED" | "CLOSED"; review_decision: string | null; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  additions: number | null; deletions: number | null; i_mergeable: string | null; head_repo: string | null; head_ref: string | null; base_ref: string | null; i_can: number | null;
  c_head: string | null; c_at: string | null; c_state: string | null; c_draft: number | null; overall: string | null; c_mergeable: string | null; c_can: number | null;
  r_head: string | null; r_at: string | null; r_verdict: string | null; r_sure: number | null; r_mode: string | null; r_reason: string | null; r_fixes: string | null; r_conflicts: string | null;
  /** The stored public review's summary when it has a summary and a points list ('' when not): all parsePublic() needs to tell whether it can be posted. */
  r_public: string | null;
  /** Read only when `overall` is failure, the one case effectiveCi() looks at them. */
  c_checks: string | null;
  /** The `diff_facts` row of the review's head: null columns when its diff is not cached. */
  d_reasons: string | null; d_lines: number | null; d_pending: number | null; d_last_read: number | null;
  assignees: string | null; score: number | null; in_pilot: number; not_integration: number; batch_pr: number; held_backlog: number; held_dup: number;
};

const parseList = (s: string | null): unknown[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };
const safeJson = (s: string | null): unknown => { try { return JSON.parse(s!); } catch { return null; } };

const SELECT = `SELECT i.repo, i.number, i.author, i.author_id, i.author_type, i.assignees, i.state, i.review_decision, i.head_oid, i.updated_at, i.is_draft, i.additions, i.deletions, i.mergeable AS i_mergeable,
    i.head_repo, i.head_ref, i.base_ref, i.maintainer_can_modify AS i_can,
    c.head_oid AS c_head, c.fetched_at AS c_at, c.state AS c_state, c.is_draft AS c_draft, c.overall, CASE WHEN c.overall = 'failure' THEN c.checks END AS c_checks, c.mergeable AS c_mergeable, c.maintainer_can_modify AS c_can,
    l.head_oid AS r_head, l.at AS r_at, l.verdict AS r_verdict, l.sure AS r_sure, l.mode AS r_mode, l.reason AS r_reason, l.fixes AS r_fixes, CASE WHEN l.public_review IS NULL THEN NULL WHEN json_valid(l.public_review) AND json_type(l.public_review, '$.summary') = 'text'
      AND json_type(l.public_review, '$.points') = 'array' THEN json_extract(l.public_review, '$.summary') ELSE '' END AS r_public, l.conflicts AS r_conflicts,
    df.reasons AS d_reasons, df.lines AS d_lines, df.pending AS d_pending, df.last_read AS d_last_read,
    ${fastScoreSql("i.repo", "i.number", "p.score")} AS score,
    ${pilotSql("i")} AS in_pilot, ${notOwnIntegrationSql("i")} AS not_integration,
    EXISTS (SELECT 1 FROM main.merge_batches mb WHERE mb.repo = i.repo AND mb.pr_number = i.number) AS batch_pr,
    ${backlogHeldSql("i")} AS held_backlog,
    (EXISTS (SELECT 1 FROM decisions dh WHERE dh.kind = 'duplicate' AND dh.id NOT LIKE '%:dupegroup:%' AND dh.repo = i.repo AND dh.number = i.number AND (dh.answer IS NULL OR dh.answer = 'close'))
      OR ${groupHeldSql("i")}) AS held_dup
  FROM items i
  LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
  LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
  LEFT JOIN opus_reviews l ON l.repo = i.repo AND l.number = i.number AND l.head_oid = (
    SELECT r.head_oid FROM opus_reviews r WHERE r.repo = i.repo AND r.number = i.number AND r.verdict IS NOT NULL ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
  LEFT JOIN diff_facts df ON df.repo = l.repo AND df.number = l.number AND df.head_oid = l.head_oid
  WHERE i.kind = 'pr' AND (i.state = 'OPEN' OR (i.state = 'MERGED' AND l.verdict IN ('take', 'take-fix'))
    OR EXISTS (SELECT 1 FROM merges mm WHERE mm.repo = i.repo AND mm.number = i.number AND mm.outcome = 'merged'))`;

/** The statements named by the given stored `conflicts` values (JSON [{id, reason}]), one entry per id with the first reason; unknown ids and unreadable values count for nothing. */
async function statementConflicts(find: { get(id: number): Promise<unknown> }, stored: unknown[]): Promise<PrFacts["statementConflicts"]> {
  const out: PrFacts["statementConflicts"] = [];
  for (const v of stored) {
    if (!Array.isArray(v)) continue;
    for (const h of v as { id?: unknown; reason?: unknown }[]) {
      if (typeof h?.id !== "number" || out.some((d) => d.id === h.id)) continue;
      const d = await find.get(h.id) as { id: number; repo: string; number: number | null; text: string } | undefined;
      if (d) out.push({ id: d.id, where: d.number === null ? d.repo : `${d.repo}#${d.number}`, text: d.text, reason: typeof h.reason === "string" ? h.reason : "" });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** The instance-wide inputs of decidePr at `now`: read once per pass, not per PR. */
export const loadPass = (now: number = Date.now()): PassFacts => ({ rereadPaceAt: rereadPaceAt(now) });

/** Keeps the earliest time after `now` per ref: what `refreshAt` is made from. */
export function refreshTimes(now: number): { soon: (ref: string, at: number | undefined) => void; at: (ref: string, ...more: (number | undefined)[]) => number | undefined } {
  const times = new Map<string, number>();
  const later = (t: number | undefined): t is number => t !== undefined && Number.isFinite(t) && t > now;
  return {
    soon: (ref, t) => { if (later(t) && !(times.get(ref)! <= t)) times.set(ref, t); },
    at: (ref, ...more) => [times.get(ref), ...more].filter(later).reduce<number | undefined>((m, t) => (m === undefined || t < m ? t : m), undefined),
  };
}

/** Facts of every open PR (and merged PRs with a take or take-fix review) of the database, repo or refs given. One pass: per-repo values are read once. */
export async function loadPrFacts(db: Db, opts: LoadOptions = {}): Promise<PrFacts[]> {
  const now = opts.now ?? Date.now();
  /** The `unsent` fact of a step's ask comments that never reached GitHub; absent when the ask is due as if none had failed. */
  const unsentOf = (ats: string[]): { unsent?: { until: number } | "final" } => { const u = unsentAsk(ats, now); return u === null ? {} : { unsent: u }; };
  // Clock-driven changes the facts below do not show as a time of their own (expiries, daily counts, cache lifetimes), per PR.
  const refresh = refreshTimes(now);
  const params: Record<string, string> = {};
  let where = "";
  if (opts.repo) { where += " AND i.repo = :repo"; params.repo = opts.repo; }
  const refs = opts.refs ? [...opts.refs] : undefined;
  if (refs) { where += ` AND ${refIn("i")}`; params.refs = refPairs(refs); }
  const rows = await db.prepare(`${SELECT}${where} ORDER BY i.repo, i.number`).all(params) as Row[];

  // Values read once for all PRs.
  const run = opts.run !== undefined ? opts.run : await latestRun(db);
  // Rows of per-PR tables, read once for the load and keyed by `repo#number` (narrowed like the PRs: by repo or refs).
  const narrow = (a: string): { sql: string; p: Record<string, string> } => {
    const p: Record<string, string> = {};
    let sql = "";
    if (opts.repo) { sql += ` AND ${a}.repo = :repo`; p.repo = opts.repo; }
    if (refs) { sql += ` AND ${refIn(a)}`; p.refs = params.refs!; }
    return { sql, p };
  };
  const keyed = async <T extends { k: string }>(sql: string, a: string): Promise<Map<string, Omit<T, "k">[]>> => {
    const n = narrow(a), out = new Map<string, Omit<T, "k">[]>();
    for (const row of await db.prepare(sql.replaceAll("/*narrow*/", n.sql)).all(n.p) as T[]) {
      const k = row.k;
      delete (row as Partial<T>).k;
      (out.get(k) ?? out.set(k, []).get(k)!).push(row);
    }
    return out;
  };
  const settled = await settledSet(db, run, rows.filter((r) => r.in_pilot && r.not_integration).map((r) => `${r.repo}#${r.number}`));
  const stale = await staleReviews(db, opts.repo, false, { now, refresh: refresh.soon });
  const staleActionable = await staleReviews(db, opts.repo, true, { now, refresh: refresh.soon });
  const scope = await scopeAnswers(db);
  const unsettled = await unsettledScope(db);
  const gates = await gatesOf(db, opts.repo);
  const holds = await mergeHolds(db, opts.repo);
  const inBatch = await batchStates(db, opts.repo);
  const own = await ownFixPrs(db, opts.repo, opts.appSlug);
  const assigned = await assignmentsOf(db, opts.repo);
  const mainRed = await redMainRepos(db);
  const tripped = await activeTrips(db);
  const brokeAt = await brokeHeads(db, opts.repo);
  // carriedReview only carries our own plain fix-up (no carry or pre-merge source) as the head: skip its compiles for other PRs.
  const ourFixupHead = await keyed<{ k: string }>("SELECT f.repo || '#' || f.number || '@' || f.to_head AS k FROM fixups f WHERE f.state = 'pushed' AND f.source IS NULL /*narrow*/", "f");
  const ourSameDiffMerge = await keyed<{ k: string }>("SELECT c.repo || '#' || c.number || '@' || c.to_head AS k FROM conflict_merges c WHERE c.state = 'merged' AND c.own_diff = 'same' /*narrow*/", "c");
  // A head we pushed, or the head our push moved off (the mirror may still show it, and our own comment makes its review stale).
  const pushedHere = await keyed<{ k: string }>(`SELECT p.repo || '#' || p.number || '@' || p.to_oid AS k FROM push_outcomes p WHERE 1 /*narrow*/
    UNION SELECT p.repo || '#' || p.number || '@' || p.from_oid FROM push_outcomes p WHERE p.from_oid IS NOT NULL /*narrow*/`, "p");
  const pushedOffAt = await keyed<{ k: string; at: string }>("SELECT p.repo || '#' || p.number || '@' || p.from_oid AS k, p.at FROM push_outcomes p WHERE p.to_oid <> p.from_oid /*narrow*/", "p");
  const answers = new Map((await actionable(db)).filter((a) => a.kind === "merge").map((a) => [a.id, a.answer]));
  const pipelineOn = pipelineWrites(await setting(db, "pipeline_enabled"));
  const posts = new Map((await db.prepare("SELECT repo, number, review_id, head_oid, posted_at, opus_at FROM review_posts").all() as { repo: string; number: number; review_id: string; head_oid: string | null; posted_at: string | null; opus_at: string | null }[])
    .map((p) => [`${p.repo}#${p.number}`, p]));
  const grouped = new Set((await db.prepare(`SELECT gi.repo || '#' || gi.number AS ref FROM dupe_group_items gi JOIN decisions g ON g.id = gi.decision_id
    WHERE ${OPEN_GROUP_SQL} AND gi.role <> 'stay'`).all() as { ref: string }[]).map((r) => r.ref));
  const activeBatched = new Set((await db.prepare(`SELECT b.repo || '#' || p.number AS ref FROM main.merge_batch_prs p JOIN main.merge_batches b ON b.id = p.batch_id WHERE b.state IN ('checking', 'open')`).all() as { ref: string }[]).map((x) => x.ref));
  const mergedByPipeline = new Map((await db.prepare(`SELECT m.repo || '#' || m.number AS ref, MIN(m.at) AS merged_at,
      (SELECT x.head_oid FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS head
    FROM merges m WHERE m.outcome = 'merged' GROUP BY m.repo, m.number`).all() as { ref: string; merged_at: string; head: string | null }[]).map((x) => [x.ref, x]));
  const pmReviews = new Map((await db.prepare("SELECT repo || '#' || number AS ref, at, error FROM postmerge_reviews").all() as { ref: string; at: string; error: string | null }[]).map((x) => [x.ref, x]));
  const since = await setting(db, SINCE_KEY) ?? "9999";
  const operator = await operatorWork(db, opts.repo, now);
  const carries = await keyed<{ k: string; decision_id: string; attempts: number }>("SELECT c.repo || '#' || c.number AS k, c.decision_id, c.attempts FROM dupe_carries c WHERE c.state = 'queued' /*narrow*/ ORDER BY c.rowid", "c");
  const carryUnsent = db.prepare("SELECT created_at FROM fixups WHERE repo = ? AND number = ? AND source = 'carry' AND carry_decision = ? AND state = 'comment-unsent'");
  const carryPoints = db.prepare("SELECT detail FROM dupe_group_items WHERE decision_id = ? AND kind = 'pr' AND role = 'close' ORDER BY number");
  const fixupsOf = await keyed<{ k: string; source: string | null; state: string; reason: string | null }>("SELECT f.repo || '#' || f.number AS k, f.source, f.state, f.reason FROM fixups f WHERE 1 /*narrow*/", "f");
  // A review's own fix-up rows at a head, in the order of the per-PR index (created_at).
  const fixupAt = await keyed<{ k: string; state: string; created_at: string }>(`SELECT f.repo || '#' || f.number || '@' || f.from_head AS k, f.state, f.created_at FROM fixups f
    WHERE f.source IS NULL AND f.state IN ('pushed', 'cannot-push', 'too-large', 'asked', 'comment-failed', 'push-denied', 'linting', 'comment-unsent') /*narrow*/ ORDER BY f.created_at, f.rowid`, "f");
  const lintFixup = await keyed<{ k: string; source: string | null; lint_task: number | null }>("SELECT f.repo || '#' || f.number || '@' || f.from_head AS k, f.source, f.lint_task FROM fixups f WHERE f.state = 'linting' AND COALESCE(f.source, '') != 'operator' /*narrow*/ ORDER BY f.rowid", "f");
  // An operator's fix-up works the current head, with or without a review there, so its stored patch is read at the head before the review is.
  const lintOperator = db.prepare("SELECT lint_task FROM fixups WHERE repo = ? AND number = ? AND from_head = ? AND state = 'linting' AND source = 'operator' ORDER BY rowid");
  const taskEnded = async (id: number | null): Promise<boolean> => { const t = id != null ? await getTask(db, id) : null; return !t || TERMINAL.includes(t.state); };
  const lintCifix = await keyed<{ k: string; lint_task: number | null }>("SELECT c.repo || '#' || c.number || '@' || c.head AS k, c.lint_task FROM ci_fixes c WHERE c.state = 'linting' /*narrow*/ ORDER BY c.rowid", "c");
  const carryRows = await keyed<{ k: string } & CarrySource>(`SELECT DISTINCT c.repo || '#' || c.number AS k, g.number, g.detail, i.author, i.author_id AS id FROM dupe_carries c
    JOIN dupe_group_items g ON g.decision_id = c.decision_id AND g.kind = 'pr' AND g.role = 'close'
    LEFT JOIN items i ON i.repo = c.repo AND i.number = g.number
    WHERE c.outcome LIKE 'pushed%' /*narrow*/`, "c");
  const conflictRowsOf = await keyed<{ k: string } & ConflictRow>("SELECT c.repo || '#' || c.number AS k, c.from_head, c.state, c.created_at FROM conflict_merges c WHERE 1 /*narrow*/ ORDER BY c.rowid", "c");
  const lintConflict = await keyed<{ k: string; lint_task: number | null }>("SELECT c.repo || '#' || c.number || '@' || c.from_head AS k, c.lint_task FROM conflict_merges c WHERE c.state = 'linting' /*narrow*/ ORDER BY c.rowid", "c");
  type CifixRow = { head: string; state: string; created_at: string; task_id: number | null; runs: string | null; reason: string | null };
  const cifixOf = await keyed<{ k: string } & CifixRow>("SELECT c.repo || '#' || c.number AS k, c.head, c.state, c.created_at, c.task_id, c.runs, c.reason FROM ci_fixes c WHERE 1 /*narrow*/ ORDER BY c.created_at, c.rowid", "c");
  const authorWrites = await authorWritesOf(db, now);
  const postSource = await postSourcesOf(db, rows.filter((r) => r.r_mode === CARRIED && r.r_head).map((r) => `${r.repo}#${r.number}`));
  const queued = rows.filter((r) => r.in_pilot && r.not_integration && (r.r_verdict === "take" || r.r_verdict === "take-fix") && r.author);
  const tiers = await tiersOf(db, queued.map((r) => ({ login: r.author!, id: r.author_id })));

  const repoMemo = new Map<string, { f: PrFacts["repoFacts"]; pub: boolean; longLived: LongLived; defaultBranch: string | null }>();
  // Repo rows, CI presence and long-lived branches, read once for every repo on first use.
  let tables: { repos: Map<string, { name: string; visibility: string | null; default_branch: string | null }>; noCi: Set<string>; longLived: (repo: string) => LongLived } | undefined;
  const repoTables = async () => (tables ??= ({
    repos: new Map((await db.prepare("SELECT name, visibility, default_branch FROM repos").all() as { name: string; visibility: string | null; default_branch: string | null }[]).map((x) => [x.name, x])),
    noCi: await reposWithNoCi(db), longLived: await longLivedAll(db),
  }));
  const repoOf = async (repo: string) => {
    let m = repoMemo.get(repo);
    if (!m) {
      const t = await repoTables(), row = t.repos.get(repo);
      m = {
        f: { mergeApproved: !!await mergeApprovalOf(db, repo), pushApproved: await pushApprovalOf(db, repo) !== null, commentApproved: await commentApprovalOf(db, repo) !== null, ciApproved: await ciApprovalOf(db, repo) !== null,
          noCi: t.noCi.has(repo), mainRed: mainRed.has(repo) },
        pub: row?.visibility === "public",
        longLived: t.longLived(repo),
        defaultBranch: row?.default_branch ?? null,
      };
      repoMemo.set(repo, m);
    }
    return m;
  };

  // Open PRs by repo, head branch and head repo (lower case), lowest number first: the PR another one is stacked on. Only heads that are an open PR's base.
  const openByHead = new Map<string, number[]>();
  for (const o of await db.prepare(`SELECT i.repo || ' ' || i.head_ref || ' ' || lower(i.head_repo) AS k, i.number FROM items i
    WHERE i.kind = 'pr' AND i.state = 'OPEN' AND i.head_ref IS NOT NULL AND i.head_repo IS NOT NULL AND i.repo IN (SELECT value FROM json_each(?))
      AND (i.repo, i.head_ref) IN (SELECT b.repo, b.base_ref FROM items b WHERE b.kind = 'pr' AND b.state = 'OPEN' AND b.base_ref IS NOT NULL) ORDER BY i.number`)
    .all(JSON.stringify([...new Set(rows.map((r) => r.repo))])) as { k: string; number: number }[]) (openByHead.get(o.k) ?? openByHead.set(o.k, []).get(o.k)!).push(o.number);
  // The latest merge attempt at each head (first in the order) and the refusals there.
  const merges = await keyed<{ k: string; outcome: string; reason: string | null; ci: string | null; mergeable: string | null; at: string; refusals: number }>(`SELECT m.repo || '#' || m.number || '@' || m.head_oid AS k, m.outcome, m.reason, m.ci, m.mergeable, m.at,
    (SELECT COUNT(*) FROM merges m2 WHERE m2.repo = m.repo AND m2.number = m.number AND m2.head_oid = m.head_oid AND m2.outcome = 'refused') AS refusals FROM merges m WHERE 1 /*narrow*/ ORDER BY m.at DESC, m.rowid DESC`, "m");
  const retriedAfter = db.prepare("SELECT 1 FROM audit WHERE target = ? AND action = 'retry' AND at > ? LIMIT 1");
  const waiting = await keyed<{ k: string } & Wait>("SELECT a.repo || '#' || a.number || '@' || a.head_oid AS k, a.runs, a.approved, a.reread, a.failed, a.cross_repo, a.approved_at FROM ci_run_approvals a WHERE 1 /*narrow*/", "a");
  const verifRows = await keyed<{ k: string; state: string; kind: string; summary: string | null; note: string | null }>("SELECT v.repo || '#' || v.number || '@' || v.head_sha AS k, v.state, v.kind, v.summary, v.note FROM verifications v WHERE 1 /*narrow*/", "v");
  const verifAt = (ref: string, head: string) => verifRows.get(`${ref}@${head}`)?.[0];
  // The answer of the merge and hold decisions at each reviewed head, by id (null: not answered yet); the loop looks up no others.
  const decisionIds = rows.filter((r) => r.r_head && r.r_verdict && r.r_at).flatMap((r) => [mergeDecisionId(r.repo, r.number, r.r_head!), holdDecisionId(r.repo, r.number, r.r_head!)]);
  const decisionAnswers = new Map((await db.prepare("SELECT id, answer FROM decisions WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(decisionIds)) as { id: string; answer: string | null }[]).map((d) => [d.id, d.answer]));
  // An item has one open question at a time (src/merge/withdraw.ts): a Hold question would set another one aside, so it waits for that one.
  const otherOpen = await keyed<{ k: string }>("SELECT DISTINCT d.repo || '#' || d.number AS k FROM decisions d WHERE d.answer IS NULL AND d.id NOT LIKE '%~replaced-%' AND d.id NOT LIKE '%:dupegroup:%' AND d.kind IN ('scope', 'merge', 'close') /*narrow*/", "d");
  const holdQuestionOf = (ref: string, id: string): PrFacts["decision"]["hold"] => {
    const asked = decisionAnswers.has(id), answer = decisionAnswers.get(id) ?? null;
    return { asked, open: asked && answer === null, answer, otherOpen: otherOpen.has(ref) };
  };
  const statement = db.prepare("SELECT id, repo, number, text FROM owner_statements WHERE id = ?");
  // OPEN_QUESTION_SQL for every PR.
  const openQuestion = await keyed<{ k: string }>("SELECT DISTINCT d.repo || '#' || d.number AS k FROM decisions d WHERE d.kind = 'merge' AND d.answer IS NULL AND d.id NOT LIKE '%~replaced-%' /*narrow*/", "d");
  // The settled Merge answers, by decision id: when they were given.
  const mergeAnsweredAt = new Map((await db.prepare(`SELECT id, answered_at FROM decisions WHERE kind = 'merge' AND answer = 'merge' AND answered_at IS NOT NULL AND ${settledBySql(db, "decisions")}`).all() as { id: string; answered_at: string }[]).map((d) => [d.id, d.answered_at]));
  const answeredAfter = (id: string, at: string): boolean => { const a = mergeAnsweredAt.get(id); return a !== undefined && a > at; };
  const pushChain = await pushChainOf(db);
  const ownHead = await ownHeadOf(db);
  // UNSURE_AT_SQL for every head: a take or take-fix review there with sure = 0.
  const unsureAt = await keyed<{ k: string }>(`SELECT o.repo || '#' || o.number || '@' || o.head_oid AS k FROM opus_review_history o WHERE o.verdict IN ('take', 'take-fix') AND o.sure = 0 /*narrow*/
    UNION SELECT o.repo || '#' || o.number || '@' || o.head_oid FROM opus_reviews o WHERE o.verdict IN ('take', 'take-fix') AND o.sure = 0 /*narrow*/`, "o");
  // Pre-merge reviews at the head of each PR's latest review (r_head), the only ones the loop reads.
  const premergeKeys = JSON.stringify(rows.filter((r) => r.r_head).map((r) => `${r.repo}#${r.number}@${r.r_head}`));
  const premergeNarrow = narrow("p");
  const premerge = await premergeRows(db, { sql: `${premergeNarrow.sql} AND p.repo || '#' || p.number || '@' || p.head_oid IN (SELECT value FROM json_each(:premergeKeys))`, p: { ...premergeNarrow.p, premergeKeys } });
  // Only formal reviews with an author: changesRequestedBy() reads no others.
  const reviewRows = await keyed<{ k: string } & ReviewFact>(`SELECT c.repo || '#' || c.number AS k, c.author, c.author_association AS association, c.review_state AS state, c.created_at AS at FROM comments c JOIN items i ON i.repo = c.repo AND i.number = c.number AND i.kind = 'pr' AND i.state = 'OPEN' WHERE c.kind = 'review' AND c.author IS NOT NULL AND c.review_state IN (${FORMAL_STATES.map((x) => `'${x}'`).join(", ")}) /*narrow*/ ORDER BY c.rowid`, "c");
  const batchTip = db.prepare(`SELECT a.runs, a.approved, a.reread, a.failed, a.cross_repo FROM merge_batches b
    JOIN ci_run_approvals a ON a.repo = b.repo AND a.number = b.pr_number AND a.head_oid = b.commit_sha
    WHERE b.repo = ? AND b.pr_number = ? AND b.state = 'open'
      AND NOT EXISTS (SELECT 1 FROM merge_batch_prs p WHERE p.batch_id = b.id AND NOT EXISTS (
        SELECT 1 FROM final_reviews l WHERE l.repo = b.repo AND l.number = p.number AND l.head_oid = p.head_oid AND l.verdict IN ('take', 'take-fix')
          AND l.head_oid = (SELECT r.head_oid FROM opus_reviews r WHERE r.repo = l.repo AND r.number = l.number AND r.verdict IS NOT NULL ORDER BY r.at DESC, r.rowid DESC LIMIT 1)))
    ORDER BY b.id LIMIT 1`);

  const batchOf = db.prepare("SELECT id, commit_sha FROM merge_batches WHERE repo = ? AND pr_number = ? AND state IN ('checking', 'open') ORDER BY id LIMIT 1");
  const pipelineOn_ = await pipelineRepos(db);

  type Wait = { runs: string; approved: string; reread: number; failed: string; cross_repo: number; approved_at: string | null };
  const runsOf = (w: Wait | undefined, ciApproved: boolean): PrFacts["runs"] => {
    if (!w) return null;
    const runs = parseList(w.runs) as { id: number; event?: string }[];
    const failed = JSON.parse(w.failed || "{}") as Record<string, number>;
    const waiting = runs.length + (w.reread ? 1 : 0);
    const blocked: NonNullable<PrFacts["runs"]>["blocked"] = !waiting ? null : !ciApproved ? "off" : runs.some((x) => (failed[x.id] ?? 0) >= MAX_FAILURES) ? "failed"
      : !w.reread && (!w.cross_repo || !runs.some((x) => x.event === "pull_request")) ? "unsupported" : null;
    return { waiting, reread: !!w.reread, crossRepo: !!w.cross_repo, approvable: runs.filter((x) => x.event === "pull_request" && (failed[x.id] ?? 0) < MAX_FAILURES).length, blocked };
  };

  const holdOf = await reviewHolds(db, now, refs);
  const outsideHolds = await holdMap(db);
  const out: PrFacts[] = [];
  for (const r of rows) {
    // The queue leaves merged PRs outside the pilot and our own integration PRs out.
    if (r.state !== "OPEN" && (!r.in_pilot || !r.not_integration)) continue;
    const ref = `${r.repo}#${r.number}`;
    const rf = await repoOf(r.repo);
    const fresh = !!r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    const integration = !r.not_integration;
    // An integration PR takes part when its repo's pipeline is on or every member is in scope (fast track); its head is the batch tip, where the run approvals are recorded.
    const batchRow = integration ? (await batchOf.get(r.repo, r.number) as { id: number; commit_sha: string } | undefined) : undefined;
    const inScope = integration ? pipelineOn_.has(r.repo) || (!!batchRow && await (async members => members.length > 0 && await everySeq(members, async (m) => await inPilot(db, r.repo, m.number)))(await membersOf(db, batchRow.id))) : !!r.in_pilot;
    const head = batchRow?.commit_sha ?? headOf(r);
    const pushedOff = r.state === "OPEN" && !integration && !!head && (pushedOffAt.get(`${ref}@${head}`) ?? []).some((p) => !r.updated_at || Date.parse(r.updated_at) < Date.parse(p.at));
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    const base: PrFacts = {
      repo: r.repo, number: r.number, ...(pushedOff ? { pushedOff } : {}), assignment: assigned(ref, r.assignees), now, pipelineOn, tripped, ghState: r.state, head, draft: fresh ? r.c_state !== "OPEN" || !!r.c_draft : !!r.is_draft,
      author: r.author, authorIsPipeline: r.author !== null && await own.isOwn(r.repo, r.author), tier: "not", lines, size: sizeOf(lines), label: null, needsDecisionFlag: false,
      scopeAnswer: scope.get(ref) ?? null,
      inScope, ...(outsideHolds.has(ref) ? { outsideHold: outsideHolds.get(ref)! } : {}), integration, batchPr: !!r.batch_pr, heldBacklog: !!r.held_backlog, heldDuplicate: !r.held_backlog && !!r.held_dup, quiet: own.quiet.has(ref), mergeHeld: holds.has(ref),
      fast: (r.score ?? 0) >= FAST_FLOOR, score: r.score, repoFacts: rf.f,
      review: null, post: { postable: false, posted: null },
      checksHere: false, checksOpen: false, ci: "unknown", mergeable: r.i_mergeable ?? "UNKNOWN", unknown: null, runs: null,
      lastMerge: null, runsApprovedAfterMerge: false, verifyOverride: false, verification: null, verifyUnavailable: null,
      decision: { asked: false, openQuestion: false, answer: null, mergeAnswerAfterReview: false, inOpenGroup: grouped.has(ref), hold: { asked: false, open: false, answer: null, otherOpen: otherOpen.has(ref) } },
      premerge: null, premergeFixUsed: false, sensitive: null, statementConflicts: [], pushable: false, pushChain: [], conflict: null, inActiveBatch: activeBatched.has(ref), fixup: null, carry: [], lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false, stackedOn: null, changesRequested: null, gateFailureNote: null,
    };
    base.inFlight = r.state === "OPEN" && !integration && !!r.author && await own.isOwn(r.repo, r.author) && own.prs.has(ref);
    if (integration) {
      base.runs = runsOf(await batchTip.get(r.repo, r.number) as Wait | undefined, rf.f.ciApproved);
      out.push(base);
      continue;
    }
    if (!inScope) {
      const v = head ? verifAt(ref, head) : undefined;
      base.outside = {
        review: r.r_head && r.r_head === head && r.r_verdict && !stale.has(`${ref}@${r.r_head}`) ? r.r_verdict : null,
        verify: v?.state ?? null, ci: head && r.c_head === head ? r.overall ?? null : null,
      };
      out.push(base);
      continue;
    }

    const s = await settled(r.repo, r.number);
    base.label = labelWithScopeAnswer(s.label ?? null, base.scopeAnswer);
    base.needsDecisionFlag = s.flags.includes("needs decision") || (unsettled.has(ref) && !scope.has(ref));
    base.labelUnsure = s.status === "settled" && !!s.referee && !s.referee.sure && refereeClosed(s.referee);
    const pm = mergedByPipeline.get(ref);
    if (pm) base.postmerge = { mergedAt: pm.merged_at, head: pm.head, since, review: pmReviews.get(ref) ?? null };
    // Checks describe the PR when they were fetched for the reviewed head (or, without a review, the current one).
    const checksAtHead = r.c_head === (r.r_head ?? head);
    base.mergeable = (checksAtHead ? r.c_mergeable : r.i_mergeable) ?? "UNKNOWN";
    // An author whose permission has not been read yet counts as able to write: the job that pushes reads it first.
    base.pushable = pushable(r.head_repo, r.repo, checksAtHead ? r.c_can : r.i_can, r.head_ref, rf.longLived, false, sameRepo(r.head_repo, r.repo) && authorWrites(r.repo, r, (t) => refresh.soon(ref, t)) !== "no");
    const ow = operator.get(ref);
    if (ow && r.state === "OPEN") {
      base.operator = { fix: head && ow.fixHeads.has(head) && await queuedOperatorFix(db, r.repo, r.number, head, now) ? { attempts: await operatorTries(db, r.repo, r.number) } : null, hold: ow.hold, premerge: !!head && ow.premergeHeads.has(head), preapproved: ow.preapproved };
      refresh.soon(ref, ow.settleUntil);
    }
    // A fix-up request holds the PR's merge only while the planner can work it: same head, pushable, approved, not conflicting, not a draft, tries left.
    if (base.operator?.fix && !base.heldBacklog && !base.draft && base.mergeable !== "CONFLICTING" && base.pushable && base.repoFacts.pushApproved && await operatorTriesLeft(db, r.repo, r.number)) base.operator.hold = true;
    if (ow && r.state === "OPEN" && head) {
      for (const x of await lintOperator.all(r.repo, r.number, head) as { lint_task: number | null }[]) base.lint.push({ step: "fixup", source: "operator", ended: await taskEnded(x.lint_task) });
      if (base.lint.length) base.inFlight = true;
    }
    if (r.state === "OPEN" && !base.heldBacklog) {
      for (const k of carries.get(ref) ?? []) {
        const hasPoints = (await carryPoints.all(k.decision_id) as { detail: string | null }[]).some((x) => {
          try { const c = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry; return Array.isArray(c) && c.some((p) => typeof p === "string"); } catch { return false; }
        });
        const u = unsentAsk((await carryUnsent.all(r.repo, r.number, k.decision_id) as { created_at: string }[]).map((x) => x.created_at), now);
        if (hasPoints) base.carry.push({ attempts: k.attempts, ...(u !== null && u !== "final" ? { unsent: u } : {}) });
      }
    }
    if (r.state === "OPEN" && head && !base.draft) { const hold = await holdOf(r.repo, r.number, head, (t) => refresh.soon(ref, t)); if (hold) base.reviewHold = hold; }
    if (!r.r_head || !r.r_verdict || !r.r_at) { out.push(base); continue; }

    const take = r.r_verdict === "take" || r.r_verdict === "take-fix";
    const chain = take ? pushChain(r.repo, r.number, r.r_head) : [r.r_head];
    const unsure = take && (r.r_sure === 0 || chain.some((h) => unsureAt.has(`${ref}@${h}`)));
    base.review = {
      head: r.r_head, at: r.r_at, verdict: r.r_verdict, unsure, mode: r.r_mode, reason: r.r_reason ?? "", fixes: parseList(r.r_fixes).length,
      stale: stale.has(`${ref}@${r.r_head}`), staleActionable: staleActionable.has(`${ref}@${r.r_head}`),
    };
    base.pushChain = chain;
    base.decision.hold = holdQuestionOf(ref, holdDecisionId(r.repo, r.number, r.r_head));
    if (r.state === "OPEN" && head && head !== r.r_head && (ourFixupHead.has(`${ref}@${head}`) || ourSameDiffMerge.has(`${ref}@${head}`)) && await carriedReview(db, { repo: r.repo, number: r.number, head_oid: head }, stale)) base.carriable = true;
    if (r.state === "OPEN" && (chain.length > 1 || (!!head && pushedHere.has(`${ref}@${head}`)))) base.inFlight = true;
    // The facts of the review head's cached diff (src/review/diff.ts writes them with the cache); null when it is not cached.
    const diffFacts = r.d_lines === null ? null : { reasons: parseList(r.d_reasons) as string[], lines: r.d_lines, pending: r.d_pending === 1, lastRead: r.d_last_read };
    // While the extras are pending the reasons are the conservative ones, and the wait itself keeps the PR off the rule.
    base.sensitive = diffFacts ? (diffFacts.pending ? [...diffFacts.reasons, EXTRAS_PENDING_REASON] : diffFacts.reasons) : null;
    if (diffFacts?.pending) base.diffPending = { lastRead: diffFacts.lastRead };
    if (diffFacts) { base.lines = diffFacts.lines; base.size = sizeOf(diffFacts.lines); }
    base.statementConflicts = await statementConflicts(statement, [safeJson(r.r_conflicts), safeJson(premerge.get(`${ref}@${r.r_head}`)?.conflicts ?? null)]);
    const p = posts.get(ref);
    // A carried review has no text of its own: the post uses the text of the review it was carried from.
    const src = r.r_mode === CARRIED ? await postSource(r.repo, r.number, r.r_head) : null;
    const hasPublic = src ? src.hasPublic : r.r_public !== null;
    const pub = src ? src.public : !hasPublic ? { ok: true } : parsePublic({ summary: r.r_public, points: [] });
    base.post = {
      postable: (hasPublic || !!p?.review_id) && !!pub,
      posted: p ? { head: p.head_oid, at: p.posted_at, opusAt: p.opus_at } : null,
    };
    // The CI fix state at one head: the rows it recorded and its limits.
    const cifixAt = async (cfHead: string): Promise<NonNullable<PrFacts["cifix"]>> => {
      const all = cifixOf.get(ref) ?? [];
      const prior = all.filter((x) => x.head === cfHead);
      const totals = { pushes: all.filter((x) => CIFIX_PUSH_STATES.includes(x.state)).length, tries: all.filter((x) => CIFIX_TRY_STATES.includes(x.state)).length };
      const formatting = prior.find((x) => x.state === "formatting");
      const task = formatting?.task_id != null ? await getTask(db, formatting.task_id) : null;
      const infra = prior.find((x) => x.state === "infra");
      return {
        states: prior.map((x) => x.state), tries: prior.filter((x) => CIFIX_TRY_STATES.includes(x.state)).length,
        rerunAt: prior.find((x) => x.state === "rerun" || x.state === "rerunning")?.created_at ?? null,
        infraRuns: infra ? (parseList(infra.runs ?? "[]") as number[]) : null,
        formattingTask: formatting?.task_id ?? null, formatterEnded: !task || TERMINAL.includes(task.state),
        totalPushes: totals.pushes, totalTries: totals.tries, checksAt: r.c_at,
        skipReason: [...prior].reverse().find((x) => x.state === "skipped")?.reason ?? null,
        ...unsentOf(prior.filter((x) => x.state === "comment-unsent").map((x) => x.created_at)),
      };
    };
    // A non-take review at an earlier head while the review gate waits on red CI at the new head: the CI fix cannot start, so the contributor is asked (src/core/decide.ts unreviewedRed).
    if (!take && r.state === "OPEN" && head && head !== r.r_head && base.reviewHold?.kind === "ci" && base.reviewHold.red && r.c_head === head && await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks) === "failure") {
      base.ci = "failure";
      base.gateRed = true;
      base.cifix = await cifixAt(head);
    }
    if (!take) { out.push(base); continue; }

    const wait: Wait | undefined = waiting.get(`${ref}@${r.r_head}`)?.[0];
    const checksHere = r.c_head === r.r_head;
    base.checksHere = checksHere;
    base.checksOpen = checksHere && r.c_state === "OPEN" && !r.c_draft;
    const approvedPending = parseList(wait?.approved ?? "[]").length > 0;
    base.ci = checksHere ? (approvedPending ? "pending" : await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks)) : "unknown";
    base.runs = runsOf(wait, rf.f.ciApproved);
    // Our push to this head turned its required checks red: the CI fix works on it now, without waiting for a review of the new head.
    // A head that our own push or the review's CI gate (red CI at a new head, reviewed earlier) left red is repaired against that head.
    const redNow = r.c_head === head && await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks) === "failure";
    base.brokeByUs = brokeAt.get(ref) === head && redNow;
    base.gateRed = !base.brokeByUs && !!base.reviewHold?.red && !!head && head !== r.r_head && redNow;
    if (r.state === "OPEN") {
      const from = carriedSources(carryRows.get(ref) ?? []);
      if (from.length) {
        const t = await tiersOf(db, from.filter((x) => x.author).map((x) => ({ login: x.author!, id: x.id })));
        base.carriedFrom = from.map((x) => ({ number: x.number, author: x.author, tier: (x.author ? t.get(tierKey({ login: x.author, id: x.id })) : undefined) ?? "not" }));
      }
    }
    base.tier = (r.author ? tiers.get(tierKey({ login: r.author, id: r.author_id })) : undefined) ?? "not";
    // The pipeline's own Fix PRs count as whitelisted at a head the pipeline itself pushed (others may push to the branch); an operator's deny still wins.
    const ownHere = !!r.author && await own.isOwn(r.repo, r.author) && own.prs.has(ref) && !!head && await ownHead(r.repo, r.number, head);
    if (base.tier === "not" && ownHere) base.tier = "whitelisted";

    const last = merges.get(`${ref}@${r.r_head}`)?.[0];
    // An operator's Retry after a refusal asks for another try now, without waiting for CI or the mergeable state to change.
    // A fresh Merge answer after a refusal asks for another try, as a Retry does.
    if (last && !(last.outcome === "refused" && (await retriedAfter.get(mergeDecisionId(r.repo, r.number, r.r_head), last.at) || answeredAfter(mergeDecisionId(r.repo, r.number, r.r_head), last.at)))) {
      base.lastMerge = { outcome: last.outcome, reason: last.reason, ci: last.ci, mergeable: last.mergeable, refusals: last.refusals };
      base.runsApprovedAfterMerge = !!wait?.approved_at && wait.approved_at > last.at;
    }
    base.verification = (verifAt(ref, r.r_head) as PrFacts["verification"] | undefined) ?? null;
    if (base.verification?.state === "failed" || base.verification?.state === "error") base.verifyOverride = await verifyOverride(db, r.repo, r.number, r.r_head);
    if (!base.verification || base.verification.state === "stale") {
      base.verifyUnavailable = !rf.pub ? PRIVATE_REASON : rf.f.noCi && cachedRust(r.repo, r.r_head) === false ? NOT_RUST_REASON : null;
    }
    if (r.state === "OPEN" && base.mergeable !== "MERGEABLE" && base.mergeable !== "CONFLICTING") base.unknown = await unknownOf(db, r.repo, r.number, r.r_head);
    const id = mergeDecisionId(r.repo, r.number, r.r_head);
    const given = answers.get(id) ?? null;
    base.decision = {
      asked: decisionAnswers.has(id), openQuestion: r.state === "OPEN" && openQuestion.has(ref), answer: given,
      mergeAnswerAfterReview: given === "merge" && answeredAfter(id, r.r_at), inOpenGroup: grouped.has(ref),
      hold: base.decision.hold,
    };
    if (r.state !== "OPEN") { out.push(base); continue; }

    const row = premerge.get(`${ref}@${r.r_head}`) ?? null;
    if (row) {
      const all = findingsOf(row);
      const defects = all.filter((f) => f.severity === "defect");
      base.premerge = { at: row.at, tries: row.tries, hasFindings: row.findings !== null, unsure: row.unsure !== 0, defects: defects.length, defectsAllFixable: defects.every((f) => f.fix), fixesSafe: parseFixes(JSON.stringify(defects.map((f) => f.fix))).length === defects.length, minor: all.length - defects.length, error: row.error ?? null };
      if (defects.length) base.premergeFixUsed = premergeFixUsedIn(fixupsOf.get(ref) ?? []);
    }
    if (base.mergeable === "CONFLICTING" && r.base_ref) {
      const rows = conflictRowsOf.get(ref) ?? [];
      const bucket = conflictBucketOf(rows, { head: r.r_head, pushable: base.pushable }, { push: rf.f.pushApproved, comment: rf.f.commentApproved }, now);
      const until = bucket === "capped" ? nextUtcMidnight(now) : bucket === "ask-retry" ? conflictAskRetryAtOf(rows, r.r_head, now) : undefined;
      base.conflict = { bucket, base: r.base_ref, baseOk: BASE_NAME.test(r.base_ref), ...(until !== undefined ? { until } : {}) };
    }
    if (r.r_verdict === "take-fix") {
      base.fixup = {
        fixes: parseFixes(r.r_fixes).length, attempts: attemptsIn(fixupsOf.get(ref) ?? []), recorded: (fixupAt.get(`${ref}@${r.r_head}`) ?? []).filter((x) => x.state !== "comment-unsent").map((x) => x.state),
        ...unsentOf((fixupAt.get(`${ref}@${r.r_head}`) ?? []).filter((x) => x.state === "comment-unsent").map((x) => x.created_at)),
      };
    }
    {
      const ended = taskEnded;
      for (const x of lintFixup.get(`${ref}@${r.r_head}`) ?? []) {
        base.lint.push({ step: "fixup", source: x.source === "premerge" || x.source === "carry" || x.source === "operator" ? x.source : "review", ended: await ended(x.lint_task) });
      }
      for (const x of lintCifix.get(`${ref}@${base.brokeByUs || base.gateRed ? head : r.r_head}`) ?? []) base.lint.push({ step: "cifix", source: "review", ended: await ended(x.lint_task) });
      for (const x of lintConflict.get(`${ref}@${r.r_head}`) ?? []) base.lint.push({ step: "conflict", source: "review", ended: await ended(x.lint_task) });
      if (base.lint.length && r.state === "OPEN") base.inFlight = true;
    }
    if (base.ci === "failure" || base.brokeByUs || base.gateRed) {
      const cfHead = base.brokeByUs || base.gateRed || (head && head !== r.r_head) ? head : r.r_head;
      base.cifix = await cifixAt(cfHead ?? r.r_head!);
    }
    base.batch = inBatch.get(`${ref}@${r.r_head}`) ?? null;
    if (r.base_ref && r.state === "OPEN") base.stackedOn = (openByHead.get(`${r.repo} ${r.base_ref} ${`${slugOf(r.repo)}`.toLowerCase()}`) ?? []).find((n) => n !== r.number) ?? null;
    base.baseOffDefault = !!r.base_ref && !!rf.defaultBranch && r.base_ref !== rf.defaultBranch;
    base.mainFix = !!r.head_ref?.startsWith(MAIN_FIX_BRANCH_PREFIX) && ownHere;
    const gate = gates.get(ref);
    const { why, live } = changesRequestedWhy(gate, r.updated_at, reviewRows.get(ref) ?? [], r.review_decision);
    if (gate && gate.failures >= GATE_FAILURES) base.gateFailureNote = failureNote(gate.failures);
    if (why) base.changesRequested = { why, live };
    out.push(base);
  }
  // The timed waits the facts hold end at their own times; the refresh also covers the clock uses they do not show.
  const until = (u: { until: number } | "final" | undefined): number | undefined => (typeof u === "object" ? u.until : undefined);
  for (const f of out) {
    const at = refresh.at(`${f.repo}#${f.number}`, f.reviewHold?.until, f.conflict?.until, until(f.fixup?.unsent), until(f.cifix?.unsent), ...f.carry.map((c) => c.unsent?.until));
    if (at !== undefined) f.refreshAt = at;
  }
  return out;
}

/** Facts of one PR, or null when it is not an open PR (or a merged one with a take review). */
export async function loadPrFact(db: Db, repo: string, number: number, opts: Omit<LoadOptions, "repo" | "refs"> = {}): Promise<PrFacts | null> {
  return (await loadPrFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
export type { PrTier };

// ---- small readers shared with the merge modules ----

/** Returns a function that gives the head and the earlier heads AutoCraft itself pushed it from (a `pushing` row is a push that started and may have landed) (conflict merges of the base, fix-up pushes, carry-over pushes), newest first. */
export async function pushChainOf(db: Db): Promise<(repo: string, number: number, head: string) => string[]> {
  // Every push edge, read once: the heads each head was pushed from, distinct and in order (as the UNION gives them per head).
  const from = new Map<string, string[]>();
  for (const r of await db.prepare(`SELECT k, from_head FROM (
      SELECT repo || '#' || number || '@' || to_head AS k, from_head FROM conflict_merges WHERE state IN ('merged', 'pushing')
      UNION SELECT repo || '#' || number || '@' || to_head, from_head FROM fixups WHERE state IN ('pushed', 'pushing')
      UNION SELECT repo || '#' || number || '@' || to_head, from_head FROM dupe_carries WHERE from_head IS NOT NULL
      UNION SELECT repo || '#' || number || '@' || to_head, head FROM ci_fixes WHERE state IN ('pushed', 'pushing'))
    WHERE k IS NOT NULL ORDER BY k, from_head`).all() as { k: string; from_head: string }[]) (from.get(r.k) ?? from.set(r.k, []).get(r.k)!).push(r.from_head);
  return (repo, number, head) => {
    const chain = [head];
    for (let k = 0; k < chain.length; k++) for (const f of from.get(`${repo}#${number}@${chain[k]}`) ?? []) if (!chain.includes(f)) chain.push(f);
    return chain;
  };
}

/** Returns a function telling whether a PR's head is the pipeline's own work: a commit it pushed to its own branch, or one reached from such a commit only through its own later pushes. */
export async function ownHeadOf(db: Db): Promise<(repo: string, number: number, head: string) => Promise<boolean>> {
  const chain = await pushChainOf(db);
  let pushed: Set<string> | undefined;
  const ours = async (repo: string, sha: string): Promise<boolean> => (pushed ??= new Set((await db.prepare("SELECT repo || ' ' || sha AS k FROM main.own_commits").all() as { k: string }[]).map((r) => r.k))).has(`${repo} ${sha}`);
  return async (repo, number, head) => await someSeq(chain(repo, number, head), async (h) => await ours(repo, h));
}

/** True when any stored Opus review at the head (the current row or an overwritten one in the history) was a take or take-fix with sure = 0. */
export async function headWasUnsure(db: Db, repo: string, number: number, head: string): Promise<boolean> {
  return !!await db.prepare(UNSURE_AT_SQL).get(repo, number, head);
}

type CarrySource = { number: number; detail: string | null; author: string | null; id: number | null };
/** The closed PRs whose parts a pushed carry-over put on this PR, with their authors, from its carry rows. */
function carriedSources(rows: CarrySource[]): { number: number; author: string | null; id: number | null }[] {
  return rows.filter((x) => { try { const p = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry; return Array.isArray(p) && p.length > 0; } catch { return false; } })
    .map((x) => ({ number: x.number, author: x.author, id: x.id }));
}

export { tierKey, tiersOf, type AuthorRef };

/** PRs the pipeline opened itself from a Fix issues attempt or for a red default branch, as `repo#number`, when authored by its own account. */
export async function ownFixPrs(db: Db, repo?: string, slug?: string | null): Promise<{ login: string | null; prs: Set<string>; quiet: Set<string>; isOwn: (repo: string, author: string | null) => Promise<boolean> }> {
  const logins = new Map<string, Set<string>>();
  const isOwn = async (r: string, author: string | null): Promise<boolean> => {
    if (!author) return false;
    let set = logins.get(r);
    if (!set) logins.set(r, (set = await ownLogins(db, r, slug)));
    return set.has(author);
  };
  const login = await setting(db, PIPELINE_LOGIN_KEY) ?? null;
  const prs = new Set<string>();
  const quiet = await quietFixPrs(db, repo);
  if (!login) return { login, prs, quiet, isOwn };
  for (const ref of quiet) prs.add(ref);
  for (const r of await db.prepare("SELECT repo, pr_url FROM main.fix_attempts WHERE pr_url IS NOT NULL" + (repo ? " AND repo = ?" : "")).all(...(repo ? [repo] : [])) as { repo: string; pr_url: string }[]) {
    const m = r.pr_url.match(/\/pull\/(\d+)$/);
    if (m) prs.add(`${r.repo}#${m[1]}`);
  }
  for (const r of await db.prepare("SELECT repo, pr_number AS n FROM main.main_fixes WHERE pr_number IS NOT NULL" + (repo ? " AND repo = ?" : "")).all(...(repo ? [repo] : [])) as { repo: string; n: number }[]) prs.add(`${r.repo}#${r.n}`);
  return { login, prs, quiet, isOwn };
}

/** Reads the pipeline account and the last successful assign or unassign of every item from the audit once; the returned function gives an item's assignment facts from its mirrored `assignees` (JSON). */
export async function assignmentsOf(db: Db, repo?: string): Promise<(ref: string, assignees: string | null) => AssignFacts> {
  const login = await setting(db, PIPELINE_LOGIN_KEY) ?? null;
  const last = new Map<string, string | null>();
  for (const r of await db.prepare(`SELECT target, details FROM audit WHERE action = 'assign' AND rowid IN (SELECT MAX(rowid) FROM audit
    WHERE action IN ('assign', 'unassign') AND COALESCE(details, '') NOT LIKE '%"error":%' ${repo ? "AND target >= ? AND target < ?" : ""} GROUP BY target)`)
    .all(...(repo ? [`${repo}#`, `${repo}$`] : [])) as { target: string; details: string | null }[]) {
    last.set(r.target, (safeJson(r.details) as { assignee?: string } | null)?.assignee ?? null);
  }
  return (ref, assignees) => {
    const list = parseList(assignees).filter((x): x is string => typeof x === "string");
    const by = last.get(ref);
    // Without a recorded account, the audit's own assignee stands for it.
    return { login: login ?? by ?? null, assignees: list, ours: by !== undefined && (login === null || by === login) };
  };
}

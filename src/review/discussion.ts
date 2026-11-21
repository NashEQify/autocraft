// The discussion on a PR as the review prompts show it: top-level comments, review bodies and unresolved
// inline review threads, all read live from GitHub in one query. Our own posts are left out.
// Also decides when a PR's review is stale because someone else wrote on it after them.
// All text here is written by outsiders and is passed on as untrusted data.
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { isBotCommand, isBotLogin } from "./bots.ts";
import { blockersLoader, storedBlockedBy } from "./blockers.ts";
import type { Querier } from "../mirror.ts";
import { FORMAL_REVIEWS, recordGate, recordGateFailure, type ReviewFact } from "../merge/changes-requested.ts";
import { ENTRY_LIMIT, TOTAL_LIMIT, type DiscussionEntry } from "./parse.ts";
import { ownerOf } from "../owners.ts";
import type { Exec } from "../fixup/git.ts";
import { pipelineMe, setPipelineLogin } from "../github/pipeline-account.ts";
import { allOwnLogins, ownLogins } from "../github/identity.ts";
import { setting } from "../settings-read.ts";

/** Setting that holds the pipeline account's login (also read by src/merge/queue.ts). */
const LOGIN_KEY = "pipeline_login";
/** Prefix of the setting that marks a PR's reviews stale on an operator's request; the value is the time. */
const STALE_KEY = "review_stale:";

/** Discussion-triggered re-reviews of one PR per UTC day; a head change or an operator request is not counted. */
export const MAX_RERUNS_PER_DAY = 3;
const RERUN_KEY = "review_rerun:";

/** Sections whose text is tool output or instructions for other tools, not a claim about the change. */
const NOISE_SUMMARY = /prompt for|analysis chain|scripts? executed|fingerprint|committable|additional context|learnings|ai agents|review info|walkthrough|sequence diagram|related pull requests|suggested labels/i;

/** Markup removed, noisy collapsible sections dropped, the rest kept as plain text. */
export function cleanBody(s: string | null | undefined): string {
  let t = (s ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const inner = /<details[^>]*>((?:(?!<details)[\s\S])*?)<\/details>/i;
  for (let m = inner.exec(t); m; m = inner.exec(t)) {
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(m[1]!)?.[1] ?? "";
    const rest = m[1]!.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, "");
    const text = NOISE_SUMMARY.test(summary) ? "" : `${summary.replace(/<[^>]+>/g, "").trim()}\n${rest}`;
    t = t.slice(0, m.index) + text + t.slice(m.index + m[0].length);
  }
  return t.replace(/<\/?(?:details|summary|sub|sup|br|p|div|picture|source|img|a|b|i|strong|em|blockquote)\b[^>]*>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s);
const sec = (t: string): string => t.slice(0, 19);

export function pipelineLogin(db: DatabaseSync): string {
  return setting(db, LOGIN_KEY) ?? "";
}

/** Authors whose words trigger a new review: the PR's author and people tied to the repository. Bot accounts never do. */
const COUNTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"];

type Written = { author: string | null; association?: string | null; bot?: boolean; prAuthor?: string | null; state?: string | null; body: string | null; inline?: number };

/**
 * Whether a comment or review counts as new discussion: empty bodies and bare approvals never do, and neither do strangers' or bots'.
 * A review with no body but inline comments counts (the findings are in the threads).
 */
export function isCounted(w: Written): boolean {
  const body = cleanBody(w.body);
  const inline = w.inline ?? 0;
  if (!body && !inline) return false;
  if (w.state === "APPROVED" && !inline && body.length < 40) return false;
  const login = w.author ?? "";
  if (!login || w.bot || isBotLogin(login)) return false;
  if (!inline && isBotCommand(body)) return false;
  return login === w.prAuthor || COUNTED_ASSOCIATIONS.includes(w.association ?? "");
}

/**
 * Cleaned text per comment id. The queue and the Decisions page recompute discussion state on every change, and
 * cleaning every body dominated that cost. An entry is used only while its raw body is unchanged, so an edit is seen.
 */
const cleanMemo = new Map<string, { raw: string; clean: string }>();
const CLEAN_MEMO_MAX = 100_000;

function cleanedOf(id: string, body: string | null): string {
  const raw = body ?? "";
  const hit = cleanMemo.get(id);
  if (hit && hit.raw === raw) return hit.clean;
  const clean = cleanBody(raw);
  if (cleanMemo.size >= CLEAN_MEMO_MAX) cleanMemo.clear();
  cleanMemo.set(id, { raw, clean });
  return clean;
}

/** A hash of the counted entries (id and cleaned text): two snapshots with the same hash read the same discussion. */
export function discussionHash(xs: { id: string; body: string | null }[]): string {
  return createHash("sha256").update(JSON.stringify(xs.map((x) => [x.id, cleanedOf(x.id, x.body)]).sort())).digest("hex").slice(0, 16);
}

/** What a review read: when, and a hash of the counted entries. */
export type Snapshot = { seen: string; hash: string | null };

/** The `:own` parameter of NOT_OURS. With no login known, '' stands in, so authorless rows stay out as before. */
const ownJson = (own: Set<string>): string => JSON.stringify(own.size ? [...own] : [""]);

/** SQL for "written by someone other than us" (`c` is the comments table alias): not our logins, not our review post, and not a comment the pipeline wrote (its audited text) under an operator's own login. */
const NOT_OURS = `COALESCE(c.author, '') NOT IN (SELECT value FROM json_each(:own))
  AND c.id NOT IN (SELECT review_id FROM review_posts WHERE repo = c.repo AND number = c.number)
  AND NOT EXISTS (SELECT 1 FROM main.audit au WHERE au.target = c.repo || '#' || c.number AND c.body IS NOT NULL AND json_extract(au.details, '$.text') = c.body)`;

type MirrorRow = { id: string; kind: string; author: string | null; created_at: string | null; body: string | null; review_state: string | null; counted: number | null; maint: number };
const mirrorRows = (db: DatabaseSync, repo: string, number: number): MirrorRow[] =>
  db.prepare(`SELECT c.id, c.kind, c.author, c.created_at, c.body, c.review_state, c.counted,
      (c.author_association IN ('OWNER', 'MEMBER', 'COLLABORATOR') OR EXISTS (SELECT 1 FROM main.access a WHERE lower(a.login) = lower(c.author) AND a.role IN ('operator', 'maintainer')))
        AND COALESCE(c.author, '') <> COALESCE((SELECT i.author FROM items i WHERE i.repo = c.repo AND i.number = c.number), '') AS maint FROM comments c
    WHERE c.repo = :repo AND c.number = :number AND ${NOT_OURS} ORDER BY c.created_at`).all({ repo, number, own: ownJson(ownLogins(db, repo)) }) as MirrorRow[];

/** Comments and review bodies from the mirror: the fallback for a call that has no GitHub connection. */
function mirrorDiscussion(db: DatabaseSync, repo: string, number: number): { entries: DiscussionEntry[]; hash: string; maint: Set<number> } {
  const rows = mirrorRows(db, repo, number);
  const entries: DiscussionEntry[] = [];
  const maint = new Set<number>();
  for (const r of rows) {
    const body = cleanBody(r.body);
    if (!body) continue;
    if (r.maint === 1) maint.add(entries.length);
    entries.push({ kind: r.kind === "review" ? "review" : "comment", author: r.author, at: r.created_at, ...(r.kind === "review" ? { state: r.review_state } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return { entries, hash: discussionHash(rows.filter((r) => r.counted === 1)), maint };
}

export const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login } reviewDecision
      comments(last: 100) { nodes { id author { login __typename } authorAssociation createdAt body } }
      reviews(last: 100) { nodes { id author { login __typename } authorAssociation createdAt body state comments { totalCount } } }
      formal: ${FORMAL_REVIEWS}
      reviewThreads(last: 100) { nodes { isResolved isOutdated path line originalLine
        head: comments(first: 1) { nodes { id author { login __typename } authorAssociation createdAt body } }
        tail: comments(last: 3) { nodes { id author { login } authorAssociation body } } } }
    }
  }
}`;

type Author = { login?: string; __typename?: string } | null;
type Node = { id?: string; author?: Author; authorAssociation?: string; createdAt?: string; submittedAt?: string; body?: string; state?: string; comments?: { totalCount?: number } };
type ThreadNode = {
  isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; originalLine?: number | null;
  head?: { nodes?: Node[] }; tail?: { nodes?: Node[] };
};

export type LiveDiscussion = { entries: DiscussionEntry[]; snap: Snapshot; newest: string | null; /** Latest formal review of each reviewer with write access, for the changes-requested rule. */ formal: ReviewFact[]; reviewDecision: string | null;
  /** Newest counted entry written by a maintainer or dashboard user; the merge-time check goes by this, as stale reviews do. */ newestMaint: string | null;
  /** Indexes of the entries a maintainer or dashboard user other than the PR author wrote, and of threads one replied to: they are kept first within the prompt's budget. */ maint?: Set<number>;
  /** Of those, the entries the maintainer wrote (a comment, a review body, a thread they started). */ wrote?: Set<number> };

/**
 * Everything others wrote on the PR, read from GitHub (a read, never a write) in one query: comments, review
 * bodies and unresolved threads, ours excluded. `snap.seen` is the time just before the read.
 */
export async function liveDiscussion(q: Querier, db: DatabaseSync, repo: string, number: number): Promise<LiveDiscussion> {
  const seen = new Date().toISOString();
  const res = await q.query(DISCUSSION_QUERY, { owner: ownerOf(repo), name: repo, number });
  const pr = res?.repository?.pullRequest;
  if (!pr) throw new Error(`${repo}#${number} not found on GitHub`);
  const own = ownLogins(db, repo);
  const posted = new Set((db.prepare("SELECT review_id FROM review_posts WHERE repo = ? AND number = ?").all(repo, number) as { review_id: string }[]).map((r) => r.review_id));
  const mine = (a: Author | undefined, id?: string) => (!!a?.login && own.has(a.login)) || (!!id && posted.has(id));
  const prAuthor: string | null = pr.author?.login ?? null;
  const entries: DiscussionEntry[] = [];
  const counted: { id: string; body: string | null }[] = [];
  let newest: string | null = null, newestMaint: string | null = null;
  const dash = new Set((db.prepare("SELECT login FROM main.access WHERE role IN ('operator', 'maintainer')").all() as { login: string }[]).map((r) => r.login.toLowerCase()));
  const isMaint = (login: string | null | undefined, assoc: string | undefined) => MAINTAINER_ASSOCIATIONS.includes(assoc ?? "") || (!!login && dash.has(login.toLowerCase()));
  // The PR author's own words never rank as a maintainer's, whatever their association.
  const otherMaint = (login: string | null | undefined, assoc: string | undefined) => isMaint(login, assoc) && login !== prAuthor;
  const maint = new Set<number>(), wrote = new Set<number>();
  const take = (kind: "comment" | "review", n: Node) => {
    if (mine(n.author, n.id)) return;
    const body = cleanBody(n.body);
    if (body && otherMaint(n.author?.login, n.authorAssociation)) { maint.add(entries.length); wrote.add(entries.length); }
    if (body) entries.push({ kind, author: n.author?.login ?? null, at: n.createdAt ?? null, ...(kind === "review" ? { state: n.state ?? null } : {}), body: clip(body, ENTRY_LIMIT) });
    if (isCounted({ author: n.author?.login ?? null, association: n.authorAssociation, bot: n.author?.__typename === "Bot", prAuthor, state: n.state, body: n.body ?? null, inline: n.comments?.totalCount })) {
      counted.push({ id: n.id ?? "", body: n.body ?? null });
      if (n.createdAt && (!newest || n.createdAt > newest)) newest = n.createdAt;
      if (n.createdAt && isMaint(n.author?.login, n.authorAssociation) && (!newestMaint || n.createdAt > newestMaint)) newestMaint = n.createdAt;
    }
  };
  for (const n of (pr.comments?.nodes ?? []) as Node[]) take("comment", n);
  for (const n of (pr.reviews?.nodes ?? []) as Node[]) take("review", n);
  for (const t of (pr.reviewThreads?.nodes ?? []) as ThreadNode[]) {
    const c = t.head?.nodes?.[0];
    if (!c || t.isResolved || mine(c.author, c.id)) continue;
    const body = cleanBody(c.body);
    if (!body) continue;
    if (isCounted({ author: c.author?.login ?? null, association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor, body: c.body ?? null })) {
      counted.push({ id: c.id ?? "", body: c.body ?? null });
      if (c.createdAt && (!newest || c.createdAt > newest)) newest = c.createdAt;
      if (c.createdAt && isMaint(c.author?.login, c.authorAssociation) && (!newestMaint || c.createdAt > newestMaint)) newestMaint = c.createdAt;
    }
    const tail = (t.tail?.nodes ?? []).filter((r) => r.id !== c.id && !mine(r.author, r.id))
      .map((r) => ({ author: r.author?.login ?? null, body: clip(cleanBody(r.body), ENTRY_LIMIT / 2), maint: otherMaint(r.author?.login, r.authorAssociation) })).filter((r) => r.body);
    const replies = tail.map(({ author, body }) => ({ author, body }));
    // A maintainer's reply in someone else's thread ranks the thread as the maintainer's own entry would.
    if (otherMaint(c.author?.login, c.authorAssociation)) wrote.add(entries.length);
    if (otherMaint(c.author?.login, c.authorAssociation) || tail.some((r) => r.maint)) maint.add(entries.length);
    entries.push({ kind: "thread", author: c.author?.login ?? null, at: c.createdAt ?? null, path: t.path, line: t.line ?? t.originalLine ?? null, ...(t.isOutdated ? { outdated: true } : {}), body: clip(body, ENTRY_LIMIT), ...(replies.length ? { replies } : {}) });
  }
  const formal = ((pr.formal?.nodes ?? []) as Node[])
    .map((n) => ({ id: n.id ?? null, author: n.author?.login ?? null, association: n.authorAssociation ?? null, state: n.state ?? null, at: n.submittedAt ?? n.createdAt ?? null }));
  return { entries, snap: { seen, hash: discussionHash(counted) }, newest, newestMaint, formal, reviewDecision: pr.reviewDecision ?? null, maint, wrote };
}

/** Retries a read a few times: a failed read must not silently drop what reviewers wrote. */
export async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries) throw e; }
  }
}

/**
 * Entries kept within the total budget: a maintainer's or dashboard user's entries and threads they replied to (`first`, by index) before anyone else's,
 * then threads, reviews and comments (newest first within each), so neither a noisy bot nor the PR author can push out
 * the findings or a maintainer's word. The `must` entries (by index) have a budget of the same size of their own, taken first.
 * The kept entries are returned oldest first.
 */
export function fitBudget(entries: DiscussionEntry[], total = TOTAL_LIMIT, first: ReadonlySet<number> = new Set(), must: ReadonlySet<number> = new Set()): DiscussionEntry[] {
  const rank = { thread: 0, review: 1, comment: 2, note: 3 } as const;
  const order = entries.map((e, i) => ({ e, i })).sort((a, b) => Number(first.has(b.i)) - Number(first.has(a.i)) || rank[a.e.kind] - rank[b.e.kind] || b.i - a.i);
  const kept = new Set<number>();
  const fill = (part: { e: DiscussionEntry; i: number }[]) => {
    let used = 0;
    for (const { e, i } of part) {
      const n = e.body.length + (e.path?.length ?? 0) + (e.replies?.reduce((t, r) => t + r.body.length, 0) ?? 0) + 40;
      if (used + n > total) continue;
      used += n;
      kept.add(i);
    }
  };
  fill(order.filter((x) => must.has(x.i)));
  fill(order.filter((x) => !must.has(x.i)));
  const out = entries.filter((_, i) => kept.has(i));
  const dropped = entries.length - out.length;
  if (dropped) out.push({ kind: "note", body: `${dropped} more entries left out for length` });
  return out;
}

/**
 * The discussion of a PR for a review prompt and the snapshot it came from: `live` when read from GitHub, else the mirror's.
 * A maintainer's entry the model must see is a comment or review newer than `since` (the PR's previous review read the rest)
 * or an unresolved thread they started that is not outdated; these have a budget of their own.
 * `maintDropped`: such an entry still did not fit, so the snapshot covers words the model was not shown.
 */
export function discussionOf(db: DatabaseSync, repo: string, number: number, live?: LiveDiscussion, since = ""): { entries: DiscussionEntry[]; snap: Snapshot; maintDropped: boolean } {
  const fit = (all: DiscussionEntry[], maint: Set<number>, wrote: Set<number>, snap: Snapshot) => {
    const must = new Set([...wrote].filter((i) => (all[i]!.kind === "thread" ? !all[i]!.outdated : (all[i]!.at ?? "") > since)));
    const entries = fitBudget(all, TOTAL_LIMIT, maint, must);
    const kept = new Set(entries);
    return { entries, snap, maintDropped: [...must].some((i) => !kept.has(all[i]!)) };
  };
  if (live) return fit(live.entries, live.maint ?? new Set(), live.wrote ?? new Set(), live.snap);
  const seen = new Date().toISOString();
  const m = mirrorDiscussion(db, repo, number);
  return fit(m.entries, m.maint, m.maint, { seen, hash: m.hash });
}

const staleKey = (repo: string, number: number) => `${STALE_KEY}${repo}#${number}`;

export type DiscussionState = Map<string, { newest: string; hash: string; /** Newest counted entry by a maintainer (OWNER, MEMBER, COLLABORATOR or a dashboard user); "" when none. */ maint: string }>;

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

// The queue recomputes on every `steps` change, which comment writes don't move. Comments bump `items`, our posts
// bump `reviews`, and the pipeline login is part of the key, so an unchanged signature means unchanged input.
const stateMemo = new WeakMap<DatabaseSync, Map<string, { sig: string; state: DiscussionState }>>();

/** Newest counted comment or review by someone else, and the hash of those, per PR "repo#n" from the mirror (issues are left out). Callers must not modify the result. */
export function discussionState(db: DatabaseSync, repo?: string): DiscussionState {
  const seqs = db.prepare("SELECT topic, seq FROM change_seq WHERE topic IN ('items', 'reviews') ORDER BY topic").all() as { topic: string; seq: number }[];
  const sig = JSON.stringify([seqs, [...allOwnLogins(db)]]);
  const memo = stateMemo.get(db) ?? new Map<string, { sig: string; state: DiscussionState }>();
  stateMemo.set(db, memo);
  const key = repo ?? "";
  const hit = memo.get(key);
  if (hit && hit.sig === sig && seqs.length === 2) return hit.state;
  const state = computeDiscussionState(db, repo);
  memo.set(key, { sig, state });
  return state;
}

function computeDiscussionState(db: DatabaseSync, repo?: string): DiscussionState {
  const own = ownJson(repo ? ownLogins(db, repo) : allOwnLogins(db));
  const rows = db.prepare(`SELECT c.repo, c.number, COALESCE(MAX(c.created_at), '') AS newest,
      COALESCE(MAX(CASE WHEN c.author_association IN (${MAINTAINER_ASSOCIATIONS.map((a) => `'${a}'`).join(", ")})
        OR EXISTS (SELECT 1 FROM main.access a WHERE a.login = c.author AND a.role IN ('operator', 'maintainer')) THEN c.created_at END), '') AS maint
    FROM comments c WHERE (:repo IS NULL OR c.repo = :repo) AND c.counted = 1 AND ${NOT_OURS}
      AND NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = c.repo AND i.number = c.number AND i.kind = 'issue') GROUP BY c.repo, c.number`).all({ repo: repo ?? null, own }) as { repo: string; number: number; newest: string; maint: string }[];
  // The hash needs the comment text; callers ask for it only after a newer entry than a review's snapshot, so it is read on first use (primeHashes reads many in one query).
  const known = new Map<string, string>();
  const texts = (keys: { repo: string; number: number }[]): Map<string, { id: string; body: string | null }[]> => {
    const by = new Map<string, { id: string; body: string | null }[]>(keys.map((k) => [`${k.repo}#${k.number}`, []]));
    for (const c of db.prepare(`SELECT c.repo, c.number, c.id, c.body FROM json_each(:keys) j JOIN comments c ON c.repo = j.value ->> 0 AND c.number = j.value ->> 1
      WHERE c.counted = 1 AND ${NOT_OURS}`).all({ keys: JSON.stringify(keys.map((k) => [k.repo, k.number])), own }) as { repo: string; number: number; id: string; body: string | null }[])
      by.get(`${c.repo}#${c.number}`)?.push(c);
    return by;
  };
  const prime = (keys: { repo: string; number: number }[]) => {
    for (const [k, v] of texts(keys)) known.set(k, discussionHash(v));
  };
  const rowOf = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  const state: DiscussionState = new Map(rows.map((r) => {
    const k = `${r.repo}#${r.number}`;
    return [k, { newest: r.newest, maint: r.maint, get hash() { if (!known.has(k)) prime([r]); return known.get(k)!; } }];
  }));
  primers.set(state, (refs) => {
    const keys = [...new Set(refs)].filter((k) => !known.has(k)).flatMap((k) => rowOf.get(k) ?? []);
    if (keys.length) prime(keys);
  });
  return state;
}

const primers = new WeakMap<DiscussionState, (refs: Iterable<string>) => void>();

/** Reads the hashes of the entries of `refs` in one query; an entry not primed reads its own on first use. */
export function primeHashes(state: DiscussionState, refs: Iterable<string>): void {
  primers.get(state)?.(refs);
}

/** Whether the newest maintainer entry is newer than `seen`: maintainerSince() then needs the hash. */
const maintNewer = (state: { maint: string } | undefined, seen: string): boolean => !!state && !!state.maint && sec(state.maint) > sec(seen);

/** A maintainer's counted entry newer than a review's snapshot that the review did not read; PR author comments do not count. */
export function maintainerSince(state: { newest: string; hash: string; maint: string } | undefined, seen: string, hash: string | null): boolean {
  return maintNewer(state, seen) && state!.hash !== hash;
}

/**
 * Whether a maintainer or an operator asked for a new review of the PR after `since` (the latest review's time): "Review again",
 * a merge-time check that found new discussion, or a maintainer's comment. Such a request skips the blocker, CI and daily-cap waits.
 */
export function reviewRequestedSince(db: DatabaseSync, repo: string, number: number, since: string, seen: string | null, hash: string | null, state: DiscussionState = discussionState(db, repo)): boolean {
  return markedStaleSince(db, repo, number, since) || maintainerSince(state.get(`${repo}#${number}`), seen ?? since, hash);
}

/** True when the discussion has a counted entry newer than a review's snapshot and differs from what that review read (no hash: any newer entry). */
export function changedSince(state: { newest: string; hash: string } | undefined, seen: string, hash: string | null): boolean {
  return !!state && sec(state.newest) > sec(seen) && state.hash !== hash;
}

const day = () => new Date().toISOString().slice(0, 10);
const rerunKey = (repo: string, number: number) => `${RERUN_KEY}${repo}#${number}:${day()}`;
const reruns = (db: DatabaseSync, repo: string, number: number): number =>
  Number(setting(db, rerunKey(repo, number)) ?? 0);

/** Whether an operator request or the merge-time discussion check marked the PR stale after `since` (such re-reviews are not counted). */
export function markedStaleSince(db: DatabaseSync, repo: string, number: number, since: string): boolean {
  const v = setting(db, staleKey(repo, number));
  return !!v && v > since;
}

/** markedStaleSince() for every PR, with the marks read in one query. */
export function staleMarksSince(db: DatabaseSync): (repo: string, number: number, since: string) => boolean {
  const marks = new Map((db.prepare("SELECT key, value FROM main.settings WHERE key LIKE ?").all(`${STALE_KEY}%`) as { key: string; value: string }[]).map((m) => [m.key, m.value]));
  return (repo, number, since) => { const v = marks.get(staleKey(repo, number)); return !!v && v > since; };
}

/** Counts a same-head re-review against the PR's daily cap and forgets earlier days. */
export function countRerun(db: DatabaseSync, repo: string, number: number): void {
  db.prepare("DELETE FROM main.settings WHERE key LIKE ? AND key <> ?").run(`${RERUN_KEY}${repo}#${number}:%`, rerunKey(repo, number));
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(rerunKey(repo, number), "1");
}

type ReviewedRow = { repo: string; number: number; head_oid: string; at: string; seen_at: string | null; disc_hash: string | null; blocked_by: string | null; rebased: number | null };

// A pass calls staleReviews() several times; the rows change only with the `items`, `reviews` and `repos` topics.
const reviewedMemo = new WeakMap<DatabaseSync, Map<string, { sig: string; rows: ReviewedRow[] }>>();

function reviewedRows(db: DatabaseSync, repo?: string): ReviewedRow[] {
  const seqs = db.prepare("SELECT topic, seq FROM change_seq WHERE topic IN ('items', 'reviews', 'repos') ORDER BY topic").all() as { topic: string; seq: number }[];
  const sig = JSON.stringify(seqs);
  const memo = reviewedMemo.get(db) ?? new Map<string, { sig: string; rows: ReviewedRow[] }>();
  reviewedMemo.set(db, memo);
  const hit = memo.get(repo ?? "");
  if (hit && hit.sig === sig && seqs.length === 3) return hit.rows;
  const rows = db.prepare(`SELECT r.repo, r.number, r.head_oid, r.at, r.seen_at, r.disc_hash, r.blocked_by,
      i.base_ref IS NOT NULL AND COALESCE(r.base_ref, p.default_branch) IS NOT NULL AND i.base_ref <> COALESCE(r.base_ref, p.default_branch) AS rebased
    FROM opus_reviews r LEFT JOIN items i ON i.repo = r.repo AND i.number = r.number LEFT JOIN repos p ON p.name = r.repo
    WHERE r.verdict IS NOT NULL AND (:repo IS NULL OR r.repo = :repo)`)
    .all({ repo: repo ?? null }) as ReviewedRow[];
  memo.set(repo ?? "", { sig, rows });
  return rows;
}

/**
 * PRs, as "repo#n@head", whose Opus review read the discussion before a counted comment or review that it
 * did not read, that an operator marked stale, or whose diff was read against another base branch than the PR has now
 * (a review that recorded none counts as read against the default branch). With `respectCap`, PRs that already had
 * MAX_RERUNS_PER_DAY discussion- or base-triggered re-reviews today are left out (an operator mark is never capped).
 */
export function staleReviews(db: DatabaseSync, repo?: string, respectCap = false): Set<string> {
  const rows = reviewedRows(db, repo);
  const state = discussionState(db, repo);
  primeHashes(state, rows.filter((r) => maintNewer(state.get(`${r.repo}#${r.number}`), r.seen_at ?? r.at)).map((r) => `${r.repo}#${r.number}`));
  const marks = new Map((db.prepare("SELECT key, value FROM main.settings WHERE key LIKE ?").all(`${STALE_KEY}%`) as { key: string; value: string }[]).map((m) => [m.key.slice(STALE_KEY.length), m.value]));
  const out = new Set<string>();
  const todays = new Map<string, number>();
  const capped = (r: { repo: string; number: number }) => {
    const k = `${r.repo}#${r.number}`;
    if (!todays.has(k)) todays.set(k, reruns(db, r.repo, r.number));
    return todays.get(k)! >= MAX_RERUNS_PER_DAY;
  };
  let loaded: ReturnType<typeof blockersLoader> | undefined;
  const blockers = () => (loaded ??= blockersLoader(db));
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    const marked = (marks.get(ref) ?? "") > r.at;
    // On a head that has a review, only a maintainer's words (or an operator's request) make it stale: the PR author's comments feed the next review but do not start one.
    const talked = maintainerSince(state.get(ref), r.seen_at ?? r.at, r.disc_hash);
    // A hold that waited for other items is reviewed once when none is open any more.
    const unblocked = !!r.blocked_by && storedBlockedBy(r.blocked_by).length > 0 && blockers().active(ref, r.blocked_by, r.at).length === 0;
    if (!marked && !unblocked && !((talked || r.rebased === 1) && !(respectCap && capped(r)))) continue;
    out.add(`${ref}@${r.head_oid}`);
  }
  return out;
}

/** Records the login that posts for us (the token's viewer) when no stage has yet, so our posts can be told from others'. */
export async function ensurePipelineLogin(db: DatabaseSync, _q: Querier, run?: Exec): Promise<void> {
  if (pipelineLogin(db)) return;
  // Never the querier's viewer: under the app identity that is the bot.
  const me = await pipelineMe(() => {}, run);
  if (me) setPipelineLogin(db, me.login, false);
}

/**
 * Just before a merge: reads the PR's discussion and reviews live in one query. `moved`: a counted entry newer than
 * the final review's snapshot (and different from what it read) was written by a maintainer or operator (the PR author's comments are read by the next review without stopping the merge); the PR's reviews are then marked stale so the
 * pipeline reviews it again. `blocked`: a maintainer's changes-requested review stands. Either way the caller must
 * not merge. What the read saw of the formal reviews is stored in review_gates.
 */
export async function liveGate(db: DatabaseSync, q: Querier, repo: string, number: number, head: string): Promise<{ moved: boolean; blocked: string | null }> {
  const live = await liveDiscussion(q, db, repo, number);
  const blocked = recordGate(db, repo, number, live.formal, live.reviewDecision);
  const snap = db.prepare("SELECT COALESCE(seen_at, at) AS seen, disc_hash AS hash FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL").get(repo, number, head) as { seen: string; hash: string | null } | undefined;
  if (!snap || !live.newestMaint || !changedSince({ newest: live.newestMaint, hash: live.snap.hash! }, snap.seen, snap.hash)) return { moved: false, blocked };
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(staleKey(repo, number), new Date().toISOString());
  return { moved: true, blocked };
}

/** Operator request: its review counts as older than now, so Opus reviews it again. */
export function markReviewsStale(db: DatabaseSync, by: string, repo: string, number: number): void {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(staleKey(repo, number), at);
  audit(db, by, "review-again", `${repo}#${number}`, { stale: true });
}

/** liveGate with retries; null when the read still fails, so the caller skips the PR this run instead of merging blind. */
export async function liveGateChecked(db: DatabaseSync, q: Querier, repo: string, number: number, head: string, log: (line: string) => void): Promise<{ moved: boolean; blocked: string | null } | null> {
  try {
    return await withRetry(() => liveGate(db, q, repo, number, head));
  } catch (e) {
    recordGateFailure(db, repo, number);
    log(`  ${repo}#${number}: could not read its discussion and reviews (${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}); skipped this run`);
    return null;
  }
}

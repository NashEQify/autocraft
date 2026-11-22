// Per-item GitHub detail for the item trace and the item page: a PR's changed files and commits, and the label and
// force-push events of issues and PRs. One query per item, read when the item's head or update time differs from
// the last read; the item list sync and the checks poll do not carry it.
import type { Querier } from "./mirror.ts";
import { ownerOf } from "./owners.ts";
import type { Db } from "./db/index.ts";
import { excluded } from "./db/kx.ts";
// Local, as in mirror.ts: importing it from review/checks.ts closes an import cycle through mirror.ts.

/** Items read per sync pass; a backlog drains over several passes. */
export const ACTIVITY_PER_PASS = 20;
/** Each read is a blocking call under the sync lock, so a pass stops starting reads after this long. */
export const ACTIVITY_PASS_MS = 15_000;
/** An item whose read failed is not read again before this long. */
const RETRY_AFTER_MS = 3_600_000;
/** Closed and merged items older than this are not read. */
export const ACTIVITY_WINDOW_MS = 14 * 86_400_000;
/** The sync leaves this many points for its other work. */
const ACTIVITY_MIN_REMAINING = 2000;
/** Files and commits per query; the same cap the other per-PR reads use. */
const CAP = 100;

export const ACTIVITY_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        issueTimeline: timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) { nodes { __typename ... on LabeledEvent { id createdAt actor { login } label { name } } ... on UnlabeledEvent { id createdAt actor { login } label { name } } } }
      }
      ... on PullRequest {
        headRefOid
        files(first: 100) { nodes { path additions deletions changeType } }
        commits(last: 100) { nodes { commit { oid messageHeadline committedDate author { user { login } } authors(first: 10) { nodes { email user { login } } } } } }
        prTimeline: timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes { __typename ... on LabeledEvent { id createdAt actor { login } label { name } } ... on UnlabeledEvent { id createdAt actor { login } label { name } } ... on HeadRefForcePushedEvent { id createdAt actor { login } beforeCommit { oid } afterCommit { oid } } }
        }
      }
    }
  }
}`;

type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The logins of a commit's authors (the git author and its Co-authored-by trailers): the account GitHub matched, or the login in a users.noreply.github.com address (`<id>+<login>@` or `<login>@`). */
export function commitLogins(authors: Node[]): string[] {
  const out = new Set<string>();
  for (const a of authors) {
    const login = a?.user?.login ?? /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i.exec(String(a?.email ?? ""))?.[1];
    if (typeof login === "string" && login) out.add(login);
  }
  return [...out].sort();
}

export async function saveActivity(db: Db, repo: string, number: number, node: Node, item: { head: string | null; updated_at: string | null }, at: string): Promise<void> {
  await db.write(async () => {
    const events: Node[] = (node.prTimeline ?? node.issueTimeline)?.nodes ?? [];
    for (const e of events) {
      if (!e?.id) continue;
      const kind = e.__typename === "LabeledEvent" ? "labeled" : e.__typename === "UnlabeledEvent" ? "unlabeled" : e.__typename === "HeadRefForcePushedEvent" ? "force-push" : null;
      if (!kind) continue;
      await db.run(db.k.insertInto("item_activity")
        .values({ repo, number, id: e.id, kind, at: e.createdAt, actor: e.actor?.login ?? null, label: e.label?.name ?? null, before_oid: e.beforeCommit?.oid ?? null, after_oid: e.afterCommit?.oid ?? null })
        .onConflict((oc) => oc.columns(["repo", "number", "id"]).doUpdateSet(excluded(["kind", "at", "actor", "label", "before_oid", "after_oid"]))));
    }
    if (node.__typename === "PullRequest") {
      const head = node.headRefOid as string;
      await db.run(db.k.deleteFrom("pr_files").where("repo", "=", repo).where("number", "=", number));
      for (const f of node.files?.nodes ?? []) {
        if (!f?.path) continue;
        await db.run(db.k.insertInto("pr_files")
          .values({ repo, number, head, path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0, change_type: f.changeType ?? "CHANGED" })
          .onConflict((oc) => oc.columns(["repo", "number", "head", "path"]).doUpdateSet(excluded(["additions", "deletions", "change_type"]))));
      }
      for (const c of node.commits?.nodes ?? []) {
        if (!c?.commit?.oid) continue;
        const authors = c.commit.authors?.nodes as Node[] | undefined;
        await db.run(db.k.insertInto("pr_commits")
          .values({
            repo, number, oid: c.commit.oid, committed_at: c.commit.committedDate, author: c.commit.author?.user?.login ?? null, first_seen_at: at,
            message: c.commit.messageHeadline ?? null, co_authors: authors ? JSON.stringify(commitLogins(authors)) : null,
          })
          .onConflict((oc) => oc.columns(["repo", "number", "oid"]).doUpdateSet((eb) => ({
            committed_at: eb.ref("excluded.committed_at"),
            author: eb.ref("excluded.author"),
            message: eb.fn.coalesce("excluded.message", "pr_commits.message"),
            co_authors: eb.fn.coalesce("excluded.co_authors", "pr_commits.co_authors"),
          }))));
      }
    }
    await saveSyncState(db, { repo, number, ...item }, at, null, null);
  });
}

/**
 * Records the read or the attempt, so the item waits for its next change or the retry time instead of heading every pass.
 * Every column is written: a successful read clears the error and retry time of an earlier failed one.
 */
async function saveSyncState(db: Db, it: { repo: string; number: number; head: string | null; updated_at: string | null }, at: string, error: string | null, retryAt: string | null): Promise<void> {
  await db.run(db.k.insertInto("activity_sync")
    .values({ repo: it.repo, number: it.number, head: it.head, updated_at: it.updated_at, read_at: at, error, retry_at: retryAt })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["head", "updated_at", "read_at", "error", "retry_at"]))));
}

/**
 * Reads the items whose head or update time moved since their last read, newest update first, and the ones whose read failed once their
 * retry time passed. A failed or missing item does not stop the pass. Returns how many it read.
 */
export async function syncActivity(db: Db, client: Querier, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MS).toISOString();
  const due = await db.all(db.k.selectFrom("items as i")
    .innerJoin("tracked_repos as t", "t.name", "i.repo")
    .leftJoin("activity_sync as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.head_oid as head", "i.updated_at"])
    .where((eb) => eb.and([
      eb.or([eb("i.state", "=", "OPEN"), eb("i.updated_at", ">=", since)]),
      eb.or([
        eb("s.repo", "is", null),
        eb("s.head", "is distinct from", eb.ref("i.head_oid")),
        eb("s.updated_at", "is distinct from", eb.ref("i.updated_at")),
        eb.and([eb("s.retry_at", "is not", null), eb("s.retry_at", "<=", now.toISOString())]),
      ]),
    ]))
    // SQLite's order for DESC; Postgres would put NULLs first.
    .orderBy("i.updated_at", (o) => o.desc().nullsLast())
    .limit(ACTIVITY_PER_PASS));
  const started = Date.now();
  let read = 0;
  for (const it of due) {
    if (client.remaining !== null && client.remaining < ACTIVITY_MIN_REMAINING) break;
    if (read > 0 && Date.now() - started > ACTIVITY_PASS_MS) break;
    try {
      const node = ((await client.query(ACTIVITY_QUERY, { owner: ownerOf(it.repo), name: it.repo, number: it.number })) as Node).repository?.issueOrPullRequest;
      // A deleted or transferred item has no node; the attempt is still recorded.
      if (node) await saveActivity(db, it.repo, it.number, node, it, now.toISOString());
      else await saveSyncState(db, it, now.toISOString(), null, null);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // The limit applies to every item; the caller logs it and the next pass starts again.
      if (/rate limit/i.test(msg)) throw e;
      await saveSyncState(db, it, now.toISOString(), msg.slice(0, 200), new Date(now.getTime() + RETRY_AFTER_MS).toISOString());
    }
    read++;
  }
  return read;
}

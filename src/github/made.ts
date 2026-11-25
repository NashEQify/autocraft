// Looks on GitHub for a write whose answer was lost (a crash, a timeout, a dropped connection): the audit row holds the exact text and
// the time the write began, so a comment, issue or review with that text made since then is that write. Read-only. Each throws
// when GitHub cannot be read: the outcome is then still unknown and the write must not be made again.
import { slugOf } from "../owners.ts";
import type { Querier } from "../mirror.ts";

/** Runs `gh` with these arguments and returns its output; throws when it fails. */
export type GhRead = (args: string[]) => Promise<string>;

/** Allowed difference between this machine's clock and GitHub's. */
const SKEW_MS = 2 * 60_000;
const from = (since: string): string => new Date(Date.parse(since) - SKEW_MS).toISOString();
const text = (s: unknown): string => String(s ?? "").replace(/\r\n/g, "\n").trim();
const rows = <T>(out: string): T[] => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

/** The issue with this title and body opened in the repo since `since`. */
export async function issueMade(read: GhRead, o: { repo: string; title: string; body: string; since: string }): Promise<{ number: number; url: string } | null> {
  const since = from(o.since);
  const out = await read(["api", "--paginate", `repos/${slugOf(o.repo)}/issues?state=all&sort=created&direction=desc&per_page=100&since=${encodeURIComponent(since)}`,
    "--jq", ".[] | select(.pull_request == null) | {number, url: .html_url, title, body, at: .created_at} | tojson"]);
  const hit = rows<{ number: number; url: string; title: string; body: string | null; at: string }>(out)
    .find((r) => Date.parse(r.at) >= Date.parse(since) && text(r.title) === text(o.title) && text(r.body) === text(o.body));
  return hit ? { number: hit.number, url: hit.url } : null;
}

/** The URL of the comment with this text made on the issue or PR since `since`. */
export async function commentMade(read: GhRead, o: { repo: string; number: number; body: string; since: string }): Promise<string | null> {
  const since = from(o.since);
  const out = await read(["api", "--paginate", `repos/${slugOf(o.repo)}/issues/${o.number}/comments?per_page=100&since=${encodeURIComponent(since)}`,
    "--jq", ".[] | {url: .html_url, body, at: .created_at} | tojson"]);
  return rows<{ url: string; body: string | null; at: string }>(out).find((r) => Date.parse(r.at) >= Date.parse(since) && text(r.body) === text(o.body))?.url ?? null;
}

const COMMENTS = `query($id: ID!) { node(id: $id) {
  ... on Issue { comments(last: 100) { nodes { url body createdAt } } }
  ... on PullRequest { comments(last: 100) { nodes { url body createdAt } } }
} }`;
const REVIEWS = `query($id: ID!) { node(id: $id) { ... on PullRequest { reviews(last: 100) { nodes { id body submittedAt commit { oid } } } } } }`;

/** `commentMade` by the item's node id. */
export async function nodeCommentMade(q: Pick<Querier, "query">, o: { id: string; body: string; since: string }): Promise<string | null> {
  const r = await q.query(COMMENTS, { id: o.id }) as { node?: { comments?: { nodes: { url: string; body: string; createdAt: string }[] } } | null };
  return r.node?.comments?.nodes.find((c) => Date.parse(c.createdAt) >= Date.parse(from(o.since)) && text(c.body) === text(o.body))?.url ?? null;
}

/** The id of the review with this text on the PR's commit, submitted since `since`. */
export async function reviewMade(q: Pick<Querier, "query">, o: { id: string; head: string; body: string; since: string }): Promise<string | null> {
  const r = await q.query(REVIEWS, { id: o.id }) as { node?: { reviews?: { nodes: { id: string; body: string; submittedAt: string | null; commit: { oid: string } | null }[] } } | null };
  return r.node?.reviews?.nodes.find((v) => v.commit?.oid === o.head && v.submittedAt !== null && Date.parse(v.submittedAt) >= Date.parse(from(o.since)) && text(v.body) === text(o.body))?.id ?? null;
}

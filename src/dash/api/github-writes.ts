// AutoCraft's GitHub writes on one item, read from the audit table and joined to the comments and commits they made.
// Plain rows only: the item page API maps them to its own shapes.
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import * as kx from "../../db/kx.ts";
import { ownLogins } from "../../github/identity.ts";
import type { Db } from "../../db/index.ts";

/** A comment written before its URL was recorded matches by time within this window. */
export const MATCH_WINDOW_MS = 120_000;

export type WriteRow = {
  rowid: number;
  at: string;
  action: string;
  /** `started` (outcome unknown), `done` or `failed`. */
  state: string;
  identity: string | null;
  url: string | null;
  review: string | null;
  head: string | null;
  sha: string | null;
  labels: string[];
  jobId: number | null;
  error: string | null;
  /** The mirrored comment or review this write made, when one is found. */
  comment: { id: string; kind: string | null; url: string | null; created_at: string | null; author: string | null } | null;
};

type CommentRow = { id: string; kind: string | null; url: string | null; created_at: string | null; author: string | null };

/** A comment without a creation time never falls inside a window. */
const timeOf = (t: string | null): number => (t === null ? NaN : Date.parse(t));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The writes AutoCraft made on `repo#number`, oldest first. */
export async function writesOf(db: Db, repo: string, number: number): Promise<WriteRow[]> {
  const actions = Object.keys(GITHUB_ACTIONS);
  const audit = await db.all(db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "action", "details"])
    .where("target", "=", `${repo}#${number}`).where("action", "in", actions).orderBy("at").orderBy(kx.rowid("audit")));
  const comments = await db.all(db.k.selectFrom("comments").select(["id", "kind", "url", "created_at", "author"]).where("repo", "=", repo).where("number", "=", number).orderBy(kx.rowid("comments")));
  const taken = new Set<string>();
  const byUrl = new Map(comments.filter((c) => c.url).map((c) => [c.url!, c]));
  const byId = new Map(comments.map((c) => [c.id, c]));
  const out: WriteRow[] = audit.map((a) => {
    const d = JSON.parse(a.details ?? "{}") as Record<string, unknown>;
    const url = str(d.url);
    const review = str(d.review);
    const row: WriteRow = {
      rowid: a.rowid, at: a.at, action: a.action, state: str(d.state) ?? "started", identity: str(d.identity), url, review,
      head: str(d.head), sha: str(d.commit) ?? str(d.sha), labels: Array.isArray(d.labels) ? d.labels.filter((x): x is string => typeof x === "string") : [],
      jobId: typeof d.jobId === "number" ? d.jobId : null, error: str(d.error), comment: null,
    };
    const hit = (url ? byUrl.get(url) : undefined) ?? (review ? byId.get(review) : undefined);
    if (hit) { row.comment = hit; taken.add(hit.id); }
    return row;
  });
  // Fallback for rows without a URL (crash-time rows, rows from before URLs were recorded): the nearest comment of the same kind
  // inside the window that no write of this item claimed and that the account the write used wrote.
  const ours = await ownLogins(db, repo);
  for (const row of out) {
    if (row.comment || row.state === "failed" || row.action.endsWith("-edit") || !/comment|review-post/.test(row.action)) continue;
    const by = row.identity?.startsWith("user:") ? new Set([row.identity.slice(5)]) : ours;
    const kind = row.action === "review-post" ? "review" : "comment";
    const t = Date.parse(row.at);
    let best: CommentRow | null = null;
    for (const c of comments) {
      if (taken.has(c.id) || c.kind !== kind || !c.author || !by.has(c.author)) continue;
      const dt = Math.abs(timeOf(c.created_at) - t);
      if (dt <= MATCH_WINDOW_MS && (!best || dt < Math.abs(timeOf(best.created_at) - t))) best = c;
    }
    if (best) { row.comment = best; taken.add(best.id); }
  }
  return out;
}

/** Whether AutoCraft pushed this commit to the item: an audit push row on it recorded the oid as its `commit`. */
export async function pushedByAutoCraft(db: Db, repo: string, number: number, oid: string): Promise<boolean> {
  return await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one"))
    .where("target", "=", `${repo}#${number}`).where((eb) => kx.like(db, "action", eb.val("%-push")))
    .where((eb) => eb.and([
      eb(kx.jsonText(db, "details", "$.state"), "=", "done"),
      eb.or([eb(kx.jsonText(db, "details", "$.commit"), "=", oid), eb(kx.jsonText(db, "details", "$.sha"), "=", oid)]),
    ])).limit(1)) !== undefined;
}

/** The commits AutoCraft pushed to the item, as `pushedByAutoCraft` finds them: the `commit` or `sha` its done audit push rows recorded. */
export async function pushedCommits(db: Db, repo: string, number: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await db.all(db.k.selectFrom("audit")
    .select([kx.jsonText(db, "details", "$.commit").as("c"), kx.jsonText(db, "details", "$.sha").as("s")])
    .where("target", "=", `${repo}#${number}`).where((eb) => kx.like(db, "action", eb.val("%-push")))
    .where(kx.jsonText(db, "details", "$.state"), "=", "done")))
    for (const v of [r.c, r.s]) if (typeof v === "string") out.add(v);
  return out;
}

// Comment loaders (M01 mirror-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { CommentFilter, CommentHit, CommentRow, CommentStats, RefKey, ReviewFact } from "./types.ts";

/** Comments of each item, filtered and ordered as asked. The body is read only with `body: true`. */
export async function loadComments(db: Db, keys: KeySource, f?: CommentFilter): Promise<Map<RefKey, CommentRow[]>> {
  throw new Error("not built: mirror.loadComments");
}

/** Count, newest time, total length, link presence and authors of each item's comments. */
export async function loadCommentStats(db: Db, keys: KeySource, f?: Omit<CommentFilter, "order" | "body">): Promise<Map<RefKey, CommentStats>> {
  throw new Error("not built: mirror.loadCommentStats");
}

/** Formal review entries (kind review, author set, formal state) of open PRs in row order. */
export async function loadFormalReviews(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewFact[]>> {
  throw new Error("not built: mirror.loadFormalReviews");
}

/** Logins with an item or comment in the repo. */
export async function loadActivityByLogins(db: Db, repo: string, logins: string[]): Promise<Set<string>> {
  throw new Error("not built: mirror.loadActivityByLogins");
}

/** Full-text comment search, best first. */
export async function searchComments(db: Db, search: string, opts: { repos?: string[]; limit?: number }): Promise<CommentHit[]> {
  throw new Error("not built: mirror.searchComments");
}

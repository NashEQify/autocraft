// Our own commits (M06 control-b).
import type { Db } from "../../db/index.ts";

/** Batched insert on conflict do nothing, called after a successful push. */
export async function addOwnCommits(db: Db, rows: { repo: string; sha: string; action: string; at?: string }[]): Promise<void> {
  throw new Error("not built: control.addOwnCommits");
}

/** Membership of `(repo, sha)` pairs, keyed "repo@sha". */
export async function loadOwnCommits(db: Db, pairs: { repo: string; sha: string }[]): Promise<Set<string>> {
  throw new Error("not built: control.loadOwnCommits");
}

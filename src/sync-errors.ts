// Per-repo sync failures: one repo that cannot be read is skipped for the run and recorded here; the health checks read the table.
import type { Db } from "./db/index.ts";

export type RepoErrorKind = "not-found" | "forbidden" | "transient" | "error";

/** Reads of a repo's error row, newest streak first. */
export type RepoError = { repo: string; kind: RepoErrorKind; message: string; movedTo: string | null; since: string; at: string };

/** The kind of a failed read: GraphQL type or HTTP status for GitHub errors, the class for a transient one. */
export function classifyFailure(e: unknown): RepoErrorKind {
  const err = e as { type?: string | null; status?: number; name?: string; constructor?: { name?: string } };
  if (err?.type === "NOT_FOUND" || err?.status === 404) return "not-found";
  if (err?.type === "FORBIDDEN" || err?.status === 403) return "forbidden";
  if (err?.constructor?.name === "Transient") return "transient";
  return "error";
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

/** Records that `repo` failed; the streak's `since` stays from the first failure of the same kind. */
export async function recordRepoFailure(db: Db, repo: string, e: unknown, movedTo: string | null = null, now: Date = new Date()): Promise<RepoErrorKind> {
  const kind = classifyFailure(e);
  const message = String((e as Error)?.message ?? e).slice(0, 300);
  const at = iso(now);
  await db.run(db.k.insertInto("sync_repo_errors").values({ repo, kind, message, moved_to: movedTo, since: at, at })
    .onConflict((oc) => oc.column("repo").doUpdateSet((eb) => ({
      kind: eb.ref("excluded.kind"), message: eb.ref("excluded.message"), moved_to: eb.ref("excluded.moved_to"), at: eb.ref("excluded.at"),
      since: eb.case().when("sync_repo_errors.kind", "=", eb.ref("excluded.kind")).then(eb.ref("sync_repo_errors.since")).else(eb.ref("excluded.since")).end(),
    }))));
  return kind;
}

export async function clearRepoFailure(db: Db, repo: string): Promise<void> {
  await db.run(db.k.deleteFrom("sync_repo_errors").where("repo", "=", repo));
}

/** Errors of repos that are still tracked. */
export async function repoErrors(db: Db): Promise<RepoError[]> {
  return await db.all(db.k.selectFrom("sync_repo_errors as e").innerJoin("tracked_repos as t", "t.name", "e.repo")
    .select(["e.repo", "e.kind", "e.message", "e.moved_to as movedTo", "e.since", "e.at"]).$narrowType<{ kind: RepoErrorKind }>()
    .orderBy("e.since").orderBy("e.repo"));
}

// Each user's own repo picks for their user-local helpers, stored in `user_settings` under `repos` as a JSON list. Empty means
// every repo. The per-repo Pipeline switch stays the operators' control: a picked repo whose pipeline is off has no calls.
import { audit } from "../dash/audit.ts";
import { trackedNames } from "../repos.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

const KEY = "repos";
/** The most repos one user may pick. */
export const MAX_PICKS = 500;

/** The user's picked repos, sorted; empty when they never picked any (every repo). */
export async function userRepos(db: Db, login: string): Promise<string[]> {
  const row = await db.get(db.k.selectFrom("main.user_settings").select("value").where("login", "=", login).where("key", "=", KEY));
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").sort() : [];
  } catch {
    return [];
  }
}

/** Repo picks from a request body, checked against the tracked repos; throws with the reason for a bad list. */
export async function parseRepos(db: Db, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length > MAX_PICKS || !raw.every((x) => typeof x === "string")) throw new Error(`repos must be a list of at most ${MAX_PICKS} repo names`);
  const tracked = new Set(await trackedNames(db));
  const unknown = raw.filter((x) => !tracked.has(x));
  if (unknown.length) throw new Error(`not tracked: ${unknown.slice(0, 5).join(", ")}`);
  return [...new Set(raw as string[])].sort();
}

/** Stores the user's picks; a change is audited. */
export async function setUserRepos(db: Db, login: string, repos: string[]): Promise<string[]> {
  const was = await userRepos(db, login);
  await db.run(db.k.insertInto("main.user_settings").values({ login, key: KEY, value: JSON.stringify(repos), updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(excluded(["value", "updated_at"]))));
  if (was.join("\n") !== repos.join("\n")) await audit(db, login, "my-repos", login, { repos, was });
  return repos;
}

/**
 * The repos a claim may take calls from: the user's picks narrowed by the helper's own list, never widened by it. Null when
 * neither limits it. A call that names no repo is not limited by this (claimOrder checks only the repos a call names).
 */
export async function claimRepos(db: Db, login: string, helperRepos: readonly string[] | undefined): Promise<Set<string> | null> {
  const picks = await userRepos(db, login);
  if (!picks.length) return helperRepos ? new Set(helperRepos) : null;
  if (!helperRepos) return new Set(picks);
  const own = new Set(helperRepos);
  return new Set(picks.filter((r) => own.has(r)));
}

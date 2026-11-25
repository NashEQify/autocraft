// Whether a person still counts when their earlier press or command is carried out now: their role, and write access on every repo.
import { decideAct, freshWrite, loadActFacts, permKey, PERM_READ_TTL } from "../data/access/index.ts";
import type { Db } from "../db/index.ts";
import { githubIdentity } from "../github/identity.ts";

/**
 * The first of `repos` the person may no longer act on, or null. An operator always may; a maintainer by the act rule, with write access
 * read now (`live`: the caller asked GitHub with the person's token) or cached.
 */
export async function lostAccess(db: Db, login: string, repos: string[], o: { live?: boolean; now?: number } = {}): Promise<string | null> {
  const now = o.now ?? Date.now();
  const [facts, identity] = await db.together(() => Promise.all([loadActFacts(db, repos.map((repo) => ({ login, repo }))), githubIdentity(db)]));
  return repos.find((repo) => {
    const f = facts.get(permKey(login, repo));
    if (f?.role === "operator") return false;
    return !f || !decideAct(f, o.live ? "yes" : freshWrite(f.perm, PERM_READ_TTL, now) ? "cached" : "unknown", identity).ok;
  }) ?? null;
}

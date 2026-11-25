// What an implement job needs before it starts, checked again at the run: the repo's Implement feature (the workspaces it runs in), and
// a live implement workflow on the issue of someone who acts on the repo now (data/access standing): its newest answer, approval or start is the
// approval the implementation and its PR's revisions run on.
// A job that only ends an attempt whose PR merged or closed needs none of them.
import { featureOn } from "../build/features.ts";
import type { Db } from "../db/index.ts";
import { githubIdentity } from "../github/identity.ts";
import type { MayResult } from "../core/may.ts";
import { permKey, standings, type Standing } from "../data/access/index.ts";
import { loadImplementFacts } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { listWorkflows, loadAnswers, workflowActors } from "../data/workflow/index.ts";
import { settlerOf } from "../workflow/work.ts";
import { currentAttempt, writeStep } from "./attempt.ts";
import { ENDED_STATES } from "./types.ts";

/** Who the issue's live implement workflow acts for, newest first, each with whether they may act on the repo now; empty without one. */
async function actorsOf(db: Db, repo: string, number: number): Promise<{ login: string; standing: Standing }[]> {
  const w = (await listWorkflows(db, { live: true, refs: [{ repo, number }] }))[0];
  if (w?.entry !== "implement") return [];
  const logins = workflowActors(w, (await loadAnswers(db, [w.id])).get(w.id));
  const at = await standings(db, logins.map((login) => ({ login, repo })), { identity: await githubIdentity(db) });
  return logins.map((login) => ({ login, standing: at.get(permKey(login, repo))! }));
}

const settler = (actors: { login: string; standing: Standing }[]) =>
  settlerOf(actors.map((a) => a.login), (login) => actors.find((a) => a.login === login)!.standing);

/** The login the issue's implementation runs for (settlerOf), or null when no implement workflow on it is live. */
export async function queuerOf(db: Db, repo: string, number: number): Promise<string | null> {
  return settler(await actorsOf(db, repo, number))?.by ?? null;
}

/**
 * Whose Task Runner the attempt's model calls run on: `holder`'s (it keeps the sessions so far) while the live workflow acts for them and they may
 * act on the repo, else the one the implementation runs for now.
 */
async function turnsFor(db: Db, repo: string, number: number, holder: string): Promise<string> {
  const actors = await actorsOf(db, repo, number);
  const held = actors.find((a) => a.login.toLowerCase() === holder.toLowerCase());
  if (held && held.standing !== "no") return holder;
  const s = settler(actors);
  return s?.standing === "yes" ? s.by : holder;
}

/** Moves the issue's attempt to the person its model calls run for now (turnsFor): the next turn starts a session on their Task Runner. */
export async function moveTurns(db: Db, repo: string, number: number): Promise<void> {
  const cur = await currentAttempt(db, repo, number);
  const to = cur && await turnsFor(db, repo, number, cur.impl.queuedBy);
  if (cur && to && to !== cur.impl.queuedBy) await writeStep(db, cur.impl, { patch: { queuedBy: to, sessionCallId: null } });
}

/** Whether the issue's implementation may write to the repo without its approval: as the person it runs for. */
export async function implementMay(db: Db, repo: string, number: number): Promise<MayResult> {
  const by = await queuerOf(db, repo, number);
  return by ? { ok: true, as: "person", by } : { ok: false, why: `${repo}#${number} is not queued` };
}

/** Why an implement job of the issue may not run, or null. `dry`: a dry run, which may run while the repo's Implement switch is off. */
export async function implementRefusal(db: Db, repo: string, number: number, o: { dry?: boolean } = {}): Promise<string | null> {
  const ref = `${repo}#${number}` as const;
  const facts = await loadImplementFacts(db, [{ repo, number }]);
  // A live attempt whose PR merged or closed only ends (attempt and workspace): bookkeeping that always runs.
  const attempt = facts.byIssue.get(ref)?.attempt;
  if (!o.dry && attempt && !ENDED_STATES.has(attempt.state) && attempt.prNumber !== null) {
    const pr = (await loadItems(db, [{ repo, number: attempt.prNumber }], "ref")).get(`${repo}#${attempt.prNumber}`);
    if (pr && pr.state !== "OPEN") return null;
  }
  if (!o.dry && !await featureOn(db, "implement", repo)) return `Implement is off for ${repo}`;
  const s = settler(await actorsOf(db, repo, number));
  if (!s) return `${ref} is not queued`;
  return s.standing === "yes" ? null : s.standing === "no" ? `${s.by}, whom the work on ${ref} runs for, does not settle on ${repo}` : `GitHub has not answered on ${s.by}'s access to ${repo}`;
}

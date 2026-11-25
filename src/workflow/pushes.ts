// Our own pushes to pull requests, for the rule that they move the head a person was shown (src/core/may.ts chainsOwn). The advance
// pass and the command core read them here, so a question the pass leaves standing is one an answer is taken to.
import { loadPatchFacts, type PatchFacts } from "../data/changes/index.ts";
import { loadPushOutcomeEdges } from "../data/control/index.ts";
import { loadRepins } from "../data/workflow/index.ts";
import type { OwnPush } from "../core/may.ts";
import type { Db } from "../db/index.ts";

type Ref = { repo: string; number: number };

/** Each PR's fix-ups, CI fixes, base merges, implementation revisions and autorepins that moved its head, keyed `repo#number`. `patches`: the PRs' patch facts. */
export async function loadOwnPushes(db: Db, prs: Ref[], patches: Promise<Map<string, PatchFacts>> = loadPatchFacts(db, prs)): Promise<Map<string, OwnPush[]>> {
  const [facts, outcomes, repins] = await Promise.all([patches, loadPushOutcomeEdges(db, prs), loadRepins(db, prs, { states: ["pushed"] })]);
  return new Map(prs.map((r) => `${r.repo}#${r.number}`).map((k) => [k, [
    ...(facts.get(k)?.pushes ?? []), ...(outcomes.get(k) ?? []),
    ...(repins.get(k) ?? []).flatMap((r) => (r.head && r.to_head ? [{ from: r.head, to: r.to_head }] : [])),
  ]]));
}

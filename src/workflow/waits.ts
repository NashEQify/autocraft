// What an approved workflow's merge leg waits for when nothing can move it on: the pre-merge check of the PR's head, due once the
// leg is in `ci`, with no Task Runner that may take it (src/remote/takers.ts, with the approver's own runners counting connected
// or not). The status comment, the item page and the agent show it as the state line.
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import { PREMERGE_MAX_TRIES, premergeAt } from "../premerge/store.ts";
import { inferenceMode } from "../remote/mode.ts";
import { takerTest } from "../remote/takers.ts";
import type { ItemWorkflow } from "./types.ts";

/** The state line of a workflow whose merge leg waits for a pre-merge check no Task Runner can take, or null. */
export async function legWait(db: Db, wf: Pick<ItemWorkflow, "id" | "repo" | "state">, nowMs: number = Date.now()): Promise<string | null> {
  if (wf.state !== "running" && wf.state !== "waiting") return null;
  const p = await db.get(db.k.selectFrom("main.preapprovals").select(["number", "head"]).where("workflow_id", "=", wf.id).where("state", "=", "ci").orderBy("id", "desc").limit(1));
  if (!p?.head || await inferenceMode(db) !== "user-local") return null;
  const pm = await premergeAt(db, wf.repo, p.number, p.head);
  if (pm && (pm.findings !== null || pm.tries >= PREMERGE_MAX_TRIES)) return null;
  if (await takerTest(db, nowMs)({ prompt_id: "", repos: [wf.repo], step: "premerge", refs: [{ repo: wf.repo, number: p.number }] })) return null;
  return t("Waiting for the pre-merge check: no Task Runner can take it");
}

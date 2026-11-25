// The one write that stops a workflow at a blocker: the merge leg that works for it ends with it, so nothing merges past the question.
import { listWorkflows, type Preapproval, type WorkflowPatch } from "../data/workflow/index.ts";
import type { Stop } from "../core/codes.ts";
import type { Db } from "../db/index.ts";
import { cancelPreapproval, inActiveBatch } from "../preapproval/index.ts";
import type { ItemWorkflow } from "./types.ts";

const ACTOR = "pipeline";

/**
 * `w`: the row as the caller read it; `patch`: the whole change of the row, its state and blocker among it; `line`: what its `blocked` event
 * says. `pr`: the PR the workflow works on, null for an issue without one; `leg`: the active merge leg to end with it, null for none, and
 * `stop` why it ends.
 */
export type BlockWrite = {
  w: ItemWorkflow; patch: WorkflowPatch; at: string; line: string | null;
  pr: { repo: string; number: number } | null; leg: Pick<Preapproval, "id" | "state"> | null; stop: Stop;
};

/**
 * Stops the workflow. `written`: the row, its event and the leg's end are stored. `deferred`: the leg is ended, and the caller stores the row
 * and its event with its other writes. `changed`: a person changed the workflow meanwhile and decides about the leg (a start after a stop
 * has a new one); nothing is written. `merging`: the leg cannot be stopped now (an integration batch holds the PR, whose running CI a cancel
 * would undo, a merge of the repo is running, or the leg changed a moment ago); nothing is written, and the next pass looks again.
 */
export async function blockWorkflow(db: Db, b: BlockWrite): Promise<"deferred" | "written" | "changed" | "merging"> {
  const { w, pr, leg } = b;
  if (!leg || !pr) return "deferred";
  if (leg.state === "queued" && await inActiveBatch(db, pr.repo, pr.number)) return "merging";
  const now = (await listWorkflows(db, { ids: [w.id] }))[0];
  if (now?.state !== w.state || now.updatedAt !== w.updatedAt) return "changed";
  try {
    await cancelPreapproval(db, ACTOR, pr.repo, pr.number, undefined, "workflow");
  } catch {
    return "merging";
  }
  return "deferred";
}

// Each user's item choice for their Task Runners: which items the runners take work on, next to My tasks (my-tasks.ts). "all"
// takes every item; "fast" only fast-tracked items (src/fasttrack.ts: Queue items, the @<app> queue command, the fast-track
// list); "mine" only fast-tracked items the user added to the list or queued (a live pre-approved merge of theirs, which
// counts when another user fast-tracked the PR first). Stored in `user_settings` under `task_items`; no row means "all".
// Picks ("Run on my Task Runner") and follow-ups of the user's own sessions do not go by it, as with My tasks and My repos.
//
// A call matches when any item it names matches: a call about a chosen item (a duplicate check against an older item, say) is
// work on that item. Batches (repoBatches in src/agents/call.ts) never mix items that different filtered users take
// (batchKey in takers.ts), so a batch matches a filtered user only when every item in it does. A question asked before the items are known
// (a job about to start, a repo's takers) counts a filtered runner only for the repos that have an open matching item.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const TASK_ITEMS_KEY = "task_items";
export const TASK_ITEMS = ["all", "fast", "mine"] as const;
export type TaskItems = (typeof TASK_ITEMS)[number];

const isTaskItems = (v: unknown): v is TaskItems => typeof v === "string" && (TASK_ITEMS as readonly string[]).includes(v);

/** The user's item choice; "all" with no row or a value no longer offered. */
export async function userTaskItems(db: Db, login: string): Promise<TaskItems> {
  const v = (await db.get(db.k.selectFrom("main.user_settings").select("value").where("login", "=", login).where("key", "=", TASK_ITEMS_KEY)))?.value;
  return isTaskItems(v) ? v : "all";
}

/** The item choice from a request body; throws with the reason for a bad one. */
export function parseTaskItems(raw: unknown): TaskItems {
  if (!isTaskItems(raw)) throw new Error(`taskItems must be one of ${TASK_ITEMS.join(", ")}`);
  return raw;
}

/** Stores the item choice ("all" removes the row); a change is audited. */
export async function setUserTaskItems(db: Db, login: string, v: TaskItems): Promise<TaskItems> {
  const was = await userTaskItems(db, login);
  if (v === "all") await db.run(db.k.deleteFrom("main.user_settings").where("login", "=", login).where("key", "=", TASK_ITEMS_KEY));
  else await db.run(db.k.insertInto("main.user_settings").values({ login, key: TASK_ITEMS_KEY, value: v, updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(kx.excluded(["value", "updated_at"]))));
  if (v !== was) await audit(db, login, "task-items", login, { items: v, was });
  return v;
}

/** The open items a filtered user takes (`refs`, as `repo#number`) and their repos; null for a user who takes every item. */
export type ItemFilter = { refs: ReadonlySet<string>; repos: ReadonlySet<string> } | null;

/** The user's ItemFilter, read now. */
export async function itemFilter(db: Db, login: string): Promise<ItemFilter> {
  const choice = await userTaskItems(db, login);
  if (choice === "all") return null;
  // The live pre-approval states are ACTIVE in src/preapproval/index.ts.
  const rows = await db.all(db.k.selectFrom("main.fast_track as f")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number").on("i.state", "=", "OPEN"))
    .select(["f.repo", "f.number"])
    .$if(choice !== "fast", (q) => q.where((eb) => eb.or([
      kx.ciEq(db, "f.added_by", eb.val(login)),
      eb.exists(eb.selectFrom("main.preapprovals as p").select(eb.lit(1).as("one")).whereRef("p.repo", "=", "f.repo").whereRef("p.number", "=", "f.number")
        .where(kx.ciEq(db, "p.by", eb.val(login))).where("p.state", "in", ["fixup", "review", "ci", "queued"])),
    ]))));
  return { refs: new Set(rows.map((r) => `${r.repo}#${r.number}`)), repos: new Set(rows.map((r) => r.repo)) };
}

/**
 * Whether a filter lets a runner take work: `refs` known (a queued call, a pool's unit), when any of them matches, so a call about
 * no item never does; `refs` unknown (a job about to start), when any of `repos` has a matching item.
 */
export function itemsFit(f: ItemFilter, c: { repos: readonly string[]; refs?: readonly { repo: string; number: number }[] }): boolean {
  if (!f) return true;
  if (c.refs) return c.refs.some((r) => f.refs.has(`${r.repo}#${r.number}`));
  return c.repos.some((x) => f.repos.has(x));
}

/** The choice a filtered user made, as the no-taker reason names it. */
export const TASK_ITEMS_TITLE: Record<Exclude<TaskItems, "all">, string> = { fast: "fast-tracked items only", mine: "only the items they fast-tracked" };


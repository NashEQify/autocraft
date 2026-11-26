// "My items": the items a person is involved in through AutoCraft.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Ref } from "./types.ts";

/** The workflow events that make an item someone's: what they started, approved, held, resumed or answered. */
const MINE_KINDS = ["started", "approved", "stopped", "resumed", "answered"];

/**
 * The items `login` started, approved, held, resumed or answered, on any of their workflows, or wrote a message about: open ones, and
 * those that merged or closed within the last `doneDays` days. Items only the automatic merge rule started, and items a person only
 * authored or was assigned on GitHub, are not theirs. Newest chat entry first (a message, or an event of a workflow). One statement.
 */
export async function loadMineRefs(db: Db, login: string, opts: { doneDays: number; nowMs?: number }): Promise<Ref[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const since = new Date((opts.nowMs ?? Date.now()) - opts.doneDays * 86_400_000).toISOString();
  const touched = k.selectFrom("main.item_workflows as w").select(["w.repo", "w.number"])
    .where((eb: any) => eb.or([eb("w.started_by", "=", login), eb("w.approved_by", "=", login), eb("w.stopped_by", "=", login)]))
    .unionAll(k.selectFrom("main.workflow_events as e").select(["e.repo", "e.number"]).where("e.login", "=", login).where("e.kind", "in", MINE_KINDS))
    .unionAll(k.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id").select(["c.repo", "c.number"])
      .where("m.author", "=", login).where("m.kind", "=", "said").where("c.repo", "is not", null));
  const rows = await q.all(k.selectFrom(touched.as("t")).innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "t.repo").onRef("i.number", "=", "t.number"))
    .where((eb: any) => eb.or([eb("i.state", "=", "OPEN"), eb(eb.fn.coalesce("i.merged_at", "i.closed_at"), ">=", since)]))
    .select((eb: any) => ["t.repo", "t.number", eb.fn.coalesce(
      eb.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id").select(eb.fn.max("m.at").as("at"))
        .whereRef("c.repo", "=", "t.repo").whereRef("c.number", "=", "t.number"),
      eb.val(""),
    ).as("said"), eb.fn.coalesce(
      eb.selectFrom("main.workflow_events as e").select(eb.fn.max("e.at").as("at")).whereRef("e.repo", "=", "t.repo").whereRef("e.number", "=", "t.number").where("e.kind", "<>", "archived"),
      eb.val(""),
    ).as("did")])
    .groupBy(["t.repo", "t.number"]), { label: "chat.loadMineRefs" }) as { repo: string; number: number | string; said: string; did: string }[];
  return rows.map((r) => ({ ref: `${r.repo}#${Number(r.number)}`, at: r.said > r.did ? r.said : r.did }))
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.ref < b.ref ? -1 : 1)).map((r) => r.ref);
}

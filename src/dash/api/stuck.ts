// GET /api/stuck: the liveness check's stored result (src/liveness.ts), for staff.
import type { StuckItems } from "../../../web/src/api/types.ts";
import { storedLiveness } from "../../liveness.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos } from "./visible.ts";
import { waitFor } from "./reader.ts";
import { isHiddenRepo } from "../../hidden-sql.ts";
import { refIn } from "../../db/kx.ts";
import type { Db } from "../../db/index.ts";

export async function stuckItems(db: Db, req: Req): Promise<StuckItems> {
  if (!canSeeInternals(req)) return { checkedAt: null, open: 0, stuck: 0, long: 0, items: [] };
  const l = await storedLiveness(db);
  if (!l) return { checkedAt: null, open: 0, stuck: 0, long: 0, items: [] };
  const hidden = await hiddenRepos(db, req);
  const shown = l.items.filter((i) => !isHiddenRepo(hidden, i.repo));
  const titles = new Map((shown.length ? await db.all(db.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.title"]).where(refIn(db, "i", shown.map((i) => [i.repo, i.number] as const)))) : [])
    .map((r) => [`${r.repo}#${r.number}`, r.title]));
  const items = shown.map((i) => ({ ...i, wait: waitFor({ hidden }, i.wait), title: titles.get(`${i.repo}#${i.number}`) ?? null }));
  return { checkedAt: l.checkedAt, open: l.open, stuck: items.filter((i) => i.verdict === "stuck").length, long: items.filter((i) => i.verdict === "long").length, items };
}
